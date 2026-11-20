/**
 * The payout job: every few seconds, read new routed event payments
 * (inbox.ts) and move every payout in flight a step (payouts.ts). Runs as
 * the "gateway_payouts" job (ops/jobs.ts): once per tick across instances,
 * never overlapping itself, which is what lets payouts.ts pay each one once.
 * Idle until PAYOUT_PRIVATE_KEY is set and WEB3_CHAIN is a chain Gateway serves.
 *
 * Wiring: one line in startWeb3Timers() in api/web3/index.ts.
 */

import type { EntityManager } from "@mikro-orm/postgresql";
import { startJob } from "../../ops/jobs.js";
import { log } from "../../ops/log.js";
import { scanRoutedPayouts } from "./inbox.js";
import { advancePayouts, payoutsConfigured } from "./payouts.js";

const EVERY_MS = 5_000;

export async function payoutTick(fork: () => EntityManager): Promise<{ queued: number; advanced: number }> {
  if (!payoutsConfigured()) return { queued: 0, advanced: 0 };
  let queued = 0;
  try {
    queued = await scanRoutedPayouts(fork());
  } catch (err) {
    log.warn("payout inbox scan failed", { err });
  }
  const advanced = await advancePayouts(fork);
  return { queued, advanced };
}

export function startGatewayPayouts(fork: () => EntityManager): () => void {
  return startJob({ name: "gateway_payouts", fork, everyMs: EVERY_MS }, async () => {
    try {
      const r = await payoutTick(fork);
      if (r.queued) log.info("payouts queued", r);
    } catch (err) {
      log.error("payout tick failed", { err });
    }
  });
}
