/**
 * Game results: the host runs them. Sides lock at the start, then the host
 * records who won.
 *
 * The host (or a co-host) puts checked-in players on side A or B. Sides
 * lock when the host taps start, or automatically when check-in closes; the
 * lock copies the roster into ResultSeat. After the lock the host records
 * the outcome (win, draw, or not played) and that is the result: players do
 * not record or vote. This assumes the host is honest. For an hour after
 * the first record the host may record again to fix a mistake; then it is
 * final. Recording results is part of the host's record.
 *
 * Every seat gets "result_settled" when the result is first recorded, sent
 * after the write commits, never inside it.
 */

import { LockMode } from "@mikro-orm/core";
import type { EntityManager } from "@mikro-orm/postgresql";
import { Game } from "../entities/Game.js";
import { GameParticipant } from "../entities/GameParticipant.js";
import { GameResult, isResultOutcome, type ResultStatus } from "../entities/GameResult.js";
import { ResultSeat } from "../entities/ResultSeat.js";
import type { User } from "../entities/User.js";
import { checkInClosesAt, checkInWindow } from "./checkin.js";
import { rosterView } from "./roster.js";
import { mayUse, roleOf } from "./roles.js";
import { notify } from "../social/notifications.js";
import { startJob } from "../ops/jobs.js";
import { fail, type Failure } from "../failure.js";

/** How long after the first record the host may still correct the result. */
export const CORRECTION_WINDOW_MS = 3600_000;
const MAX_SCORE = 999;

// ── the rule (pure) ──────────────────────────────────────────────────────

/**
 * Whether a result in this state can be recorded (or recorded again): any
 * time before it has settled, and for the correction window after it was
 * first recorded.
 */
export function canRecord(status: ResultStatus, firstRecordedAt: Date | null | undefined, now = Date.now()): boolean {
  if (status !== "settled") return true;
  return Boolean(firstRecordedAt) && now < firstRecordedAt!.getTime() + CORRECTION_WINDOW_MS;
}

/** When a settled result stops being correctable; null if it has not settled. */
export function correctUntil(status: ResultStatus, firstRecordedAt: Date | null | undefined): Date | null {
  return status === "settled" && firstRecordedAt ? new Date(firstRecordedAt.getTime() + CORRECTION_WINDOW_MS) : null;
}

/** Everyone seated hears that the result settled. */
export function settledRecipients(seats: { userId: string }[]): string[] {
  return seats.map((s) => s.userId);
}

// ── notifications ────────────────────────────────────────────────────────

async function seatsOf(em: EntityManager, resultId: string) {
  const result = await em.findOneOrFail(GameResult, { id: resultId }, { refresh: true });
  const seats = await em.find(ResultSeat, { result }, { populate: ["participant"] });
  return { result, seats: seats.map((s) => ({ userId: s.participant.user.id, side: s.side ?? null })) };
}

/** "Result settled" to every seat. Deduped per game, so a repeat call is harmless. */
async function notifySettled(em: EntityManager, resultId: string): Promise<void> {
  try {
    const { result, seats } = await seatsOf(em, resultId);
    if (result.status !== "settled") return;
    const game = em.getReference(Game, result.game.id);
    for (const id of settledRecipients(seats)) {
      await notify(em, { recipient: id, kind: "result_settled", game });
    }
  } catch (err) {
    console.warn("[results] settled notifications failed:", err instanceof Error ? err.message : err);
  }
}

// ── locking ──────────────────────────────────────────────────────────────

