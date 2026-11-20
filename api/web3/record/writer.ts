/**
 * Builds the records sender.ts sends, each on its own:
 *
 *   buildRecords        once a game's check-in has closed: one attendance
 *                       record per seat (checkin for a seat that checked
 *                       in, noshow for one that did not) and one game
 *                       for what the game was
 *   buildResultRecords  once a game's result can no longer be corrected:
 *                       one result per seat of the result
 *   buildPresenceRecords  once the host's roster confirmation is final
 *                       (games/roster.ts): one presence per seat, the
 *                       host's here or not here
 *
 * A seat is eligible once its game's check-in window has closed (the roster
 * is locked), the game was not cancelled, and the participant is still
 * "joined": the moment who played is fixed, and before anyone knows the
 * result. Each fact is written once: record_entries.slot is unique
 * ("attendance:<seat>", "result:<seat>", "game:<game>"), and builders are
 * serialised with a Postgres advisory lock.
 *
 * What one record reveals on chain: that some record of this kind exists,
 * and when it was written. No names and no ids: the game key, the venue and
 * the salted participant commitments are inside the hash.
 *
 * No HTTP route builds records (there is no admin role): timer.ts does.
 */

import type { EntityManager } from "@mikro-orm/postgresql";
import { checkInClosesAt, checkInWindow } from "../../games/checkin.js";
import { CORRECTION_WINDOW_MS } from "../../games/results.js";
import { Game } from "../../entities/Game.js";
import { GameParticipant } from "../../entities/GameParticipant.js";
import { GameResult } from "../../entities/GameResult.js";
import { ResultSeat } from "../../entities/ResultSeat.js";
import { RosterCheck } from "../../entities/RosterCheck.js";
import { fail, type Failure } from "../../failure.js";
import { RecordEntry } from "./RecordEntry.js";
import { newSalt } from "./keys.js";
import { checkInValues, gameValues, noShowValues, presenceValues, recordHash, resultValues, type RecordKind } from "./hashes.js";

/** Arbitrary constant naming the "build records" lock. */
export const BUILD_LOCK_KEY = 72_630_001;

/** Games looked at per call to find the ones whose check-in has closed. */
const CANDIDATE_GAMES = 25;

/**
 * Started, uncancelled games with a joined seat whose attendance is not
 * written, or with joined seats and no game record, oldest first.
 */
const CANDIDATES_SQL = (only: boolean) => `
  select g.id
    from games g
   where g.status <> 'cancelled'
     and g.starts_at < ?${only ? "\n     and g.id in (?)" : ""}
     and exists (select 1 from game_participants gp where gp.game_id = g.id and gp.status = 'joined')
     and (
       not exists (select 1 from record_entries ar where ar.slot = 'game:' || g.id)
       or exists (
         select 1 from game_participants gp
          where gp.game_id = g.id and gp.status = 'joined'
            and not exists (select 1 from record_entries ar where ar.slot = 'attendance:' || gp.id)))
   order by g.starts_at asc, g.id asc
   limit ?`;

/** One game's joined seats whose attendance is not written yet. */
const SEATS_SQL = `
  select gp.id
    from game_participants gp
   where gp.game_id = ? and gp.status = 'joined'
     and not exists (select 1 from record_entries ar where ar.slot = 'attendance:' || gp.id)
   order by gp.id asc`;

/** Settled results of uncancelled games, final before the cut-off, with a seat whose result is not written. */
const RESULTS_SQL = (only: boolean) => `
  select r.id
    from game_results r
    join games g on g.id = r.game_id
   where r.status = 'settled' and g.status <> 'cancelled'
     and r.first_recorded_at < ?${only ? "\n     and g.id in (?)" : ""}
     and exists (
       select 1 from result_seats rs
        where rs.result_id = r.id
          and not exists (select 1 from record_entries ar where ar.slot = 'result:' || rs.participant_id))
   order by r.first_recorded_at asc, r.id asc
   limit ?`;

