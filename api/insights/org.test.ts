/**
 * Insights privacy and arithmetic: the under-5 rule, week starts in
 * Central time, and the before/after averages. Pure: no database.
 * Run with `pnpm test`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { beforeAfter, MIN_COUNT, shown, weekStarts } from "./org.js";

test("a count under five is withheld; five and up shows", () => {
  assert.equal(shown(0), null);
  assert.equal(shown(MIN_COUNT - 1), null);
  assert.equal(shown(MIN_COUNT), MIN_COUNT);
  assert.equal(shown(40), 40);
});

test("weeks start on Monday in Central time, oldest first", () => {
  // Monday 2026-11-23 01:00 UTC is still Sunday evening in Texas.
  const weeks = weekStarts(3, new Date("2026-11-23T01:00:00Z"));
  assert.deepEqual(weeks, ["2026-11-02", "2026-11-09", "2026-11-16"]);
  assert.deepEqual(weekStarts(1, new Date("2026-11-23T15:00:00Z")), ["2026-11-23"]);
});

test("before and after average the weeks on each side of the start", () => {
  const weeks = ["w1", "w2", "w3", "w4", "w5"];
  const counts = new Map([["w1", 6], ["w2", 8], ["w3", 20], ["w4", 22], ["w5", 24]]);
  assert.deepEqual(beforeAfter(weeks, counts, "w3"), { before: 7, after: 22, weeksBefore: 2, weeksAfter: 3 });
});

test("one week on a side, or an average under five, is withheld", () => {
  const weeks = ["w1", "w2", "w3"];
  assert.equal(beforeAfter(weeks, new Map([["w1", 50], ["w2", 60], ["w3", 70]]), "w2").before, null, "a single week before");
  assert.equal(beforeAfter(weeks, new Map([["w2", 3], ["w3", 4]]), "w2").after, null, "an average of 3.5");
});