async function lockedGame(tx: EntityManager, game: Game): Promise<Game> {
  return tx.findOneOrFail(Game, { id: game.id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
}

/**
 * Copy everyone checked in by `lockedAt` into seats, with their current side.
 * A locked result puts the game on the record, so it is "played" from here:
 * joins, edits and cancelling close (`game` must be the row-locked copy).
 */
async function lockSides(tx: EntityManager, game: Game, lockedAt: Date, lockedBy: User | null): Promise<GameResult> {
  if (game.status === "open" || game.status === "full") game.status = "played";
  const roster = await tx.find(GameParticipant, {
    game,
    status: "joined",
    checkedInAt: { $ne: null, $lte: lockedAt },
  });
  const result = new GameResult();
  result.game = game;
  result.lockedAt = lockedAt;
  result.lockedBy = lockedBy;
  tx.persist(result);
  for (const p of roster) {
    const seat = new ResultSeat();
    seat.result = result;
    seat.participant = p;
    seat.side = p.side ?? null;
    tx.persist(seat);
  }
  await tx.flush();
  return result;
}

/**
 * The game's result row, creating it if check-in has closed and the host
 * never tapped start. Null while sides are still being set, for cancelled
 * games, and when nobody checked in.
 */
async function ensureLocked(em: EntityManager, game: Game): Promise<GameResult | null> {
  const existing = await em.findOne(GameResult, { game });
  if (existing) return existing;
  if (game.status === "cancelled" || checkInWindow(game) !== "closed") return null;

  const lockedAt = checkInClosesAt(game);
  const checkedIn = await em.count(GameParticipant, {
    game,
    status: "joined",
    checkedInAt: { $ne: null, $lte: lockedAt },
  });
  if (checkedIn === 0) return null;

  const id = await em.transactional(async (tx) => {
    const g = await lockedGame(tx, game);
    const again = await tx.findOne(GameResult, { game: g });
    return (again ?? (await lockSides(tx, g, lockedAt, null))).id;
  });
  return em.findOneOrFail(GameResult, { id });
}

/** Whether `user` runs this game's result: the host or a co-host. */
async function runsResult(em: EntityManager, game: Game, user: User): Promise<boolean> {
  return mayUse(await roleOf(em, game, user.id), "result");
}

// ── actions ──────────────────────────────────────────────────────────────

/**
 * The host puts a checked-in player on side 0 or 1, or back to none. Only
 * before the sides lock.
 */
export async function setSide(
  em: EntityManager,
  game: Game,
  actor: User,
  body: { side?: unknown; userId?: unknown },
): Promise<{ ok: true } | Failure> {
  const side = body.side === null ? null : body.side === 0 || body.side === 1 ? body.side : undefined;
  if (side === undefined) return fail("VALIDATION_ERROR", "Side must be 0, 1 or null.");
  const userId = typeof body.userId === "string" ? body.userId : "";
  if (!userId) return fail("VALIDATION_ERROR", "Say which player to move.");
  if (!(await runsResult(em, game, actor))) return fail("NOT_HOST", "The host sets the sides.");
  if (game.status === "cancelled") return fail("GAME_CLOSED", "This game was cancelled.");
  if (checkInWindow(game) === "closed") return fail("RESULT_LOCKED", "Sides are locked.");

  return em.transactional(async (tx) => {
    const g = await lockedGame(tx, game);
    if (await tx.count(GameResult, { game: g })) return fail("RESULT_LOCKED", "Sides are locked.");
    const seat = await tx.findOne(GameParticipant, { game: g, user: userId });
    if (!seat || seat.status !== "joined" || !seat.checkedInAt) {
      return fail("NOT_CHECKED_IN", "Only players who have checked in go on a side.");
    }
    seat.side = side;
    await tx.flush();
    return { ok: true as const };
  });
}

/**
 * Tap start: lock the sides now. The host does it once check-in is open
 * and both sides have someone. Starting twice is harmless.
 */
export async function startGame(
  em: EntityManager,
  game: Game,
  actor: User,
): Promise<{ ok: true } | Failure> {
  if (!(await runsResult(em, game, actor))) return fail("NOT_HOST", "The host starts the game.");
  if (game.status === "cancelled") return fail("GAME_CLOSED", "This game was cancelled.");
  const window = checkInWindow(game);
  if (window === "early") return fail("CHECKIN_NOT_OPEN", "Check-in opens an hour before the game.");
  if (window === "closed") return fail("RESULT_LOCKED", "Sides locked when check-in closed.");

  return em.transactional(async (tx) => {
    const g = await lockedGame(tx, game);
    if (await tx.count(GameResult, { game: g })) return { ok: true as const };
    const roster = await tx.find(GameParticipant, { game: g, status: "joined", checkedInAt: { $ne: null } });
    if (!roster.some((p) => p.side === 0) || !roster.some((p) => p.side === 1)) {
      return fail("SIDES_INCOMPLETE", "Both sides need at least one checked-in player.");
    }
    await lockSides(tx, g, new Date(), actor);
    return { ok: true as const };
  });
}

function parseScore(v: unknown): [number, number] | null | undefined {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v) || v.length !== 2) return undefined;
  const ok = v.every((n) => Number.isInteger(n) && n >= 0 && n <= MAX_SCORE);
  return ok ? [v[0], v[1]] : undefined;
}

