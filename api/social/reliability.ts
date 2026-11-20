/**
 * How often someone shows up. Counted games are ones they still held a
 * seat in when check-in closed, and that were not cancelled. Leaving, or
 * being removed, before then drops the seat, so it is not counted. Showing
 * up means either source says they were there: their phone checked in, or
 * the host confirmed them as here (games/roster.ts). Either is enough, so
 * a phone that failed at the court does not cost the player. Under 3
 * counted games the profile says "New" instead of a rate.
 *
 * The score is derived here and never written on chain. Each counted game
 * can be written on chain (checkin or noshow); that list's completeness still
 * depends on this server.
 */

import type { EntityManager } from "@mikro-orm/postgresql";
import type { Game } from "../entities/Game.js";
import { GameParticipant } from "../entities/GameParticipant.js";
import { checkInWindow } from "../games/checkin.js";

/** Fewer than this and the profile says "New". */
export const RELIABILITY_MIN_GAMES = 3;

export interface Reliability {
  games: number;
  showed: number;
  /** "New" until there are RELIABILITY_MIN_GAMES counted games. */
  label: "New" | null;
}

/** The show-up rule: the phone checked in, or the host confirmed them as here. */
export function showedUp(seat: { checkedInAt?: Date | null; hostPresent?: boolean | null }): boolean {
  return Boolean(seat.checkedInAt) || seat.hostPresent === true;
}

export function reliabilityView(games: number, showed: number): Reliability {
  return {
    games,
    showed,
    label: games < RELIABILITY_MIN_GAMES ? "New" : null,
  };
}

export async function reliabilityOf(em: EntityManager, userId: string): Promise<Reliability> {
  return (await reliabilityOfMany(em, [userId]))[userId];
}

/** The same count for several people at once (a game's players), keyed by user id. */
export async function reliabilityOfMany(em: EntityManager, userIds: string[]): Promise<Record<string, Reliability>> {
  const seats = userIds.length === 0 ? [] : await em.find(
    GameParticipant,
    { user: { $in: userIds }, status: "joined", game: { status: { $ne: "cancelled" } } },
    { populate: ["game"] },
  );
  const tally = new Map(userIds.map((id) => [id, { games: 0, showed: 0 }]));
  for (const s of seats) {
    const t = tally.get(s.user.id);
    if (!t || checkInWindow(s.game) !== "closed") continue;
    t.games += 1;
    if (showedUp(s)) t.showed += 1;
  }
  return Object.fromEntries([...tally].map(([id, t]) => [id, reliabilityView(t.games, t.showed)]));
}

/** Every joined player of a game, for the host's player list. */
export async function gameReliability(em: EntityManager, game: Game): Promise<Record<string, Reliability>> {
  const seats = await em.find(GameParticipant, { game, status: "joined" });
  return reliabilityOfMany(em, seats.map((s) => s.user.id));
}
