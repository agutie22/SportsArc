/**
 * The recruiter tag on a game's roster: only adult coaches and scouts are
 * singled out, the same rule as profile views. Pure: no database.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { recruiterTag } from "./discovery.js";

test("an adult coach or scout is tagged with their school", () => {
  assert.deepEqual(recruiterTag({ role: "coach", audience: "adult", school: "Venice High" }), { role: "coach", school: "Venice High" });
  assert.deepEqual(recruiterTag({ role: "scout", audience: "adult", school: null }), { role: "scout", school: null });
});

test("a minor is never tagged, whatever their role", () => {
  assert.equal(recruiterTag({ role: "coach", audience: "minor", school: "X" }), null);
  assert.equal(recruiterTag({ role: "scout", audience: "minor", school: null }), null);
});

test("players are not tagged", () => {
  assert.equal(recruiterTag({ role: "player", audience: "adult", school: null }), null);
  assert.equal(recruiterTag({ role: null, audience: null, school: null }), null);
});
