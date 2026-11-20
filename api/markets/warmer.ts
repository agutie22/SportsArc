/**
 * Keeps Pro markets data ready before anyone clicks: every 20 s, refresh the
 * catalog for each sport someone listed in the last 15 minutes, and for
 * basketball always (the sport most people open first). A click then reads
 * the cache instead of waiting on Gemini (~1.6 s for a cold sport).
 *
 * The cache lives in this process, so every instance warms its own. That is
 * why this is a plain timer and not ops/jobs.ts startJob, whose advisory
 * lock would let only one instance run it. Gemini traffic stays bounded:
 * at most one fetch per sport per tick, and only for sports in use.
 *
 * Starting the warmer also starts recording odds (history.ts): each fresh
 * list is a point in every shown contract's history when its chance moved.
 */

import { catalog, hasMarkets } from "./catalog.js";
import { config } from "./config.js";
import { recordOdds } from "./history.js";

const EVERY_MS = 20_000;
const VIEWED_MS = 15 * 60_000;
const ALWAYS = ["basketball"];

let timer: ReturnType<typeof setInterval> | null = null;
let recording = false;

export async function warmOnce(): Promise<string[]> {
  const sports = [...new Set([...ALWAYS, ...catalog().recentlyViewed(VIEWED_MS)])].filter(hasMarkets);
  // One after another: a burst of parallel multi-megabyte fetches helps nobody.
  for (const sport of sports) await catalog().warm(sport);
  return sports;
}

/** Start warming; a no-op when Pro markets are off. Returns a stop function. */
export function startMarketsWarmer(): () => void {
  if (!config().enabled || timer) return () => {};
  if (!recording) {
    recording = true;
    catalog().onRefresh(recordOdds);
  }
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    warmOnce().catch((err) => console.warn("[markets] warm failed:", err instanceof Error ? err.message : err))
      .finally(() => { running = false; });
  };
  tick();
  timer = setInterval(tick, EVERY_MS);
  timer.unref();
  return () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
}
