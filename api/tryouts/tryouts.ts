/**
 * Tryouts: a club org runs one on top of a paid event (Tryout.ts).
 *
 *   create      the club's staff link an upcoming paid event hosted by the
 *               club's signer, so entry fees go to the club's wallet; the
 *               club must be verified (it takes money)
 *   invite      from a league season's standings (the top teams' players)
 *               or one person at a time; each gets a notification
 *   consent     before registering a player agrees to show their verified
 *               record to the club's staff; registering itself is the
 *               event's own entry (web3/events), adults only
 *   scout board the club's staff see each registrant: invited or not, and,
 *               with consent, their verified record (games, show-up,
 *               league seasons, where they play most)
 *   camp        the staff invite up to `campSpots` registrants to camp
 *
 * Public: the tryout's page (what, when, the fee, how many are in). Names
 * of registrants and camp invites only reach the club's staff and the
 * player themselves.
 */

import type { EntityManager } from "@mikro-orm/postgresql";
import { fail, type Failure } from "../failure.js";
import { isUuid } from "../validate.js";
import { Game } from "../entities/Game.js";
import { GameParticipant } from "../entities/GameParticipant.js";
import { User } from "../entities/User.js";
import { notify } from "../social/notifications.js";
import { reliabilityOfMany } from "../social/reliability.js";
import { findOrg, personOf } from "../orgs/orgs.js";
import { mayOrg, orgRole, requireOrg, verifiedGate } from "../orgs/roles.js";
import { Season } from "../leagues/Season.js";
import { TeamMember } from "../leagues/TeamMember.js";
import { seasonView } from "../leagues/leagues.js";
import { RecordEntry } from "../web3/record/RecordEntry.js";
import { seasonsOf } from "../web3/record/record.js";
import { eventRegistrants, eventSummary } from "../web3/events/events.js";
import { Tryout } from "./Tryout.js";
import { TryoutMark, type TryoutMarkKind } from "./TryoutMark.js";

const gone = (): Failure => fail("TRYOUT_NOT_FOUND", "That tryout does not exist.");

/** By tryout id, or by its event's game id (notifications carry the game). */
async function loadTryout(em: EntityManager, ref: string): Promise<Tryout | null> {
  if (!isUuid(ref)) return null;
  return em.findOne(Tryout, { $or: [{ id: ref }, { game: ref }] }, { populate: ["org", "game", "game.venue", "game.host"] });
}

const staffOf = async (em: EntityManager, userId: string | undefined, t: Tryout) => mayOrg(await orgRole(em, userId, t.org.id), "run");

async function mark(em: EntityManager, t: Tryout, user: User, kind: TryoutMarkKind, by: User | null, season: Season | null = null) {
  const existing = await em.findOne(TryoutMark, { tryout: t, user, kind });
  if (existing) return { mark: existing, fresh: false };
  const m = new TryoutMark();
  m.tryout = t;
  m.user = user;
  m.kind = kind;
  m.by = by;
  m.season = season;
  em.persist(m);
  return { mark: m, fresh: true };
}

// ── create ────────────────────────────────────────────────────────────

