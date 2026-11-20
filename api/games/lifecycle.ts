/**
 * Pickup games: create, join, leave, cancel, and the waitlist.
 * The core loop — results build on this. Global rankings do not exist yet.
 *
 * Roles live in roles.ts, the host's other actions in hosting.ts, check-in
 * in checkin.ts, read shapes in views.ts and the result in results.ts.
 *
 * A game of kind "event" is created here like any other, but its seats are
 * paid for: entering, leaving and cancelling one go through web3/events,
 * which moves the money with them. Join, leave and cancel here refuse it.
 */

import { LockMode } from "@mikro-orm/core";
import type { EntityManager } from "@mikro-orm/postgresql";
import { Game, isGameKind, isGameVisibility, isSkillLevel, isSport } from "../entities/Game.js";
import { GameParticipant } from "../entities/GameParticipant.js";
import { GameResult } from "../entities/GameResult.js";
import { Post } from "../entities/Post.js";
import type { User } from "../entities/User.js";
import { Venue } from "../entities/Venue.js";
import { fail, type Failure } from "../failure.js";
import { notify } from "../social/notifications.js";
import { num } from "../validate.js";
import { buildVenue, type VenueInput } from "./venues.js";
import { checkInWindow } from "./checkin.js";
import { cancelAllowed, mayUse, roleOf } from "./roles.js";

export const MAX_CAPACITY = 100;

export interface CreateGameInput {
  sport?: unknown;
  venueId?: unknown;
  venue?: VenueInput;
  startsAt?: unknown;
  durationMinutes?: unknown;
  capacity?: unknown;
  skillLevel?: unknown;
  visibility?: unknown;
  notes?: unknown;
  /** "I'm playing". Defaults to true. */
  hostPlays?: unknown;
  /** "pickup" (the default) or "event". */
  kind?: unknown;
}

/** What join, leave and cancel answer for an event: those go through web3/events. */
const eventOnly = (what: string) => fail("EVENT_GAME", `This is a paid event: ${what} from the event itself.`);

