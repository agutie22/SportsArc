/**
 * Read side of games: the public game shape (what the viewer may do included)
 * and the lists built from it.
 */

import { wrap } from "@mikro-orm/core";
import type { EntityManager } from "@mikro-orm/postgresql";
import { Game, isSkillLevel, isSport } from "../entities/Game.js";
import { GameParticipant } from "../entities/GameParticipant.js";
import { GameResult } from "../entities/GameResult.js";
import type { User } from "../entities/User.js";
import { Venue } from "../entities/Venue.js";
import { DEFAULT_RADIUS_KM, MAX_RADIUS_KM, boundingBox, haversineKm, round1, validLat, validLng } from "../geo.js";
import { isUuid, num } from "../validate.js";
import { toPublicVenue } from "./venues.js";
import { checkInClosesAt, checkInOpensAt, checkInWindow } from "./checkin.js";
import { cancelAllowed, mayUse, roleFrom } from "./roles.js";

export async function toPublicGame(em: EntityManager, game: Game, viewerId?: string) {
  const [pub] = await toPublicGames(em, [game], viewerId);
  return pub;
}

/**
 * Many games in the public shape at once, in the order given: one query for
 * every game's players, one for their hosts and one for which of the
 * viewer's own games already have a result, however long the list.
 */
export async function toPublicGames(em: EntityManager, games: Game[], viewerId?: string) {
  if (games.length === 0) return [];
  const ids = games.map((g) => g.id);
  const rows = await em.find(
    GameParticipant,
    { game: { $in: ids }, status: { $in: ["joined", "waitlist"] } },
    { populate: ["user"], orderBy: { joinedAt: "ASC" } },
  );
  const byGame = new Map<string, GameParticipant[]>();
  for (const p of rows) {
    const list = byGame.get(p.game.id);
    if (list) list.push(p); else byGame.set(p.game.id, [p]);
  }
  const unloaded = games.filter((g) => !wrap(g.host).isInitialized());
  if (unloaded.length) await em.populate(unloaded, ["host"]);

  const roleOf = (g: Game) => {
    const cohostIds = new Set((byGame.get(g.id) ?? [])
      .filter((p) => p.status === "joined" && p.cohost).map((p) => p.user.id));
    return roleFrom(g.host.id, cohostIds, viewerId);
  };
  // Only a game the viewer runs needs to know (its Cancel depends on it).
  const runs = games.filter((g) => roleOf(g)).map((g) => g.id);
  const resulted = runs.length
    ? new Set((await em.find(GameResult, { game: { $in: runs } }, { fields: ["game"] })).map((r) => r.game.id))
    : new Set<string>();

  return games.map((g) => publicShape(g, byGame.get(g.id) ?? [], viewerId, resulted.has(g.id)));
}

/** One game's public shape from its seats already loaded (see toPublicGames). */
function publicShape(game: Game, participants: GameParticipant[], viewerId: string | undefined, hasResult: boolean) {
  const joined = participants.filter((p) => p.status === "joined");
  const waitlist = participants.filter((p) => p.status === "waitlist");
  const mine = viewerId ? participants.find((p) => p.user.id === viewerId) : undefined;
  const window = checkInWindow(game);
  const cohostIds = new Set(joined.filter((p) => p.cohost).map((p) => p.user.id));
  const viewerRole = roleFrom(game.host.id, cohostIds, viewerId);
  const checkedIn = joined.filter((p) => p.checkedInAt);
  const rolesOf = (id: string) => [
    ...(id === game.host.id ? ["host"] : []),
    ...(cohostIds.has(id) ? ["cohost"] : []),
  ];

  const live = game.status !== "cancelled" && game.status !== "played";
  const can = {
    edit: live && mayUse(viewerRole, "edit") && window === "early",
    cancel: live && mayUse(viewerRole, "cancel") && !hasResult && cancelAllowed(window, checkedIn.length),
    remove: live && mayUse(viewerRole, "remove") && window === "early",
    cohosts: live && mayUse(viewerRole, "cohosts"),
  };

  return {
    id: game.id,
    sport: game.sport,
    kind: game.kind,
    startsAt: game.startsAt.toISOString(),
    durationMinutes: game.durationMinutes,
    capacity: game.capacity,
    skillLevel: game.skillLevel,
    visibility: game.visibility,
    status: game.status,
    notes: game.notes ?? null,
    venue: toPublicVenue(game.venue),
    /** Who created the game and runs it. */
    host: { id: game.host.id, name: game.host.name ?? null },
    hostPlays: game.hostPlays,
    cohosts: joined.filter((p) => p.cohost).map((p) => ({ id: p.user.id, name: p.user.name ?? null })),
    joinedCount: joined.length,
    spotsLeft: Math.max(0, game.capacity - joined.length),
    waitlistCount: waitlist.length,
    viewerStatus: mine?.status ?? null,
    viewerCheckedIn: Boolean(mine?.checkedInAt),
    isHost: viewerId ? game.host.id === viewerId : false,
    viewerRole,
    can,
    checkInWindow: window,
    checkInOpensAt: checkInOpensAt(game).toISOString(),
    checkInClosesAt: checkInClosesAt(game).toISOString(),
    /** 1 for first in line; null unless the viewer is on the waitlist. */
    viewerWaitlistPosition: mine?.status === "waitlist" ? waitlist.indexOf(mine) + 1 : null,
    checkedInCount: joined.filter((p) => p.checkedInAt).length,
    players: joined.map((p) => ({
      id: p.user.id,
      name: p.user.name ?? null,
      role: p.user.role ?? null,
      checkedIn: Boolean(p.checkedInAt),
      roles: rolesOf(p.user.id),
    })),
  };
}