/**
 * The host records the outcome, which settles it. A win or a draw needs
 * players on both sides; "not played" is always possible. Recording again
 * inside the correction window replaces what was recorded.
 */
export async function recordResult(
  em: EntityManager,
  game: Game,
  actor: User,
  body: { outcome?: unknown; winningSide?: unknown; score?: unknown },
): Promise<{ ok: true } | Failure> {
  const outcome = typeof body.outcome === "string" && isResultOutcome(body.outcome) ? body.outcome : null;
  if (!outcome) return fail("VALIDATION_ERROR", "Outcome must be win, draw or not_played.");
  const winningSide = outcome === "win" ? body.winningSide : null;
  if (outcome === "win" && winningSide !== 0 && winningSide !== 1) {
    return fail("VALIDATION_ERROR", "A win needs winningSide 0 or 1.");
  }
  const score = outcome === "not_played" ? null : parseScore(body.score);
  if (score === undefined) return fail("VALIDATION_ERROR", `Score must be two whole numbers from 0 to ${MAX_SCORE}.`);
  if (score && outcome === "draw" && score[0] !== score[1]) {
    return fail("VALIDATION_ERROR", "A draw needs a level score.");
  }
  if (score && outcome === "win" && score[winningSide as number] <= score[1 - (winningSide as number)]) {
    return fail("VALIDATION_ERROR", "The winning side needs the higher score.");
  }
  if (!(await runsResult(em, game, actor))) return fail("NOT_HOST", "The host records the result.");
  if (game.status === "cancelled") return fail("GAME_CLOSED", "This game was cancelled.");

  const current = await ensureLocked(em, game);
  if (!current) {
    return fail("RESULT_NOT_LOCKED", "Sides lock when you tap start or when check-in closes.");
  }

  const out = await em.transactional(async (tx) => {
    const result = await tx.findOneOrFail(GameResult, { id: current.id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    if (!canRecord(result.status, result.firstRecordedAt)) {
      return fail("RESULT_FINAL", "This result is final.");
    }
    if (outcome !== "not_played") {
      const seats = await tx.find(ResultSeat, { result });
      if (!seats.some((s) => s.side === 0) || !seats.some((s) => s.side === 1)) {
        return fail("SIDES_INCOMPLETE", "A win or draw needs players on both sides.");
      }
    }

    const now = new Date();
    // The correction window runs from the first record.
    if (result.status !== "settled") result.firstRecordedAt = now;
    result.status = "settled";
    result.outcome = outcome;
    result.winningSide = outcome === "win" ? (winningSide as number) : null;
    result.score0 = score ? score[0] : null;
    result.score1 = score ? score[1] : null;
    result.recordedBy = actor;
    result.recordedAt = now;
    await tx.flush();
    return { ok: true as const };
  });
  if (out.ok) await notifySettled(em, current.id);
  return out;
}

// ── background sweep ─────────────────────────────────────────────────────

/** Games older than this are never auto-locked by the sweep. */
const SWEEP_LOOKBACK_MS = 3 * 86_400_000;

/**
 * Lock sides for games whose check-in just closed. Reads do it lazily too;
 * the sweep makes the lock land at check-in close rather than at the next
 * page view. Runs as the "results-sweep" job (jobs.ts), once per tick across
 * instances.
 */
async function sweepResults(em: EntityManager): Promise<{ locked: number }> {
  const now = Date.now();
  const games = await em.find(Game, {
    status: { $ne: "cancelled" },
    startsAt: { $gte: new Date(now - SWEEP_LOOKBACK_MS), $lte: new Date(now) },
  });
  const done = new Set(
    (await em.find(GameResult, { game: { $in: games } }, { fields: ["game"] })).map((r) => r.game.id),
  );
  let locked = 0;
  for (const game of games) {
    if (done.has(game.id) || checkInWindow(game, now) !== "closed") continue;
    if (await ensureLocked(em, game)) locked++;
  }
  return { locked };
}

export function startResultTimer(fork: () => EntityManager, everyMs = 60_000): void {
  startJob({ name: "results-sweep", fork, everyMs }, async () => {
    try {
      const { locked } = await sweepResults(fork());
      if (locked) console.log(`[results] locked ${locked}`);
    } catch (err) {
      console.warn("[results] tick failed:", err instanceof Error ? err.message : err);
    }
  });
}

// ── reads ────────────────────────────────────────────────────────────────

interface PublicPlayer {
  id: string;
  name: string | null;
}

function player(p: GameParticipant): PublicPlayer {
  return { id: p.user.id, name: p.user.name ?? null };
}

/**
 * Everything a game page needs to show and drive the result: sides, what
 * was recorded, and what the viewer may do next. Only the host and
 * co-hosts may act; everyone else reads.
 */
export async function getResult(em: EntityManager, game: Game, viewerId?: string) {
  const result = await ensureLocked(em, game);
  const runs = viewerId ? mayUse(await roleOf(em, game, viewerId), "result") : false;

  const window = checkInWindow(game);
  // Rules the client shows but must not restate.
  const rules = {
    checkInClosesAt: checkInClosesAt(game).toISOString(),
    correctionWindowMinutes: CORRECTION_WINDOW_MS / 60_000,
  };
  /** Who was there, by the host's word, once check-in has closed (roster.ts). */
  const roster = await rosterView(em, game, viewerId);

  if (!result) {
    const checkedIn = await em.find(
      GameParticipant,
      { game, status: "joined", checkedInAt: { $ne: null } },
      { populate: ["user"], orderBy: { checkedInAt: "ASC" } },
    );
    const mine = viewerId ? checkedIn.find((p) => p.user.id === viewerId) : undefined;
    const picking = game.status !== "cancelled" && window !== "closed";
    const bothSides = checkedIn.some((p) => p.side === 0) && checkedIn.some((p) => p.side === 1);
    return {
      status: picking ? ("picking" as const) : ("none" as const),
      sides: [0, 1].map((side) => checkedIn.filter((p) => p.side === side).map(player)),
      unassigned: checkedIn.filter((p) => p.side !== 0 && p.side !== 1).map(player),
      lockedAt: null,
      recordedBy: null,
      ...rules,
      roster,
      viewer: {
        side: mine?.side ?? null,
        runsResult: runs,
        canSetSides: picking && runs,
        canStart: picking && window === "open" && bothSides && runs,
        canRecord: false,
        canRecordWin: false,
      },
    };
  }

  const seats = await em.find(
    ResultSeat,
    { result },
    { populate: ["participant", "participant.user"], orderBy: { participant: { checkedInAt: "ASC" } } },
  );
  if (result.recordedBy) await em.populate(result, ["recordedBy"]);
  if (result.lockedBy) await em.populate(result, ["lockedBy"]);
  const mine = viewerId ? seats.find((s) => s.participant.user.id === viewerId) : undefined;
  const settled = result.status === "settled";
  const open = canRecord(result.status, result.firstRecordedAt);
  const bothSides = seats.some((s) => s.side === 0) && seats.some((s) => s.side === 1);
  const recorder = settled && result.recordedBy
    ? { id: result.recordedBy.id, name: result.recordedBy.name ?? null }
    : null;

  return {
    /** "locked" until recorded, then "settled". */
    status: settled ? ("settled" as const) : ("locked" as const),
    sides: [0, 1].map((side) => seats.filter((s) => s.side === side).map((s) => player(s.participant))),
    unassigned: seats.filter((s) => s.side !== 0 && s.side !== 1).map((s) => player(s.participant)),
    lockedAt: result.lockedAt.toISOString(),
    lockedAutomatically: !result.lockedBy,
    /** The host or co-host who tapped start; null when check-in closing locked it. */
    lockedBy: result.lockedBy ? { id: result.lockedBy.id, name: result.lockedBy.name ?? null } : null,
    ...rules,
    roster,
    /** The host or co-host who recorded it. */
    recordedBy: recorder,
    outcome: settled ? result.outcome ?? null : null,
    winningSide: settled ? result.winningSide ?? null : null,
    score: settled && result.score0 !== null && result.score0 !== undefined ? [result.score0, result.score1 ?? 0] : null,
    recordedAt: settled ? result.recordedAt?.toISOString() ?? null : null,
    /** Until when the host may record again to fix a mistake; null once final or before any record. */
    correctUntil: open ? correctUntil(result.status, result.firstRecordedAt)?.toISOString() ?? null : null,
    viewer: {
      side: mine?.side ?? null,
      runsResult: runs,
      canSetSides: false,
      canStart: false,
      canRecord: runs && open,
      /** A win or draw needs players on both sides; "not played" never does. */
      canRecordWin: runs && open && bothSides,
    },
  };
}
