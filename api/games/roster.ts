/**
 * The host confirms who was there: a second source for attendance beside
 * the phone's check-in. Once check-in has closed, the host (or a co-host)
 * marks each player who held a spot as here or not here, starting from
 * what the check-ins say. That is the confirmation; for an hour after the
 * first one the host may confirm again to fix a mistake, then it is final
 * and each answer is written to the public record (presence,
 * web3/record/writer.ts).
 *
 * It covers every joined seat at check-in close, so a host can say a player
 * was there whose phone failed, or was not there though their phone checked
 * in. Neither source overrides the other: the record keeps both, and the
 * receipt shows where they disagree.
 *
 * Rules: after check-in closes, within CONFIRM_WITHIN_MS of it, for an
 * uncancelled game; host and co-hosts only (roles.ts "result"); every
 * player answered at once.
 */

import { LockMode } from "@mikro-orm/core";
import type { EntityManager } from "@mikro-orm/postgresql";
import type { Game } from "../entities/Game.js";
import { GameParticipant } from "../entities/GameParticipant.js";
import { RosterCheck } from "../entities/RosterCheck.js";
import type { User } from "../entities/User.js";
import { fail, type Failure } from "../failure.js";
import { checkInClosesAt, checkInWindow } from "./checkin.js";
import { CORRECTION_WINDOW_MS } from "./results.js";
import { mayUse, roleOf } from "./roles.js";

/** How long after check-in closes the host may first confirm the roster. */
export const CONFIRM_WITHIN_MS = 24 * 3600_000;

// ── the rule (pure) ──────────────────────────────────────────────────────

/**
 * Whether the roster can be confirmed (or confirmed again) now: after
 * check-in closes; a first confirmation within CONFIRM_WITHIN_MS of that,
 * a correction within CORRECTION_WINDOW_MS of the first.
 */
export function canConfirm(closesAt: Date, firstConfirmedAt: Date | null | undefined, now = Date.now()): boolean {
  if (now < closesAt.getTime()) return false;
  if (firstConfirmedAt) return now < firstConfirmedAt.getTime() + CORRECTION_WINDOW_MS;
  return now < closesAt.getTime() + CONFIRM_WITHIN_MS;
}

/** When a confirmed roster stops being correctable; null before any confirmation. */
export function rosterFinalAt(firstConfirmedAt: Date | null | undefined): Date | null {
  return firstConfirmedAt ? new Date(firstConfirmedAt.getTime() + CORRECTION_WINDOW_MS) : null;
}

// ── action ───────────────────────────────────────────────────────────────

/** `present` maps each joined player's user id to true (here) or false (not here). */
export async function confirmRoster(
  em: EntityManager,
  game: Game,
  actor: User,
  body: { present?: unknown },
): Promise<{ ok: true } | Failure> {
  const raw = body.present;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("VALIDATION_ERROR", "Say who was here: { present: { userId: true | false } }.");
  if (!mayUse(await roleOf(em, game, actor.id), "result")) return fail("NOT_HOST", "The host confirms who was here.");
  if (game.status === "cancelled") return fail("GAME_CLOSED", "This game was cancelled.");
  if (checkInWindow(game) !== "closed") return fail("ROSTER_NOT_YET", "You can confirm who was here once check-in closes.");

  return em.transactional(async (tx) => {
    const existing = await tx.findOne(RosterCheck, { game }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    if (!canConfirm(checkInClosesAt(game), existing?.firstConfirmedAt)) {
      return fail("ROSTER_FINAL", existing ? "Who was here is final." : "It's too late to confirm who was here.");
    }
    const seats = await tx.find(GameParticipant, { game, status: "joined" });
    const answers = raw as Record<string, unknown>;
    const missing = seats.filter((p) => typeof answers[p.user.id] !== "boolean");
    if (missing.length) return fail("VALIDATION_ERROR", "Mark every player as here or not here.");
    for (const p of seats) p.hostPresent = answers[p.user.id] as boolean;

    const now = new Date();
    let check = existing;
    if (!check) {
      check = new RosterCheck();
      check.game = game;
      check.firstConfirmedAt = now;
      tx.persist(check);
    }
    check.confirmedBy = actor;
    check.confirmedAt = now;
    await tx.flush();
    return { ok: true as const };
  });
}

// ── view ─────────────────────────────────────────────────────────────────

/**
 * The roster section of the result sheet: every player who held a spot,
 * what their phone said and what the host said, and whether the viewer may
 * confirm. Null before check-in closes. Names go to signed-in game viewers
 * only, like the rest of the sheet.
 */
export async function rosterView(em: EntityManager, game: Game, viewerId?: string) {
  if (checkInWindow(game) !== "closed" || game.status === "cancelled") return null;
  const check = await em.findOne(RosterCheck, { game }, { populate: ["confirmedBy"] });
  const runs = viewerId ? mayUse(await roleOf(em, game, viewerId), "result") : false;
  const seats = await em.find(GameParticipant, { game, status: "joined" }, { populate: ["user"], orderBy: { checkedInAt: "ASC" } });
  const finalAt = rosterFinalAt(check?.firstConfirmedAt);
  const open = canConfirm(checkInClosesAt(game), check?.firstConfirmedAt);
  return {
    players: seats.map((p) => ({
      id: p.user.id,
      name: p.user.name ?? null,
      checkedIn: Boolean(p.checkedInAt),
      /** The host's answer; null until confirmed. */
      hostPresent: check ? p.hostPresent ?? null : null,
    })),
    confirmedAt: check?.confirmedAt.toISOString() ?? null,
    confirmedBy: check?.confirmedBy ? { id: check.confirmedBy.id, name: check.confirmedBy.name ?? null } : null,
    /** Until when the host may confirm again to fix a mistake; null before a confirmation or once final. */
    correctUntil: check && open ? finalAt?.toISOString() ?? null : null,
    /** Until when the host may first confirm; null once confirmed. */
    confirmBy: check ? null : new Date(checkInClosesAt(game).getTime() + CONFIRM_WITHIN_MS).toISOString(),
    canConfirm: runs && open && seats.length > 0,
  };
}
