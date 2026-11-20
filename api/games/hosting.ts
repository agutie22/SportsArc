/**
 * What the host and co-hosts do to a game after creating it: edit it, remove
 * a player, name co-hosts. The result is recorded in results.ts.
 */

import { LockMode } from "@mikro-orm/core";
import type { EntityManager } from "@mikro-orm/postgresql";
import { Game } from "../entities/Game.js";
import { GameParticipant } from "../entities/GameParticipant.js";
import type { User } from "../entities/User.js";
import { Venue } from "../entities/Venue.js";
import { fail, type Failure } from "../failure.js";
import { notify } from "../social/notifications.js";
import { num } from "../validate.js";
import { buildVenue, type VenueInput } from "./venues.js";
// Read-only: an event's terms carry its start time, signed by the host, so
// the time of a game with event terms no longer changes.
import { EventTerms } from "../web3/events/EventTerms.js";
import { checkInWindow } from "./checkin.js";
import { MAX_CAPACITY, promoteWaitlist } from "./lifecycle.js";
import { mayUse, roleOf, timeEditBlocked } from "./roles.js";

export interface EditGameInput {
  startsAt?: unknown;
  durationMinutes?: unknown;
  capacity?: unknown;
  venueId?: unknown;
  venue?: VenueInput;
  notes?: unknown;
}

/**
 * Edit the time, place, size or notes, until check-in opens. A capacity
 * below the number already joined is refused (nobody is dropped); a larger
 * one promotes the waitlist. Time is fixed once an event's terms exist.
 * Joined players are notified of any change.
 */
