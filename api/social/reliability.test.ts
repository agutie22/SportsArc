/**
 * The reliability label: under 3 counted games it says "New".
 */

import assert from "node:assert/strict";
import test from "node:test";
import { reliabilityView } from "./reliability.js";

test("under 3 games is New", () => {
  assert.equal(reliabilityView(0, 0).label, "New");
  assert.equal(reliabilityView(2, 2).label, "New");
  assert.equal(reliabilityView(2, 1).showed, 1);
});

test("3 or more games has no label and keeps the counts", () => {
  const r = reliabilityView(24, 23);
  assert.equal(r.label, null);
  assert.equal(r.games, 24);
  assert.equal(r.showed, 23);
});

test("showing up: the phone checked in, or the host said here; either is enough", async () => {
  const { showedUp } = await import("./reliability.js");
  const at = new Date();
  assert.equal(showedUp({ checkedInAt: at, hostPresent: null }), true, "phone only");
  assert.equal(showedUp({ checkedInAt: null, hostPresent: true }), true, "the host, when the phone failed");
  assert.equal(showedUp({ checkedInAt: at, hostPresent: false }), true, "either is enough");
  assert.equal(showedUp({ checkedInAt: null, hostPresent: false }), false);
  assert.equal(showedUp({ checkedInAt: null, hostPresent: null }), false, "no check-in, no confirmation");
});