export async function createGame(
  em: EntityManager,
  host: User,
  body: CreateGameInput,
): Promise<{ ok: true; game: Game } | Failure> {
  const sport = typeof body.sport === "string" ? body.sport.trim().toLowerCase() : "";
  if (!isSport(sport)) return fail("VALIDATION_ERROR", "Pick a valid sport.");

  const startsAtRaw = typeof body.startsAt === "string" ? body.startsAt : "";
  const startsAt = new Date(startsAtRaw);
  if (!startsAtRaw || Number.isNaN(startsAt.getTime())) {
    return fail("VALIDATION_ERROR", "Game needs a valid start time.");
  }
  if (startsAt.getTime() < Date.now()) {
    return fail("VALIDATION_ERROR", "Start time is in the past.");
  }

  const capacity = Math.trunc(num(body.capacity) ?? 10);
  if (capacity < 2 || capacity > MAX_CAPACITY) {
    return fail("VALIDATION_ERROR", `Capacity must be between 2 and ${MAX_CAPACITY}.`);
  }

  const duration = Math.trunc(num(body.durationMinutes) ?? 90);
  if (duration < 10 || duration > 600) {
    return fail("VALIDATION_ERROR", "Duration must be between 10 and 600 minutes.");
  }

  const skillLevel = typeof body.skillLevel === "string" ? body.skillLevel.trim() : "any";
  if (!isSkillLevel(skillLevel)) return fail("VALIDATION_ERROR", "Unknown skill level.");

  const visibility = typeof body.visibility === "string" ? body.visibility.trim() : "public";
  if (!isGameVisibility(visibility)) return fail("VALIDATION_ERROR", "Unknown visibility.");

  const kind = typeof body.kind === "string" ? body.kind.trim() : "pickup";
  if (!isGameKind(kind)) return fail("VALIDATION_ERROR", "Unknown kind of game.");
  // League fixtures come only from a season's schedule (api/leagues).
  if (kind === "league") return fail("VALIDATION_ERROR", "League games are made by the league's schedule.");
  // Events move money, so they are adults-only, host included.
  if (kind === "event" && host.audience !== "adult" && host.audience !== "guardian") {
    return fail("NOT_ELIGIBLE", "Only adults and guardians can host a paid event.");
  }

  // Either reference an existing venue or create one inline.
  let venue: Venue | null = null;
  if (typeof body.venueId === "string" && body.venueId.trim()) {
    venue = await em.findOne(Venue, { id: body.venueId.trim() });
    if (!venue) return fail("VENUE_NOT_FOUND", "That venue does not exist.");
  } else if (body.venue) {
    const built = buildVenue(body.venue, host);
    if ("ok" in built) return built;
    venue = built;
    em.persist(venue);
  } else {
    return fail("VALIDATION_ERROR", "Provide a venueId or a venue to create.");
  }

  const game = new Game();
  game.host = host;
  // An event's host has no free seat: they enter like anyone else.
  game.hostPlays = kind === "event" ? false : body.hostPlays !== false;
  game.venue = venue;
  game.sport = sport;
  game.kind = kind;
  game.startsAt = startsAt;
  game.durationMinutes = duration;
  game.capacity = capacity;
  game.skillLevel = skillLevel;
  game.visibility = visibility;
  game.notes = typeof body.notes === "string" ? body.notes.trim().slice(0, 500) || null : null;
  em.persist(game);

  // A host who plays occupies a slot; one who does not has no seat.
  if (game.hostPlays) {
    const hostSeat = new GameParticipant();
    hostSeat.game = game;
    hostSeat.user = host;
    hostSeat.status = "joined";
    em.persist(hostSeat);
  }

  // Announce it in the feed. Inlined rather than calling into social.ts,
  // which imports toPublicGame from views.ts — the cycle is avoidable.
  const announcement = new Post();
  announcement.author = host;
  announcement.kind = "system";
  announcement.game = game;
  announcement.body = kind === "event"
    ? `is hosting a ${game.sport} event at ${venue.name}.`
    : `is hosting ${game.sport} at ${venue.name}.`;
  em.persist(announcement);

  await em.flush();
  return { ok: true, game };
}

export async function findGame(em: EntityManager, id: string): Promise<Game | null> {
  if (!id) return null;
  return em.findOne(Game, { id }, { populate: ["venue", "host"] });
}

/**
 * Join a game. Runs in a transaction because capacity is checked and consumed
 * in the same step — two people grabbing the last slot must not both win.
 * The game row is locked (FOR UPDATE, and re-read) before counting, so joins
 * on the same game serialize across API instances too.
 */
export async function joinGame(
  em: EntityManager,
  game: Game,
  user: User,
): Promise<{ ok: true; status: "joined" | "waitlist" } | Failure> {
  if (game.kind === "event") return eventOnly("enter it");
  if (game.kind === "league") return fail("LEAGUE_GAME", "This is a league game: its two teams play it. Join a team to play.");
  if (game.status === "cancelled") return fail("GAME_CLOSED", "This game was cancelled.");
  if (game.status === "played") return fail("GAME_CLOSED", "This game already happened.");
  if (game.startsAt.getTime() < Date.now()) return fail("GAME_CLOSED", "This game has already started.");

  const result = await em.transactional(async (tx) => {
    await tx.findOneOrFail(Game, { id: game.id }, { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true });
    const existing = await tx.findOne(GameParticipant, { game, user });
    if (existing && (existing.status === "joined" || existing.status === "waitlist")) {
      return { ok: true as const, status: existing.status, isNew: false };
    }
    if (existing?.removedAt) return fail("REMOVED", "The host removed you from this game.");

    const joined = await tx.count(GameParticipant, { game, status: "joined" });
    const status = joined >= game.capacity ? ("waitlist" as const) : ("joined" as const);

    if (existing) {
      existing.status = status;
      existing.joinedAt = new Date();
    } else {
      const seat = new GameParticipant();
      seat.game = game;
      seat.user = user;
      seat.status = status;
      tx.persist(seat);
    }

    if (status === "joined" && joined + 1 >= game.capacity) {
      game.status = "full";
    }
    await tx.flush();
    return { ok: true as const, status, isNew: true };
  });
  if (!result.ok) return result;
  if (result.isNew && result.status === "joined") {
    await notify(em, { recipient: game.host.id, actor: user, kind: "join", game });
  }
  return { ok: true, status: result.status };
}