function record(kind: RecordKind, slot: string, values: string[], salt: string, game: Game, seat: GameParticipant | null) {
  const row = new RecordEntry();
  row.kind = kind;
  row.slot = slot;
  row.values = values;
  row.hash = recordHash(kind, values);
  row.salt = salt;
  row.game = game;
  row.participant = seat;
  return row;
}

export interface BuildOptions {
  /** Most games to build in this call. */
  games?: number;
  now?: Date;
  /** Only these games (hand-run checks, so a seeded game is not behind real ones). */
  only?: string[];
}

/**
 * Build records for up to `games` closed games, oldest first. Returns how
 * many games and records were built (0 when none is ready).
 */
export function buildRecords(
  em: EntityManager,
  opts: BuildOptions = {},
): Promise<{ ok: true; games: number; records: number } | Failure> {
  const max = Math.max(1, Math.trunc(opts.games ?? CANDIDATE_GAMES));
  const now = opts.now ?? new Date();

  return em.transactional(async (tx) => {
    await tx.execute("select pg_advisory_xact_lock(?)", [BUILD_LOCK_KEY]);
    const params: unknown[] = opts.only ? [now, opts.only, Math.max(max, CANDIDATE_GAMES)] : [now, Math.max(max, CANDIDATE_GAMES)];
    const candidates = await tx.execute<{ id: string }[]>(CANDIDATES_SQL(Boolean(opts.only)), params);
    if (candidates.length === 0) return { ok: true as const, games: 0, records: 0 };

    // The SQL cut-off is game start; the grace period after it is games/checkin.ts's rule.
    const found = await tx.find(Game, { id: { $in: candidates.map((c) => c.id) } });
    const byId = new Map(found.map((g) => [g.id, g]));
    const ready = candidates
      .map((c) => byId.get(c.id))
      .filter((g): g is Game => Boolean(g) && checkInWindow(g as Game, now.getTime()) === "closed")
      .slice(0, max);

    let records = 0;
    for (const game of ready) {
      const rows = await tx.execute<{ id: string }[]>(SEATS_SQL, [game.id]);
      const seats = rows.length ? await tx.find(GameParticipant, { id: { $in: rows.map((r) => r.id) } }) : [];
      for (const seat of seats) {
        const salt = newSalt();
        const showed = Boolean(seat.checkedInAt);
        const values = showed
          ? checkInValues({ gameId: game.id, userId: seat.user.id, checkedInAt: seat.checkedInAt as Date, salt })
          : noShowValues({ gameId: game.id, userId: seat.user.id, closedAt: checkInClosesAt(game), salt });
        tx.persist(record(showed ? "checkin" : "noshow", `attendance:${seat.id}`, values, salt, game, seat));
        records += 1;
      }
      // What the game was, fixed at the same moment as who played.
      if (!(await tx.count(RecordEntry, { slot: `game:${game.id}` }))) {
        const salt = newSalt();
        const values = gameValues({
          gameId: game.id, sport: game.sport, venueId: game.venue.id, startsAt: game.startsAt, hostId: game.host.id, salt,
        });
        tx.persist(record("game", `game:${game.id}`, values, salt, game, null));
        records += 1;
      }
    }
    await tx.flush();
    return { ok: true as const, games: ready.length, records };
  }).catch((err: unknown) => fail("BUILD_FAILED", err instanceof Error ? err.message : String(err)));
}

/**
 * Build result records for up to `results` game results that can no longer
 * be corrected, oldest first: one per seat of the result, with its side,
 * the outcome and the moment it became final.
 */
