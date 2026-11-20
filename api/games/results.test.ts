/**
 * The rule for recording a game result (the host records it; it can be
 * corrected for an hour), and who is told.
 * Pure: no database. Run with `pnpm test`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { canRecord, correctUntil, CORRECTION_WINDOW_MS, settledRecipients } from "./results.js";

const settledAt = new Date("2026-09-25T18:00:00Z");
const t = settledAt.getTime();

test("a result can be recorded any time before it settles", () => {
  assert.equal(canRecord("locked", null), true);
  assert.equal(canRecord("locked", null, t + 10 * CORRECTION_WINDOW_MS), true);
});

test("a settled result can be corrected for an hour, then it is final", () => {
  assert.equal(canRecord("settled", settledAt, t), true);
  assert.equal(canRecord("settled", settledAt, t + CORRECTION_WINDOW_MS - 1), true);
  assert.equal(canRecord("settled", settledAt, t + CORRECTION_WINDOW_MS), false);
  assert.equal(canRecord("settled", null, t), false, "no settle time on record: treat as final");
});

test("correctUntil is an hour after the first record, and only for a settled result", () => {
  assert.equal(correctUntil("settled", settledAt)?.getTime(), t + 3600_000);
  assert.equal(correctUntil("locked", null), null);
  assert.equal(correctUntil("locked", settledAt), null);
});

test("everyone seated hears that the result settled", () => {
  assert.deepEqual(settledRecipients([{ userId: "a" }, { userId: "b" }]), ["a", "b"]);
});
