/**
 * Unit tests for jobs.ts that need no database: lock keys, and that a
 * stopped job never starts a tick.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { EntityManager } from "@mikro-orm/postgresql";
import { advisoryKey, jobsInFlight, startJob, stopJobs } from "./jobs.js";

test("advisory keys are stable, distinct per name, and fit a signed bigint", () => {
  assert.equal(advisoryKey("job:recaps"), advisoryKey("job:recaps"));
  const names = ["job:recaps", "job:results-sweep", "job:record", "job:event_settle", "job:cctp", "job:gateway_payouts"];
  assert.equal(new Set(names.map(advisoryKey)).size, names.length);
  for (const n of names) {
    const k = BigInt(advisoryKey(n));
    assert.ok(k >= -(2n ** 63n) && k < 2n ** 63n);
  }
});

test("after stopJobs no tick starts, and stopJobs resolves at once with none in flight", async () => {
  let ticks = 0;
  const fork = () => {
    throw new Error("no database in this test");
  };
  startJob({ name: "test", fork: fork as unknown as () => EntityManager, everyMs: 10, runNow: false }, async () => {
    ticks++;
  });
  assert.equal(await stopJobs(1_000), true);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(ticks, 0);
  assert.equal(jobsInFlight(), 0);
});
