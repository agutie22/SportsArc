/**
 * Check-in: the time window and the geofence. Fixes who played, which is
 * what the record, the recap and the show-up rate count.
 */

import type { EntityManager } from "@mikro-orm/postgresql";
import type { Game } from "../entities/Game.js";
import { GameParticipant } from "../entities/GameParticipant.js";
import type { User } from "../entities/User.js";
import { fail, type Failure } from "../failure.js";
import { haversineKm, validLat, validLng } from "../geo.js";

/**
 * Check-in window. Who played is fixed shortly after tip-off rather than at
 * the final whistle, so the roster never depends on how the game went. The
 * grace period exists because people arrive late; it is deliberately far
 * shorter than a game.
 */
const CHECKIN_OPENS_MIN_BEFORE = 60;
const CHECKIN_GRACE_MIN_AFTER = 15;
/** Parks and complexes are large, and phone GPS drifts. */
const CHECKIN_RADIUS_M = 250;

/** The same three numbers for the client (GET /api/meta), so its copy never drifts. */
export const CHECKIN_RULES = {
  opensMinBefore: CHECKIN_OPENS_MIN_BEFORE,
  graceMinAfter: CHECKIN_GRACE_MIN_AFTER,
  radiusM: CHECKIN_RADIUS_M,
} as const;

/** When check-in opens. */
export function checkInOpensAt(game: Game): Date {
  return new Date(game.startsAt.getTime() - CHECKIN_OPENS_MIN_BEFORE * 60_000);
}

export type CheckInWindow = "early" | "open" | "closed";

/** When check-in closes; sides lock here at the latest. */
export function checkInClosesAt(game: Game): Date {
  return new Date(game.startsAt.getTime() + CHECKIN_GRACE_MIN_AFTER * 60_000);
}

export function checkInWindow(game: Game, now = Date.now()): CheckInWindow {
  const start = game.startsAt.getTime();
  if (now < start - CHECKIN_OPENS_MIN_BEFORE * 60_000) return "early";
  if (now > checkInClosesAt(game).getTime()) return "closed";
  return "open";
}

/**
 * Check in at the venue. Geofenced and time-boxed so the roster that will
 * later attest to the result is fixed before anyone knows the result.
 */
export async function checkInToGame(
  em: EntityManager,
  game: Game,
  user: User,
  coords: { lat?: unknown; lng?: unknown },
): Promise<{ ok: true; checkedInAt: string; distanceM: number } | Failure> {
  if (game.status === "cancelled") return fail("GAME_CLOSED", "This game was cancelled.");

  const lat = validLat(coords.lat);
  const lng = validLng(coords.lng);
  if (lat === null || lng === null) {
    return fail("VALIDATION_ERROR", "Check-in needs your current lat and lng.");
  }

  const window = checkInWindow(game);
  if (window === "early") {
    return fail("CHECKIN_NOT_OPEN", "Check-in opens an hour before the game.");
  }
  if (window === "closed") {
    return fail("CHECKIN_CLOSED", "Check-in for this game has closed.");
  }

  const seat = await em.findOne(GameParticipant, { game, user });
  if (!seat || seat.status !== "joined") {
    return fail("NOT_JOINED", "Only players in the game can check in.");
  }
  if (seat.checkedInAt) {
    return {
      ok: true,
      checkedInAt: seat.checkedInAt.toISOString(),
      distanceM: 0,
    };
  }

  const distanceM = Math.round(haversineKm(lat, lng, game.venue.lat, game.venue.lng) * 1000);
  if (distanceM > CHECKIN_RADIUS_M) {
    return fail(
      "TOO_FAR",
      `You need to be at the venue to check in (you are about ${distanceM} m away).`,
    );
  }

  seat.checkedInAt = new Date();
  await em.flush();
  return { ok: true, checkedInAt: seat.checkedInAt.toISOString(), distanceM };
}
