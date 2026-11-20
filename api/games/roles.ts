/**
 * Host roles. Whoever creates a game is its host for good: the role is never
 * handed over or voted on. The host chooses whether they play, and names
 * co-hosts from the players in the game to help run it. Host and co-hosts
 * edit the time, place or size and remove a player until check-in opens,
 * cancel until check-in opens (then only while nobody has checked in), and
 * run the result: set sides, start, record (results.ts). Only the host names
 * co-hosts. Every power check goes through mayUse().
 *
 * A league fixture's host is the staff member who made the schedule; the
 * rest of the league org's staff act as co-hosts on it (roleOf), so any of
 * them can run the game and record its result.
 */

import type { EntityManager } from "@mikro-orm/postgresql";
import type { Game } from "../entities/Game.js";
import { GameParticipant } from "../entities/GameParticipant.js";
import type { CheckInWindow } from "./checkin.js";
import { Season } from "../leagues/Season.js";
import { mayOrg, orgRole } from "../orgs/roles.js";

export type HostRole = "host" | "cohost" | null;
export type HostPower = "edit" | "cancel" | "remove" | "cohosts" | "result";

/** Co-hosts hold the host's powers except naming co-hosts. */
export function mayUse(role: HostRole, power: HostPower): boolean {
  if (role === "host") return true;
  if (role === "cohost") return power !== "cohosts";
  return false;
}

/**
 * A change to the time (start or duration) is refused once the game has
 * event terms: the host signed the start time into them.
 */
export function timeEditBlocked(changed: readonly string[], hasMoneyTerms: boolean): boolean {
  return hasMoneyTerms && changed.includes("time");
}

/** Until check-in opens; after that only while nobody has checked in. */
export function cancelAllowed(window: CheckInWindow, checkedInCount: number): boolean {
  return window === "early" || checkedInCount === 0;
}

export function roleFrom(hostId: string, cohostIds: Set<string>, userId?: string): HostRole {
  if (!userId) return null;
  if (hostId === userId) return "host";
  return cohostIds.has(userId) ? "cohost" : null;
}

export async function roleOf(em: EntityManager, game: Game, userId: string): Promise<HostRole> {
  if (game.host.id === userId) return "host";
  const seat = await em.findOne(GameParticipant, { game, user: userId, status: "joined", cohost: true });
  if (seat) return "cohost";
  if (game.season) {
    const season = await em.findOne(Season, { id: game.season.id }, { populate: ["league"] });
    if (season && mayOrg(await orgRole(em, userId, season.league.org.id), "run")) return "cohost";
  }
  return null;
}
