/**
 * Writing the record on a schedule, inside the API process. Every tick:
 *
 *   1. builds the records that became due (writer.ts): each seat's
 *      attendance and the game record once check-in closes, and each
 *      seat's result, and the host's word on who was there, once the host
 *      can no longer correct them; and a finished league season's
 *      standings, members and season record (season-writer.ts) once
 *      every result it counts is written;
 *   2. for up to TICK_BUDGET_MS, every few seconds: follows the
 *      transactions on their way and sends new ones, one record per
 *      transaction, never more than RECORD_MAX_IN_FLIGHT unconfirmed at once
 *      (sender.ts), so players' payments on the relayer's nonce queue are
 *      never stuck behind a backlog.
 *
 * Idle until writing records is configured (TESTNET_PRIVATE_KEY and
 * RECORD_CONTRACT_ADDRESS): no records are built that nobody could send.
 * RECORD_INTERVAL_MIN sets the period (default 1): how soon after check-in
 * closes a game is written. A tick builds at most GAMES_PER_TICK games and
 * sends at most SENDS_PER_TICK records, so a backlog (say, every past game
 * on a fresh contract) drains over a few ticks without crowding payments.
 *
 * Safe with more than one API instance: builders take a Postgres advisory
 * lock and a seat is written once (writer.ts), and each record has its own
 * lock and idempotency key (sender.ts). On top of that each tick runs as the
 * "record" job (api/ops/jobs.ts): once per tick across instances, never
 * overlapping within a process.
 */

import type { EntityManager } from "@mikro-orm/postgresql";
import { isDraining } from "../../ops/drain.js";
import { startJob } from "../../ops/jobs.js";
import { log } from "../../ops/log.js";
import { recordConfigured, postPendingRecords } from "./sender.js";
import { buildPresenceRecords, buildRecords, buildResultRecords } from "./writer.js";
import { buildSeasonRecords } from "./season-writer.js";

const DEFAULT_INTERVAL_MIN = 1;
/** Games built per tick. */
export const GAMES_PER_TICK = 50;
/** New record sends per tick. */
export const SENDS_PER_TICK = 200;
/** Between follow-and-send rounds; Arc confirms a transaction in about a second. */
const ROUND_MS = 2_000;
/** How long one tick keeps sending and following, well inside a one-minute period. */
const TICK_BUDGET_MS = 40_000;

export function recordIntervalMs(): number {
  const raw = Number(process.env.RECORD_INTERVAL_MIN);
  const minutes = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_INTERVAL_MIN;
  return Math.max(1_000, Math.round(minutes * 60_000));
}

export interface TickResult {
  configured: boolean;
  built: number;
  sent: number;
  confirmed: number;
  /** Still on their way when the tick ended. */
  sending: number;
  failed: number;
}

/** One scheduled run. Returns what it did, for logs and tests. */
export async function recordTick(
  fork: () => EntityManager,
  opts: { roundMs?: number; budgetMs?: number } = {},
): Promise<TickResult> {
  const out: TickResult = { configured: recordConfigured(), built: 0, sent: 0, confirmed: 0, sending: 0, failed: 0 };
  if (!out.configured) return out;

  const built = await buildRecords(fork(), { games: GAMES_PER_TICK });
  if (built.ok) out.built = built.records;
  else log.warn("record build failed", { code: built.error.code, reason: built.error.message });
  const results = await buildResultRecords(fork(), { results: GAMES_PER_TICK });
  if (results.ok) out.built += results.records;
  else log.warn("result record build failed", { code: results.error.code, reason: results.error.message });
  const presence = await buildPresenceRecords(fork(), { rosters: GAMES_PER_TICK });
  if (presence.ok) out.built += presence.records;
  else log.warn("presence record build failed", { code: presence.error.code, reason: presence.error.message });
  const seasons = await buildSeasonRecords(fork());
  if (seasons.ok) out.built += seasons.records;
  else log.warn("season record build failed", { code: seasons.error.code, reason: seasons.error.message });

  const until = Date.now() + (opts.budgetMs ?? TICK_BUDGET_MS);
  for (;;) {
    const r = await postPendingRecords(fork(), { limit: SENDS_PER_TICK - out.sent });
    if (!r.ok) break;
    let moving = false;
    out.sending = 0;
    for (const x of r.results) {
      if ("ok" in x) {
        out.failed++;
        log.warn("record write did not go through", { recordId: x.recordId, code: x.error.code, reason: x.error.message });
        continue;
      }
      if (x.status === "confirmed") out.confirmed++;
      else if (x.status === "failed") out.failed++;
      else if (x.status === "sending") {
        out.sending++;
        moving = true;
      }
    }
    out.sent = Math.min(SENDS_PER_TICK, out.sent + r.results.filter((x) => !("ok" in x) && x.status === "sending").length);
    // Shutting down: stop between rounds; what is on its way is followed after restart.
    if (!moving || isDraining() || Date.now() >= until || out.sent >= SENDS_PER_TICK) break;
    await new Promise((resolve) => setTimeout(resolve, opts.roundMs ?? ROUND_MS));
  }
  return out;
}

export function startRecordTimer(fork: () => EntityManager, everyMs = recordIntervalMs()): void {
  let announced = false;
  startJob({ name: "record", fork, everyMs }, async () => {
    try {
      const r = await recordTick(fork);
      if (!r.configured && !announced) {
        log.info("record timer idle: set TESTNET_PRIVATE_KEY and RECORD_CONTRACT_ADDRESS to write records");
      }
      announced = true;
      if (r.built || r.confirmed || r.failed) log.info("records written", { ...r });
    } catch (err) {
      log.warn("record tick failed", { err });
    }
  });
}
