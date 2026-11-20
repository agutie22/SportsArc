/**
 * Settles practice picks in the background: every 2 minutes, ask Gemini
 * about the events behind everyone's open practice fills, pay the side that
 * won and send market_settled. Without it a win was only noticed when its
 * holder happened to open the markets card.
 *
 * A job (one instance per tick, via ops/jobs.ts) because it writes shared
 * rows, unlike the warmer, which fills a per-process cache. Gemini traffic
 * is bounded by practice.ts: each event at most once per 2 minutes, at most
 * JOB_MAX_CHECKS events per tick. Practice mode only; oauth accounts still
 * settle when their holder looks, since that needs each user's token.
 */

import type { EntityManager } from "@mikro-orm/postgresql";
import { startJob } from "../ops/jobs.js";
import { log } from "../ops/log.js";
import { catalog } from "./catalog.js";
import { config } from "./config.js";
import { settleAllPractice } from "./practice.js";

export function startPracticeSettleJob(fork: () => EntityManager, everyMs = 2 * 60_000): void {
  const cfg = config();
  if (!cfg.enabled || cfg.trading !== "practice") return;
  startJob({ name: "markets-settle", fork, everyMs }, async () => {
    const settled = await settleAllPractice(fork(), catalog());
    if (settled) log.info("practice fills settled", { module: "markets", settled });
  });
}
