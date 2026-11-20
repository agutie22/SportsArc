/**
 * The public map's privacy rule and its small parsers (moved from api/map/activity.test.ts).
 * Pure: no database. Run with `pnpm test`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { MIN_PLAYERS, parseRange, parseSport, seatFigures, weekIndex } from "./map.js";

test("under five adults, a court shows no player count and no show-up rate", () => {
  assert.deepEqual(seatFigures({ venue: "v", players: MIN_PLAYERS - 1, seats: 12, showed: 10 }), { players: null, showUp: null, checkIns: null });
  assert.deepEqual(seatFigures(undefined), { players: null, showUp: null, checkIns: null });
});

test("from five adults, the count and the show-up rate appear", () => {
  assert.deepEqual(seatFigures({ venue: "v", players: 5, seats: 8, showed: 6 }), { players: 5, showUp: 0.75, checkIns: 6 });
});

test("a range is 4, 12 or 52 weeks; anything else is 12", () => {
  assert.equal(parseRange("4"), 4);
  assert.equal(parseRange(52), 52);
  assert.equal(parseRange("7"), 12);
  assert.equal(parseRange(null), 12);
});

test("an unknown sport means every sport", () => {
  assert.equal(parseSport("Basketball"), "basketball");
  assert.equal(parseSport("curling"), "");
  assert.equal(parseSport(undefined), "");
});

test("games fall into the right week, clamped to the window", () => {
  const since = new Date("2026-08-01T00:00:00Z");
  assert.equal(weekIndex(new Date("2026-08-01T05:00:00Z"), since, 12), 0);
  assert.equal(weekIndex(new Date("2026-08-15T05:00:00Z"), since, 12), 2);
  assert.equal(weekIndex(new Date("2026-12-31T05:00:00Z"), since, 12), 11);
});
