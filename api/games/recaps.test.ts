/**
 * What the recap card's Result button keys off: no result, waiting on the
 * host, recorded (still fixable), or final.
 * Pure: no database. Run with `pnpm test`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { recapResultStatus } from "./recaps.js";
import { CORRECTION_WINDOW_MS } from "./results.js";

const at = new Date("2026-11-18T20:42:00Z");
const t = at.getTime();

test("no result row means no result to record", () => {
  assert.equal(recapResultStatus(null), null);
});

test("locked sides are waiting on the host", () => {
  assert.equal(recapResultStatus({ status: "locked", outcome: null, firstRecordedAt: null }), "locked");
});

test("a recorded result is fixable for the window, then final", () => {
  const row = { status: "settled" as const, outcome: "win", firstRecordedAt: at };
  assert.equal(recapResultStatus(row, t), "recorded");
  assert.equal(recapResultStatus(row, t + CORRECTION_WINDOW_MS - 1), "recorded");
  assert.equal(recapResultStatus(row, t + CORRECTION_WINDOW_MS), "final");
});

test("a settled row without an outcome still waits on the host", () => {
  assert.equal(recapResultStatus({ status: "settled", outcome: null, firstRecordedAt: at }, t), "locked");
});