export async function createTryout(em: EntityManager, user: User, orgRef: string, body: { gameId?: unknown; name?: unknown; campSpots?: unknown }) {
  const org = await findOrg(em, orgRef);
  if (!org) return fail("ORG_NOT_FOUND", "That organization does not exist.");
  const denied = await requireOrg(em, user.id, org.id, "run");
  if (denied) return denied;
  if (org.kind !== "club") return fail("ORG_KIND", "Tryouts are run by a club.");
  const unverified = verifiedGate(org, "money");
  if (unverified) return unverified;
  const name = typeof body.name === "string" ? body.name.trim().replace(/\s+/g, " ").slice(0, 120) : "";
  if (name.length < 2) return fail("VALIDATION_ERROR", "Give the tryout a name.");
  const spots = Math.trunc(Number(body.campSpots ?? 3));
  if (!Number.isFinite(spots) || spots < 1 || spots > 50) return fail("VALIDATION_ERROR", "Camp spots run from 1 to 50.");
  const game = typeof body.gameId === "string" && isUuid(body.gameId) ? await em.findOne(Game, { id: body.gameId }, { populate: ["host"] }) : null;
  if (!game) return fail("GAME_NOT_FOUND", "That game does not exist.");
  if (game.kind !== "event") return fail("NOT_EVENT", "A tryout is a paid event: host one, then make it the tryout.");
  if (game.status === "cancelled" || game.startsAt.getTime() < Date.now()) return fail("GAME_CLOSED", "Pick an event that is still ahead.");
  if (!org.signer || game.host.id !== org.signer.id) {
    return fail("NOT_ORG_SIGNER", "The tryout event must be hosted by the club's signer, so its entry fees go to the club's wallet.");
  }
  if (await em.count(Tryout, { game })) return fail("ALREADY_TRYOUT", "That event is already a tryout.");
  const t = new Tryout();
  t.org = org;
  t.game = game;
  t.name = name;
  t.campSpots = spots;
  t.createdBy = user;
  await em.persistAndFlush(t);
  return { ok: true as const, tryout: { id: t.id } };
}

/** A club's tryouts, upcoming first. Public. */
export async function orgTryouts(em: EntityManager, orgRef: string) {
  const org = await findOrg(em, orgRef);
  if (!org) return fail("ORG_NOT_FOUND", "That organization does not exist.");
  const rows = await em.find(Tryout, { org }, { populate: ["game", "game.venue"], orderBy: { game: { startsAt: "DESC" } } });
  return {
    ok: true as const,
    tryouts: rows.map((t) => ({
      id: t.id, name: t.name, startsAt: t.game.startsAt.toISOString(), venue: t.game.venue.name, status: t.game.status,
    })),
  };
}

// ── reading ───────────────────────────────────────────────────────────

export async function tryoutView(em: EntityManager, ref: string, viewer?: User) {
  const t = await loadTryout(em, ref);
  if (!t) return gone();
  const staff = await staffOf(em, viewer?.id, t);
  const mine = viewer ? await em.find(TryoutMark, { tryout: t, user: viewer }, { populate: ["season", "season.league"] }) : [];
  const invited = mine.find((m) => m.kind === "invited");
  const registered = viewer ? (await eventRegistrants(em, t.game)).some((u) => u.id === viewer.id) : false;
  const camp = await em.count(TryoutMark, { tryout: t, kind: "camp" });
  return {
    ok: true as const,
    tryout: {
      id: t.id,
      name: t.name,
      campSpots: t.campSpots,
      campInvited: camp,
      org: { id: t.org.id, slug: t.org.slug, name: t.org.name, verified: Boolean(t.org.verifiedAt) },
      game: { id: t.game.id, startsAt: t.game.startsAt.toISOString(), status: t.game.status, venue: { id: t.game.venue.id, name: t.game.venue.name, address: t.game.venue.address ?? null } },
      event: await eventSummary(em, t.game),
      viewer: {
        staff,
        invited: invited ? { from: invited.season ? `${invited.season.league.name} · ${invited.season.name}` : null } : null,
        consented: mine.some((m) => m.kind === "consent"),
        registered,
        camp: mine.some((m) => m.kind === "camp"),
      },
    },
  };
}

// ── invites ───────────────────────────────────────────────────────────

async function sendInvite(em: EntityManager, t: Tryout, user: User, by: User, season: Season | null) {
  const { fresh } = await mark(em, t, user, "invited", by, season);
  await em.flush();
  if (fresh) {
    await notify(em, { recipient: user, actor: by, kind: "tryout_invite", game: t.game, detail: `${t.org.name} · ${t.name}`.slice(0, 120) });
  }
  return fresh;
}

