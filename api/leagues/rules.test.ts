/**
 * League rules: the round-robin schedule, standings and local times.
 * Pure: no database. Run with `pnpm test`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { addDays, roundRobin, schedule, standings, zonedTime, type FixtureOutcome } from "./rules.js";

const pairKey = ([a, b]: [string, string]) => [a, b].sort().join("-");

for (const n of [2, 3, 4, 5, 6, 7, 8]) {
  test(`round robin of ${n} teams: everyone meets once, nobody twice in a round`, () => {
    const teams = Array.from({ length: n }, (_, i) => `t${i}`);
    const rounds = roundRobin(teams);
    assert.equal(rounds.length, n % 2 ? n : n - 1);
    const seen = new Set<string>();
    for (const round of rounds) {
      const playing = round.flat();
      assert.equal(new Set(playing).size, playing.length, "a team plays twice in one round");
      for (const p of round) {
        assert.ok(!seen.has(pairKey(p)), `${pairKey(p)} meets twice`);
        seen.add(pairKey(p));
      }
    }
    assert.equal(seen.size, (n * (n - 1)) / 2);
  });
}

test("home games are spread: no team is home every time", () => {
  const rounds = roundRobin(["a", "b", "c", "d", "e", "f"]);
  for (const t of ["a", "b", "c", "d", "e", "f"]) {
    const home = rounds.flat().filter(([h]) => h === t).length;
    assert.ok(home >= 2 && home <= 3, `${t} is home ${home} of 5`);
  }
});

test("a second leg swaps home and away", () => {
  const two = schedule(["a", "b", "c", "d"], 2);
  assert.equal(two.length, 6);
  assert.deepEqual(two[3].map(([h, a]) => [a, h]), two[0]);
});

test("one team or none makes no schedule", () => {
  assert.deepEqual(roundRobin(["a"]), []);
  assert.deepEqual(roundRobin([]), []);
});

const win = (home: string, away: string, side: 0 | 1, s0: number, s1: number): FixtureOutcome =>
  ({ home, away, outcome: "win", winningSide: side, score0: s0, score1: s1 });

test("standings count wins, losses, ties and points, and ignore unplayed games", () => {
  const rows = standings(["a", "b", "c"], [
    win("a", "b", 0, 21, 15),
    win("c", "a", 1, 18, 21),
    { home: "b", away: "c", outcome: "draw", winningSide: null, score0: 20, score1: 20 },
    { home: "b", away: "a", outcome: "not_played", winningSide: null, score0: null, score1: null },
    { home: "c", away: "b", outcome: null, winningSide: null, score0: null, score1: null },
  ]);
  assert.deepEqual(rows.map((r) => [r.team, r.place, r.wins, r.losses, r.ties, r.played]), [
    ["a", 1, 2, 0, 0, 2],
    ["c", 2, 0, 1, 1, 2],
    ["b", 3, 0, 1, 1, 2],
  ]);
  assert.equal(rows[0].pct, 1);
  assert.equal(rows[1].pct, 0.25);
  // Same record, but c's point difference (-3) beats b's (-6).
  assert.deepEqual([rows[0].pointsFor, rows[0].pointsAgainst], [42, 33]);
});

test("teams level on record and points share a place", () => {
  const rows = standings(["a", "b", "c"], [win("a", "b", 0, 21, 15), win("c", "b", 0, 21, 15)]);
  assert.deepEqual(rows.map((r) => [r.team, r.place]), [["a", 1], ["c", 1], ["b", 3]]);
});

test("point difference breaks a tie on record", () => {
  const rows = standings(["a", "b", "c", "d"], [win("a", "c", 0, 21, 10), win("b", "d", 0, 21, 19)]);
  assert.deepEqual(rows.slice(0, 2).map((r) => [r.team, r.place]), [["a", 1], ["b", 2]]);
});

test("before any game everyone shares first place", () => {
  assert.deepEqual(standings(["a", "b"], []).map((r) => r.place), [1, 1]);
});

test("local times follow Central time, daylight saving included", () => {
  assert.equal(zonedTime("2027-01-12", "19:00")?.toISOString(), "2027-01-13T01:00:00.000Z");
  assert.equal(zonedTime("2027-07-13", "19:00")?.toISOString(), "2027-07-14T00:00:00.000Z");
  assert.equal(zonedTime("2027-13-01", "19:00"), null);
  assert.equal(zonedTime("2027-01-12", "7pm"), null);
  assert.equal(addDays("2027-03-12", 7), "2027-03-19");
});