/**
 * Leave a game, promoting the longest-waiting person off the waitlist. The
 * host may give up their seat and stay host; a co-host who leaves stops
 * being one. Leaving a joined seat tells the host. Leaving the waitlist
 * does not, since joining it never did.
 */
export async function leaveGame(
  em: EntityManager,
  game: Game,
  user: User,
): Promise<{ ok: true } | Failure> {
  if (game.kind === "event") return eventOnly("leave it");
  // Once the game is under way the roster is on the record: leaving then
  // would erase a no-show or an attendance (both written on chain).
  if (checkInWindow(game) === "closed" || (await em.count(GameResult, { game }))) {
    return fail("GAME_CLOSED", "This game has started; you can no longer leave it.");
  }

  const result = await em.transactional(async (tx) => {
    const seat = await tx.findOne(GameParticipant, { game, user });
    if (!seat || seat.status === "cancelled") {
      return fail("NOT_JOINED", "You are not in this game.");
    }

    const wasJoined = seat.status === "joined";
    seat.status = "cancelled";
    seat.cohost = false;
    if (wasJoined) await promoteWaitlist(tx, game);
    await tx.flush();
    return { ok: true as const, wasJoined };
  });
  if (!result.ok) return result;
  if (result.wasJoined) {
    await notify(em, { recipient: game.host.id, actor: user, kind: "left", game });
  }
  return { ok: true };
}

/** Fill free slots from the waitlist, oldest first, and set open/full. */
export async function promoteWaitlist(tx: EntityManager, game: Game): Promise<GameParticipant[]> {
  await tx.flush();
  let joined = await tx.count(GameParticipant, { game, status: "joined" });
  const promoted: GameParticipant[] = [];
  if (joined < game.capacity) {
    const waiting = await tx.find(
      GameParticipant,
      { game, status: "waitlist" },
      { orderBy: { joinedAt: "ASC" }, limit: game.capacity - joined },
    );
    for (const w of waiting) { w.status = "joined"; promoted.push(w); joined++; }
  }
  if (game.status === "open" || game.status === "full") {
    game.status = joined >= game.capacity ? "full" : "open";
  }
  return promoted;
}

/**
 * Cancel: the host or a co-host, until check-in opens; after that only while
 * nobody has checked in, and never once the sides have locked.
 */
export async function cancelGame(
  em: EntityManager,
  game: Game,
  user: User,
): Promise<{ ok: true } | Failure> {
  if (game.kind === "event") return eventOnly("cancel it");
  if (!mayUse(await roleOf(em, game, user.id), "cancel")) {
    return fail("NOT_HOST", "Only the host or a co-host can cancel this game.");
  }
  if (game.status === "cancelled") return { ok: true };
  // Once sides lock the game is on the record; cancelling would erase a result.
  if (await em.count(GameResult, { game })) {
    return fail("RESULT_LOCKED", "This game has started; it can no longer be cancelled.");
  }
  const checkedIn = await em.count(GameParticipant, { game, status: "joined", checkedInAt: { $ne: null } });
  if (!cancelAllowed(checkInWindow(game), checkedIn)) {
    return fail("CHECKIN_STARTED", "Players have checked in; the game can no longer be cancelled.");
  }
  game.status = "cancelled";
  await em.flush();
  return { ok: true };
}
