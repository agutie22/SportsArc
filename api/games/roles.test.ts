/**
 * Role rules for games: who may use which host power, when a game may
 * still be cancelled, and when its time is fixed.
 * Pure: no database. Run with `pnpm test`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { cancelAllowed, mayUse, timeEditBlocked, type HostPower } from "./roles.js";

const POWERS: HostPower[] = ["edit", "cancel", "remove", "cohosts", "result"];

test("the host holds every host power", () => {
  for (const p of POWERS) assert.equal(mayUse("host", p), true, p);
});

test("a co-host edits, cancels, removes and runs the result, but never names co-hosts", () => {
  assert.deepEqual(POWERS.filter((p) => mayUse("cohost", p)), ["edit", "cancel", "remove", "result"]);
});

test("a player holds no host power", () => {
  for (const p of POWERS) assert.equal(mayUse(null, p), false, p);
});

test("cancel: any time before check-in opens, then only while nobody has checked in", () => {
  assert.equal(cancelAllowed("early", 0), true);
  assert.equal(cancelAllowed("early", 3), true);
  assert.equal(cancelAllowed("open", 0), true);
  assert.equal(cancelAllowed("open", 1), false);
  assert.equal(cancelAllowed("closed", 0), true);
  assert.equal(cancelAllowed("closed", 2), false);
});

test("time is fixed once event terms exist; other edits are not", () => {
  assert.equal(timeEditBlocked(["time"], true), true);
  assert.equal(timeEditBlocked(["capacity", "time"], true), true);
  assert.equal(timeEditBlocked(["time"], false), false);
  assert.equal(timeEditBlocked(["place", "capacity", "notes"], true), false);
});
