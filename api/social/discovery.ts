/**
 * Discovery built from the verified activity record — check-ins, not
 * claims. Three surfaces:
 *
 *  - Venue regulars: a leaderboard per venue of verified check-ins over the
 *    last 90 days. Small, local ladders are ones a newcomer can actually
 *    climb, which is the point (see Strava's segment leaderboards).
 *  - Played with: people you were checked in alongside, to follow.
 *  - Profile views: who has been looking at you.
 *  - A game's roster, as someone deciding whether to join sees it: who
 *    they have played with, the venue's top regulars, and which players
 *    are coaches or scouts (adults only, the same rule as profile views).
 *
 * Profile views follow the minors rules' direction of risk. Every view is recorded,
 * but the owner is only ever shown the *names* of adult coaches and scouts —
 * the recruiting signal. Players are shown as counts, and a minor's view is
 * never attributed to them anywhere, so the feature cannot be used to see
 * which kids are looking at whom.
 */

import type { EntityManager } from "@mikro-orm/postgresql";
import type { Game } from "../entities/Game.js";
import { GameParticipant } from "../entities/GameParticipant.js";
import { Follow } from "../entities/Follow.js";
import { ProfileView } from "../entities/ProfileView.js";
import { User } from "../entities/User.js";
import { Venue } from "../entities/Venue.js";
import { notify } from "./notifications.js";
import { reliabilityOfMany, type Reliability } from "./reliability.js";

const REGULARS_WINDOW_DAYS = 90;
const VIEWS_WINDOW_DAYS = 30;

const person = (u: User) => ({
  id: u.id,
  name: u.name ?? null,
  role: u.role ?? null,
  avatarUrl: u.avatarUrl ?? null,
  headline: u.headline ?? null,
});

// ── venue regulars ────────────────────────────────────────────────────

interface Standing { user: User; checkIns: number; lastAt: Date }

/** Full standings for one venue, best first. Ties go to whoever got there first. */
async function standings(em: EntityManager, venueId: string): Promise<Standing[]> {
  const since = new Date(Date.now() - REGULARS_WINDOW_DAYS * 86_400_000);
  const seats = await em.find(
    GameParticipant,
    { status: "joined", checkedInAt: { $gte: since }, game: { venue: venueId, status: { $ne: "cancelled" } } },
    { populate: ["user"] },
  );
  const by = new Map<string, Standing>();
  for (const s of seats) {
    const at = s.checkedInAt!;
    const row = by.get(s.user.id);
    if (row) {
      row.checkIns += 1;
      if (at > row.lastAt) row.lastAt = at;
    } else {
      by.set(s.user.id, { user: s.user, checkIns: 1, lastAt: at });
    }
  }
  return [...by.values()].sort((a, b) => b.checkIns - a.checkIns || a.lastAt.getTime() - b.lastAt.getTime());
}

export async function venueRegulars(em: EntityManager, venueId: string, viewer?: User) {
  const venue = await em.findOne(Venue, { id: venueId });
  if (!venue) return null;
  const table = await standings(em, venueId);
  const mine = viewer ? table.findIndex((r) => r.user.id === viewer.id) : -1;

  // The nudge that makes a small ladder work: how far to the next rung.
  let next: { id: string; name: string | null; gap: number } | null = null;
  if (mine > 0) {
    const ahead = table[mine - 1];
    next = {
      id: ahead.user.id,
      name: ahead.user.name ?? null,
      gap: ahead.checkIns - table[mine].checkIns + 1,
    };
  }

  return {
    venue: { id: venue.id, name: venue.name, kind: venue.kind, address: venue.address ?? null },
    windowDays: REGULARS_WINDOW_DAYS,
    regulars: table.slice(0, 10).map((r, i) => ({
      rank: i + 1,
      checkIns: r.checkIns,
      user: person(r.user),
    })),
    viewer: mine >= 0 ? { rank: mine + 1, next } : null,
  };
}

/** Where someone ranks at each venue they have played, best rank first. */
export async function userVenueRanks(em: EntityManager, userId: string) {
  const since = new Date(Date.now() - REGULARS_WINDOW_DAYS * 86_400_000);
  const seats = await em.find(
    GameParticipant,
    { user: userId, status: "joined", checkedInAt: { $gte: since } },
    { populate: ["game", "game.venue"] },
  );
  const venues = new Map<string, Venue>();
  for (const s of seats) venues.set(s.game.venue.id, s.game.venue);

  const out = [];
  for (const v of venues.values()) {
    const table = await standings(em, v.id);
    const i = table.findIndex((r) => r.user.id === userId);
    if (i < 0) continue;
    out.push({
      venue: { id: v.id, name: v.name },
      rank: i + 1,
      of: table.length,
      checkIns: table[i].checkIns,
    });
  }
  return out.sort((a, b) => a.rank - b.rank || b.checkIns - a.checkIns);
}

export async function venueRankFor(em: EntityManager, venueId: string, userId: string) {
  const table = await standings(em, venueId);
  const i = table.findIndex((r) => r.user.id === userId);
  return i < 0 ? null : { rank: i + 1, of: table.length };
}

// ── played with ───────────────────────────────────────────────────────