export interface ListGamesOpts {
  lat?: unknown;
  lng?: unknown;
  radiusKm?: unknown;
  sport?: unknown;
  skillLevel?: unknown;
  /** One venue's games only (the venue sheet). */
  venueId?: unknown;
  limit?: unknown;
}

export async function listGames(em: EntityManager, opts: ListGamesOpts, viewerId?: string) {
  // Full games stay listed: others can join the waitlist, and the people in
  // them (a host without a seat included) reach them from here.
  const where: Record<string, unknown> = {
    status: { $in: ["open", "full"] },
    visibility: "public",
    startsAt: { $gte: new Date() },
  };

  const sport = typeof opts.sport === "string" ? opts.sport.trim().toLowerCase() : "";
  if (sport && isSport(sport)) where.sport = sport;

  const skill = typeof opts.skillLevel === "string" ? opts.skillLevel.trim() : "";
  if (skill && isSkillLevel(skill) && skill !== "any") where.skillLevel = { $in: [skill, "any"] };

  if (opts.venueId !== undefined) {
    if (typeof opts.venueId !== "string" || !isUuid(opts.venueId)) return [];
    where.venue = opts.venueId;
  }

  const lat = validLat(opts.lat);
  const lng = validLng(opts.lng);
  const radius = Math.min(num(opts.radiusKm) ?? DEFAULT_RADIUS_KM, MAX_RADIUS_KM);
  const limit = Math.min(Math.trunc(num(opts.limit) ?? 50), 100);

  if (lat !== null && lng !== null) {
    const venues = await em.find(Venue, boundingBox(lat, lng, radius), { limit: 500 });
    const near = venues.filter((v) => haversineKm(lat, lng, v.lat, v.lng) <= radius);
    const ids = near.map((v) => v.id).filter((id) => where.venue === undefined || id === where.venue);
    if (ids.length === 0) return [];
    where.venue = { $in: ids };
  }

  const games = await em.find(Game, where, {
    populate: ["venue", "host"],
    orderBy: { startsAt: "ASC" },
    limit,
  });

  const pubs = await toPublicGames(em, games, viewerId);
  if (lat === null || lng === null) return pubs;
  return pubs.map((pub, i) => ({
    ...pub, distanceKm: round1(haversineKm(lat, lng, games[i].venue.lat, games[i].venue.lng)),
  }));
}

/**
 * Upcoming games the viewer is in or hosting, soonest first. A host need not
 * hold a seat, so hosted games are looked up on their own. `limit` defaults
 * to 10 and is capped at 50.
 */
export async function listMyGames(em: EntityManager, user: User, limit: unknown = 10) {
  const cap = Math.min(Math.max(Math.trunc(num(limit) ?? 10), 1), 50);
  const seats = await em.find(
    GameParticipant,
    { user, status: { $in: ["joined", "waitlist"] } },
    { populate: ["game", "game.venue", "game.host"] },
  );
  const now = Date.now();
  const hosted = await em.find(
    Game,
    { host: user, status: { $ne: "cancelled" }, startsAt: { $gt: new Date(now - 3 * 3600_000) } },
    { populate: ["venue", "host"] },
  );
  const byId = new Map([...seats.map((s) => s.game), ...hosted].map((g) => [g.id, g]));
  const games = [...byId.values()]
    .filter((g) => g.status !== "cancelled" && g.startsAt.getTime() > now - 3 * 3600_000)
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
    .slice(0, cap);
  return toPublicGames(em, games, user.id);
}

/**
 * "Host again": the games the viewer hosted, newest first, one per venue
 * and sport, as the details a new game copies (cancelled ones
 * included, since the plan was still theirs). The client picks the next date.
 */
export async function listHostAgain(em: EntityManager, user: User, limit = 4) {
  const games = await em.find(
    Game,
    { host: user },
    { populate: ["venue"], orderBy: { startsAt: "DESC" }, limit: 40 },
  );
  const seen = new Set<string>();
  const out = [];
  for (const g of games) {
    const key = `${g.venue.id}|${g.sport}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      gameId: g.id,
      sport: g.sport,
      venue: toPublicVenue(g.venue),
      startsAt: g.startsAt.toISOString(),
      durationMinutes: g.durationMinutes,
      capacity: g.capacity,
      skillLevel: g.skillLevel,
      notes: g.notes ?? null,
      hostPlays: g.hostPlays,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** What an open result needs from the viewer, its host: to record it. */
export type ResultNeed = "record";

/**
 * Games drop off this list once they are this old, so a result nobody
 * recorded does not sit on the page forever.
 */
const OPEN_RESULT_LOOKBACK_DAYS = 14;

/**
 * Games the viewer hosts or co-hosts whose sides have locked and whose
 * result nobody has recorded yet. listMyGames stops 3 hours after the
 * start; this runs for two weeks.
 */
export async function listOpenResults(em: EntityManager, user: User) {
  const since = new Date(Date.now() - OPEN_RESULT_LOOKBACK_DAYS * 86_400_000);
  const cohosted = await em.find(
    GameParticipant,
    { user, status: "joined", cohost: true, game: { startsAt: { $gt: since } } },
    { fields: ["game"] },
  );
  const open = await em.find(
    GameResult,
    {
      status: { $ne: "settled" },
      game: {
        status: { $ne: "cancelled" },
        startsAt: { $gt: since },
        $or: [{ host: user }, { id: { $in: cohosted.map((p) => p.game.id) } }],
      },
    },
    { populate: ["game", "game.venue", "game.host"] },
  );
  const games = open.map((r) => r.game).sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime());
  return (await toPublicGames(em, games, user.id)).map((g) => ({ ...g, resultNeed: "record" as ResultNeed }));
}