export async function editGame(
  em: EntityManager,
  game: Game,
  user: User,
  body: EditGameInput,
): Promise<{ ok: true; changed: string[] } | Failure> {
  if (!mayUse(await roleOf(em, game, user.id), "edit")) {
    return fail("NOT_HOST", "Only the host or a co-host can edit this game.");
  }
  if (game.status === "cancelled" || game.status === "played") return fail("GAME_CLOSED", "This game is closed.");
  if (checkInWindow(game) !== "early") {
    return fail("CHECKIN_STARTED", "Check-in has opened; the game's details are fixed.");
  }

  const changed: string[] = [];
  let startsAt: Date | null = null;
  if (body.startsAt !== undefined) {
    const raw = typeof body.startsAt === "string" ? body.startsAt : "";
    const d = new Date(raw);
    if (!raw || Number.isNaN(d.getTime())) return fail("VALIDATION_ERROR", "Game needs a valid start time.");
    if (d.getTime() < Date.now()) return fail("VALIDATION_ERROR", "Start time is in the past.");
    if (d.getTime() !== game.startsAt.getTime()) { startsAt = d; changed.push("time"); }
  }
  let duration: number | null = null;
  if (body.durationMinutes !== undefined) {
    const n = Math.trunc(num(body.durationMinutes) ?? NaN);
    if (!(n >= 10 && n <= 600)) return fail("VALIDATION_ERROR", "Duration must be between 10 and 600 minutes.");
    if (n !== game.durationMinutes) { duration = n; if (!changed.includes("time")) changed.push("time"); }
  }
  let capacity: number | null = null;
  if (body.capacity !== undefined) {
    const n = Math.trunc(num(body.capacity) ?? NaN);
    if (!(n >= 2 && n <= MAX_CAPACITY)) {
      return fail("VALIDATION_ERROR", `Capacity must be between 2 and ${MAX_CAPACITY}.`);
    }
    if (n !== game.capacity) { capacity = n; changed.push("capacity"); }
  }
  let venue: Venue | null = null;
  let newVenue = false;
  if (typeof body.venueId === "string" && body.venueId.trim()) {
    venue = await em.findOne(Venue, { id: body.venueId.trim() });
    if (!venue) return fail("VENUE_NOT_FOUND", "That venue does not exist.");
    if (venue.id === game.venue.id) venue = null;
  } else if (body.venue) {
    const built = buildVenue(body.venue, user);
    if ("ok" in built) return built;
    venue = built;
    newVenue = true;
  }
  if (venue) changed.push("place");
  let notes: string | null | undefined;
  if (body.notes !== undefined) {
    notes = typeof body.notes === "string" ? body.notes.trim().slice(0, 500) || null : null;
    if (notes === (game.notes ?? null)) notes = undefined;
    else changed.push("notes");
  }
  if (!changed.length) return { ok: true, changed };

  const moneyTerms = await em.count(EventTerms, { game });
  if (timeEditBlocked(changed, moneyTerms > 0)) {
    return fail("TERMS_FIXED", "This event's terms were signed with its start time, so the time can no longer change.");
  }

  const out = await em.transactional(async (tx) => {
    const g = await tx.findOneOrFail(Game, { id: game.id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    if (capacity !== null) {
      const joined = await tx.count(GameParticipant, { game: g, status: "joined" });
      if (capacity < joined) {
        return fail("CAPACITY_BELOW_JOINED", `${joined} players have joined; capacity cannot go below that.`);
      }
      g.capacity = capacity;
    }
    if (startsAt) g.startsAt = startsAt;
    if (duration !== null) g.durationMinutes = duration;
    if (venue) {
      if (newVenue) { tx.persist(venue); g.venue = venue; }
      else g.venue = tx.getReference(Venue, venue.id);
    }
    if (notes !== undefined) g.notes = notes;
    await promoteWaitlist(tx, g);
    await tx.flush();
    return { ok: true as const };
  });
  if (!out.ok) return out;
  await em.refresh(game, { populate: ["venue", "host"] });

  // "Details changed" to everyone joined except whoever made the change.
  const joined = await em.find(GameParticipant, { game, status: "joined" });
  for (const p of joined) await notify(em, { recipient: p.user.id, actor: user, kind: "game_changed", game });
  return { ok: true, changed };
}

/**
 * Remove a player (joined or waitlisted) until check-in opens. Nobody removes
 * the host; only the host removes a co-host; nobody removes themselves (that
 * is leaving). The removed player is notified and cannot rejoin.
 */
export async function removePlayer(
  em: EntityManager,
  game: Game,
  user: User,
  body: { userId?: unknown },
): Promise<{ ok: true } | Failure> {
  const role = await roleOf(em, game, user.id);
  if (!mayUse(role, "remove")) return fail("NOT_HOST", "Only the host or a co-host can remove a player.");
  const targetId = typeof body.userId === "string" ? body.userId : "";
  if (!targetId) return fail("VALIDATION_ERROR", "Say which player to remove.");
  if (targetId === user.id) return fail("VALIDATION_ERROR", "Leave the game instead of removing yourself.");
  if (targetId === game.host.id) return fail("NOT_HOST", "Nobody can remove the host.");
  // An entry is paid for and on chain; only its player can give it up.
  if (game.kind === "event") return fail("EVENT_GAME", "Players who entered a paid event cannot be removed.");
  if (game.status === "cancelled" || game.status === "played") return fail("GAME_CLOSED", "This game is closed.");
  if (checkInWindow(game) !== "early") {
    return fail("CHECKIN_STARTED", "Check-in has opened; players can no longer be removed.");
  }

  const out = await em.transactional(async (tx) => {
    const g = await tx.findOneOrFail(Game, { id: game.id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    const seat = await tx.findOne(GameParticipant, { game: g, user: targetId });
    if (!seat || (seat.status !== "joined" && seat.status !== "waitlist")) {
      return fail("NOT_JOINED", "That person is not in this game.");
    }
    if (seat.cohost && role !== "host") return fail("NOT_HOST", "Only the host can remove a co-host.");
    const wasJoined = seat.status === "joined";
    seat.status = "cancelled";
    seat.cohost = false;
    seat.removedAt = new Date();
    if (wasJoined) await promoteWaitlist(tx, g);
    await tx.flush();
    return { ok: true as const };
  });
  if (out.ok) {
    await em.refresh(game);
    await notify(em, { recipient: targetId, actor: user, kind: "game_removed", game });
  }
  return out;
}

/** The host names or removes a co-host: someone with a joined seat. */
export async function setCohost(
  em: EntityManager,
  game: Game,
  user: User,
  body: { userId?: unknown; cohost?: unknown },
): Promise<{ ok: true } | Failure> {
  if (!mayUse(await roleOf(em, game, user.id), "cohosts")) {
    return fail("NOT_HOST", "Only the host can name or remove co-hosts.");
  }
  const targetId = typeof body.userId === "string" ? body.userId : "";
  if (!targetId) return fail("VALIDATION_ERROR", "Say who to name.");
  if (typeof body.cohost !== "boolean") return fail("VALIDATION_ERROR", "cohost must be true or false.");
  if (targetId === game.host.id) return fail("VALIDATION_ERROR", "The host is already the host.");
  if (game.status === "cancelled") return fail("GAME_CLOSED", "This game was cancelled.");
  const seat = await em.findOne(GameParticipant, { game, user: targetId });
  if (!seat || seat.status !== "joined") {
    return fail("NOT_JOINED", "Co-hosts are named from the players in the game.");
  }
  const named = body.cohost && !seat.cohost;
  seat.cohost = body.cohost;
  await em.flush();
  if (named) await notify(em, { recipient: targetId, actor: user, kind: "cohost_named", game });
  return { ok: true };
}
