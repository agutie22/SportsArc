/**
 * Background sweep for CCTP transfers in flight: notices confirmations,
 * polls Iris, and skips steps the chain shows are already done. It also
 * follows money being added from outside wallets (funding.ts) to arrival. It never
 * opens a signing request (see transfer.ts), so it cannot move money; with
 * no transfers in flight it costs one query per tick.
 *
 * Wiring: one line in startWeb3Timers() in api/web3/index.ts. Each tick runs
 * as the "cctp" job (api/ops/jobs.ts): once per tick across instances, never
 * overlapping within a process.
 */

import type { EntityManager } from "@mikro-orm/postgresql";
import { startJob } from "../../ops/jobs.js";
import { advanceFundings } from "./funding.js";
import { advanceActive } from "./transfer.js";

const INTERVAL_MS = 30_000;

export function startCctpTimer(em: EntityManager, intervalMs = INTERVAL_MS): () => void {
  return startJob({ name: "cctp", fork: () => em.fork(), everyMs: intervalMs, runNow: false }, async () => {
    try {
      for (const { id, result } of await advanceActive(em.fork())) {
        if (!result.ok && result.error.code !== "TRANSFER_BUSY") {
          console.warn(`[cctp] ${id}: ${result.error.code} ${result.error.message}`);
        }
      }
    } catch (err) {
      console.warn("[cctp] sweep failed:", err instanceof Error ? err.message : err);
    }
    try {
      // Money on its way in from outside wallets: read-only, like the rest.
      await advanceFundings(em.fork());
    } catch (err) {
      console.warn("[cctp] funding sweep failed:", err instanceof Error ? err.message : err);
    }
  });
}