export function buildResultRecords(
  em: EntityManager,
  opts: { results?: number; now?: Date; only?: string[] } = {},
): Promise<{ ok: true; results: number; records: number } | Failure> {
  const max = Math.max(1, Math.trunc(opts.results ?? CANDIDATE_GAMES));
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - CORRECTION_WINDOW_MS);

  return em.transactional(async (tx) => {
    await tx.execute("select pg_advisory_xact_lock(?)", [BUILD_LOCK_KEY]);
    const params: unknown[] = opts.only ? [cutoff, opts.only, max] : [cutoff, max];
    const found = await tx.execute<{ id: string }[]>(RESULTS_SQL(Boolean(opts.only)), params);
    if (found.length === 0) return { ok: true as const, results: 0, records: 0 };
    const results = await tx.find(GameResult, { id: { $in: found.map((r) => r.id) } }, { populate: ["game"] });

    let records = 0;
    for (const result of results) {
      const outcome = result.outcome;
      if (!outcome || !result.firstRecordedAt) continue;
      const finalAt = new Date(result.firstRecordedAt.getTime() + CORRECTION_WINDOW_MS);
      const seats = await tx.find(ResultSeat, { result }, { populate: ["participant"] });
      for (const seat of seats) {
        const slot = `result:${seat.participant.id}`;
        if (await tx.count(RecordEntry, { slot })) continue;
        const salt = newSalt();
        const values = resultValues({
          gameId: result.game.id, userId: seat.participant.user.id, side: seat.side ?? null,
          outcome, winningSide: result.winningSide ?? null, finalAt, salt,
        });
        tx.persist(record("result", slot, values, salt, result.game, seat.participant));
        records += 1;
      }
    }
    await tx.flush();
    return { ok: true as const, results: results.length, records };
  }).catch((err: unknown) => fail("BUILD_FAILED", err instanceof Error ? err.message : String(err)));
}

/** Roster confirmations final before the cut-off, of uncancelled games, with a seat whose presence is not written. */
const ROSTERS_SQL = (only: boolean) => `
  select rc.id
    from roster_checks rc
    join games g on g.id = rc.game_id
   where g.status <> 'cancelled'
     and rc.first_confirmed_at < ?${only ? "\n     and g.id in (?)" : ""}
     and exists (
       select 1 from game_participants gp
        where gp.game_id = g.id and gp.status = 'joined' and gp.host_present is not null
          and not exists (select 1 from record_entries ar where ar.slot = 'presence:' || gp.id))
   order by rc.first_confirmed_at asc, rc.id asc
   limit ?`;

/**
 * Build presence records for up to `rosters` host confirmations that can
 * no longer be corrected, oldest first: one per seat the host answered.
 */
export function buildPresenceRecords(
  em: EntityManager,
  opts: { rosters?: number; now?: Date; only?: string[] } = {},
): Promise<{ ok: true; rosters: number; records: number } | Failure> {
  const max = Math.max(1, Math.trunc(opts.rosters ?? CANDIDATE_GAMES));
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - CORRECTION_WINDOW_MS);

  return em.transactional(async (tx) => {
    await tx.execute("select pg_advisory_xact_lock(?)", [BUILD_LOCK_KEY]);
    const params: unknown[] = opts.only ? [cutoff, opts.only, max] : [cutoff, max];
    const found = await tx.execute<{ id: string }[]>(ROSTERS_SQL(Boolean(opts.only)), params);
    if (found.length === 0) return { ok: true as const, rosters: 0, records: 0 };
    const checks = await tx.find(RosterCheck, { id: { $in: found.map((r) => r.id) } }, { populate: ["game"] });

    let records = 0;
    for (const check of checks) {
      const finalAt = new Date(check.firstConfirmedAt.getTime() + CORRECTION_WINDOW_MS);
      const seats = await tx.find(GameParticipant, { game: check.game, status: "joined", hostPresent: { $ne: null } });
      for (const seat of seats) {
        const slot = `presence:${seat.id}`;
        if (await tx.count(RecordEntry, { slot })) continue;
        const salt = newSalt();
        const values = presenceValues({ gameId: check.game.id, userId: seat.user.id, present: seat.hostPresent === true, finalAt, salt });
        tx.persist(record("presence", slot, values, salt, check.game, seat));
        records += 1;
      }
    }
    await tx.flush();
    return { ok: true as const, rosters: checks.length, records };
  }).catch((err: unknown) => fail("BUILD_FAILED", err instanceof Error ? err.message : String(err)));
}