/** Invite the players of a league season's top `teams` teams (by standings). */
export async function inviteFromSeason(em: EntityManager, user: User, ref: string, body: { seasonId?: unknown; teams?: unknown }) {
  const t = await loadTryout(em, ref);
  if (!t) return gone();
  const denied = await requireOrg(em, user.id, t.org.id, "run");
  if (denied) return denied;
  const seasonId = typeof body.seasonId === "string" ? body.seasonId : "";
  const view = await seasonView(em, seasonId);
  if (!view.ok) return view;
  const top = Math.min(Math.max(Math.trunc(Number(body.teams ?? 2)) || 2, 1), 16);
  const teamIds = view.season.standings.filter((r) => r.place <= top).map((r) => r.team);
  const season = await em.findOneOrFail(Season, { id: view.season.id });
  const members = teamIds.length ? await em.find(TeamMember, { team: { $in: teamIds } }, { populate: ["user"] }) : [];
  let sent = 0;
  for (const m of members) {
    // League play is adults only already; paid events are too.
    if (await sendInvite(em, t, m.user, user, season)) sent += 1;
  }
  return { ok: true as const, invited: sent, teams: teamIds.length, players: members.length };
}

export async function invitePlayer(em: EntityManager, user: User, ref: string, body: { userId?: unknown }) {
  const t = await loadTryout(em, ref);
  if (!t) return gone();
  const denied = await requireOrg(em, user.id, t.org.id, "run");
  if (denied) return denied;
  const player = typeof body.userId === "string" && isUuid(body.userId) ? await em.findOne(User, { id: body.userId }) : null;
  if (!player) return fail("USER_NOT_FOUND", "That person is not on SportsArc.");
  if (player.audience !== "adult" && player.audience !== "guardian") return fail("ADULTS_ONLY", "Tryouts are for adults.");
  await sendInvite(em, t, player, user, null);
  return { ok: true as const };
}

/** The player agrees to show their verified record to the club's staff. */
export async function giveConsent(em: EntityManager, user: User, ref: string) {
  const t = await loadTryout(em, ref);
  if (!t) return gone();
  if (user.audience !== "adult" && user.audience !== "guardian") return fail("ADULTS_ONLY", "Tryouts are for adults.");
  await mark(em, t, user, "consent", user);
  await em.flush();
  return { ok: true as const };
}

// ── scout board and camp ──────────────────────────────────────────────

export async function scoutBoard(em: EntityManager, user: User, ref: string) {
  const t = await loadTryout(em, ref);
  if (!t) return gone();
  const denied = await requireOrg(em, user.id, t.org.id, "run");
  if (denied) return denied;
  const registrants = await eventRegistrants(em, t.game);
  const invitedMarks = await em.find(TryoutMark, { tryout: t, kind: "invited" }, { populate: ["user", "season", "season.league"] });
  const marks = await em.find(TryoutMark, { tryout: t, kind: { $in: ["consent", "camp"] } });
  const has = (uid: string, kind: TryoutMarkKind) => marks.some((m) => m.user.id === uid && m.kind === kind);
  const ids = registrants.map((u) => u.id);
  const reliability = ids.length ? await reliabilityOfMany(em, ids) : {};
  const seats = ids.length ? await em.find(GameParticipant, { game: t.game, user: { $in: ids } }) : [];

  const rows = [];
  for (const u of registrants) {
    const consent = has(u.id, "consent");
    const invite = invitedMarks.find((m) => m.user.id === u.id);
    const seat = seats.find((s) => s.user.id === u.id);
    rows.push({
      person: personOf(u),
      invitedFrom: invite ? (invite.season ? `${invite.season.league.name} · ${invite.season.name}` : "Invited") : null,
      checkedIn: Boolean(seat?.checkedInAt),
      camp: has(u.id, "camp"),
      consent,
      record: consent ? await recordSummary(em, u, reliability[u.id]) : null,
    });
  }
  rows.sort((a, b) => Number(b.camp) - Number(a.camp) || Number(Boolean(b.invitedFrom)) - Number(Boolean(a.invitedFrom))
    || (b.record?.verifiedGames ?? 0) - (a.record?.verifiedGames ?? 0));
  return {
    ok: true as const,
    board: {
      registrants: rows,
      invited: invitedMarks.map((m) => ({ person: personOf(m.user), from: m.season ? `${m.season.league.name} · ${m.season.name}` : null })),
      campSpots: t.campSpots,
    },
  };
}