/** People checked in to the same games as you, most shared games first. */
export async function playedWith(em: EntityManager, viewer: User, limit = 12) {
  const mine = await em.find(GameParticipant, { user: viewer, status: "joined", checkedInAt: { $ne: null } });
  if (mine.length === 0) return [];
  const gameIds = mine.map((s) => s.game.id);

  const others = await em.find(
    GameParticipant,
    { game: { $in: gameIds }, user: { $ne: viewer.id }, status: "joined", checkedInAt: { $ne: null } },
    { populate: ["user", "game"] },
  );
  const by = new Map<string, { user: User; games: number; lastAt: Date }>();
  for (const s of others) {
    const at = s.game.startsAt;
    const row = by.get(s.user.id);
    if (row) {
      row.games += 1;
      if (at > row.lastAt) row.lastAt = at;
    } else {
      by.set(s.user.id, { user: s.user, games: 1, lastAt: at });
    }
  }

  const follows = await em.find(Follow, { follower: viewer, followee: { $in: [...by.keys()] } });
  const followed = new Set(follows.map((f) => f.followee.id));

  return [...by.values()]
    .sort((a, b) => b.games - a.games || b.lastAt.getTime() - a.lastAt.getTime())
    .slice(0, limit)
    .map((r) => ({
      ...person(r.user),
      primarySport: r.user.primarySport ?? null,
      school: r.user.school ?? null,
      sharedGames: r.games,
      lastPlayedAt: r.lastAt.toISOString(),
      isFollowing: followed.has(r.user.id),
    }));
}

// ── profile views ─────────────────────────────────────────────────────

const RECRUITERS = new Set(["coach", "scout"]);

/** Only an adult coach or scout is ever named to the profile's owner. */
const nameable = (u: Pick<User, "role" | "audience">) => RECRUITERS.has(u.role ?? "") && u.audience !== "minor";

/**
 * The recruiter tag a game's roster may carry: an adult coach or scout,
 * with their school. Everyone else, and every minor, gets null.
 */
export function recruiterTag(u: Pick<User, "role" | "audience" | "school">) {
  return nameable(u) ? { role: u.role as "coach" | "scout", school: u.school ?? null } : null;
}

/** Only the top of a venue's ladder is called out on a roster. */
const ROSTER_TOP_REGULARS = 3;

export interface RosterEntry {
  reliability: Reliability;
  /** Games the viewer and this player both checked in to. */
  sharedGames: number;
  /** Rank among this venue's regulars, when in the top three. */
  venueRank: number | null;
  recruiter: ReturnType<typeof recruiterTag>;
}

/** What a viewer deciding whether to join sees beside each joined player, keyed by user id. */
export async function gameRoster(em: EntityManager, game: Game, viewer: User): Promise<Record<string, RosterEntry>> {
  const seats = await em.find(GameParticipant, { game, status: "joined" }, { populate: ["user"] });
  const ids = seats.map((s) => s.user.id);
  if (ids.length === 0) return {};

  const [reliability, table, mine] = await Promise.all([
    reliabilityOfMany(em, ids),
    standings(em, game.venue.id),
    em.find(GameParticipant, { user: viewer, status: "joined", checkedInAt: { $ne: null } }),
  ]);

  const shared = new Map<string, number>();
  if (mine.length) {
    const together = await em.find(GameParticipant, {
      game: { $in: mine.map((s) => s.game.id) },
      user: { $in: ids.filter((id) => id !== viewer.id) },
      status: "joined",
      checkedInAt: { $ne: null },
    });
    for (const s of together) shared.set(s.user.id, (shared.get(s.user.id) ?? 0) + 1);
  }

  const rank = new Map(table.slice(0, ROSTER_TOP_REGULARS).map((r, i) => [r.user.id, i + 1]));
  return Object.fromEntries(seats.map((s) => [s.user.id, {
    reliability: reliability[s.user.id],
    sharedGames: shared.get(s.user.id) ?? 0,
    venueRank: rank.get(s.user.id) ?? null,
    recruiter: recruiterTag(s.user),
  }]));
}

export async function recordProfileView(em: EntityManager, viewer: User, viewedId: string): Promise<void> {
  if (viewer.id === viewedId) return;
  const day = new Date().toISOString().slice(0, 10);
  const exists = await em.count(ProfileView, { viewer, viewed: viewedId, day });
  if (exists) return;
  const v = new ProfileView();
  v.viewer = viewer;
  v.viewed = em.getReference(User, viewedId);
  v.day = day;
  try {
    await em.persistAndFlush(v);
  } catch {
    return; // lost a race with a concurrent view on the same day; one row is enough
  }
  if (nameable(viewer)) await notify(em, { recipient: viewedId, actor: viewer, kind: "view" });
}

export async function profileViewSummary(em: EntityManager, owner: User) {
  const since = new Date(Date.now() - VIEWS_WINDOW_DAYS * 86_400_000);
  const rows = await em.find(
    ProfileView,
    { viewed: owner, createdAt: { $gte: since } },
    { populate: ["viewer"], orderBy: { createdAt: "DESC" } },
  );

  const unique = new Map<string, { viewer: User; at: Date }>();
  for (const r of rows) if (!unique.has(r.viewer.id)) unique.set(r.viewer.id, { viewer: r.viewer, at: r.createdAt });

  // Minors are counted under "other", never under their role: "2 scouts"
  // next to one named scout would point at the unnamed one.
  const byRole = { coach: 0, scout: 0, player: 0, other: 0 };
  for (const { viewer } of unique.values()) {
    const role = viewer.role as keyof typeof byRole;
    byRole[viewer.audience === "minor" || !(role in byRole) ? "other" : role] += 1;
  }

  return {
    windowDays: VIEWS_WINDOW_DAYS,
    total: unique.size,
    byRole,
    recruiters: [...unique.values()]
      .filter(({ viewer }) => nameable(viewer))
      .slice(0, 12)
      .map(({ viewer, at }) => ({ ...person(viewer), viewedAt: at.toISOString() })),
  };
}