/** A registrant's verified record in a few numbers, for the scout board. */
async function recordSummary(em: EntityManager, user: User, reliability?: { games: number; showed: number }) {
  const rows = await em.find(
    RecordEntry,
    { participant: { user }, status: "confirmed", kind: { $in: ["checkin", "noshow"] } },
    { populate: ["game", "game.venue"] },
  );
  const checkins = rows.filter((r) => r.kind === "checkin");
  const venues = new Map<string, { name: string; n: number }>();
  for (const r of checkins) {
    if (!r.game) continue;
    const v = venues.get(r.game.venue.id) ?? { name: r.game.venue.name, n: 0 };
    v.n += 1;
    venues.set(r.game.venue.id, v);
  }
  const most = [...venues.values()].sort((a, b) => b.n - a.n)[0] ?? null;
  const seasons = await seasonsOf(em, user);
  return {
    verifiedGames: checkins.length,
    onRecord: rows.length,
    showUp: reliability && reliability.games ? { showed: reliability.showed, games: reliability.games } : null,
    mostAt: most ? { venue: most.name, games: most.n } : null,
    seasons: seasons.map((x) => ({
      league: x.league, season: x.season, team: x.team?.name ?? null, place: x.standing?.place ?? null, teams: x.teams,
      wins: x.standing?.wins ?? null, losses: x.standing?.losses ?? null,
    })),
    recordPath: `#/record/${user.id}`,
  };
}

/** Invite a registrant to camp, or take it back (`invite: false`). */
export async function setCamp(em: EntityManager, user: User, ref: string, body: { userId?: unknown; invite?: unknown }) {
  const t = await loadTryout(em, ref);
  if (!t) return gone();
  const denied = await requireOrg(em, user.id, t.org.id, "run");
  if (denied) return denied;
  const id = typeof body.userId === "string" ? body.userId : "";
  const player = (await eventRegistrants(em, t.game)).find((u) => u.id === id);
  if (!player) return fail("NOT_REGISTERED", "Only a registrant can be invited to camp.");
  if (body.invite === false) {
    const m = await em.findOne(TryoutMark, { tryout: t, user: player, kind: "camp" });
    if (m) await em.removeAndFlush(m);
    return { ok: true as const };
  }
  if (await em.count(TryoutMark, { tryout: t, kind: "camp" }) >= t.campSpots) {
    return fail("CAMP_FULL", `All ${t.campSpots} camp spots are taken.`);
  }
  const { fresh } = await mark(em, t, player, "camp", user);
  await em.flush();
  if (fresh) await notify(em, { recipient: player, actor: user, kind: "camp_invite", game: t.game, detail: `${t.org.name} · ${t.name}`.slice(0, 120) });
  return { ok: true as const };
}

/** Funnel counts for a tryout (insights): invited, registered, checked in, camp. */
export async function tryoutFunnel(em: EntityManager, t: Tryout) {
  const registrants = await eventRegistrants(em, t.game);
  const ids = registrants.map((u) => u.id);
  const checkedIn = ids.length ? await em.count(GameParticipant, { game: t.game, user: { $in: ids }, checkedInAt: { $ne: null } }) : 0;
  return {
    invited: await em.count(TryoutMark, { tryout: t, kind: "invited" }),
    registered: ids.length,
    checkedIn,
    camp: await em.count(TryoutMark, { tryout: t, kind: "camp" }),
  };
}

