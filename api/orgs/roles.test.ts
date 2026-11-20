/**
 * Organization role rules: what owners, admins and staff may do, who may
 * name or remove whom, and what needs a verified org. Pure: no database.
 * Run with `pnpm test`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mayAssign, mayOrg, mayRemove, verifiedGate, type OrgPower } from "./roles.js";
import { slugify, validSlug } from "./orgs.js";

const POWERS: OrgPower[] = ["edit", "members", "admins", "run"];

test("an owner holds every power", () => {
  for (const p of POWERS) assert.equal(mayOrg("owner", p), true, p);
});

test("an admin edits, manages staff and runs the work, but never names admins", () => {
  assert.deepEqual(POWERS.filter((p) => mayOrg("admin", p)), ["edit", "members", "run"]);
});

test("staff only run the work", () => {
  assert.deepEqual(POWERS.filter((p) => mayOrg("staff", p)), ["run"]);
});

test("someone outside the org holds no power", () => {
  for (const p of POWERS) assert.equal(mayOrg(null, p), false, p);
});

test("only owners name owners and admins; admins name staff", () => {
  assert.equal(mayAssign("owner", "owner"), true);
  assert.equal(mayAssign("owner", "admin"), true);
  assert.equal(mayAssign("admin", "admin"), false);
  assert.equal(mayAssign("admin", "owner"), false);
  assert.equal(mayAssign("admin", "staff"), true);
  assert.equal(mayAssign("staff", "staff"), false);
  assert.equal(mayAssign(null, "staff"), false);
});

test("anyone in the org may leave; removing others follows who may name them", () => {
  assert.equal(mayRemove("staff", "staff", true), true);
  assert.equal(mayRemove("staff", "staff", false), false);
  assert.equal(mayRemove("admin", "staff", false), true);
  assert.equal(mayRemove("admin", "admin", false), false);
  assert.equal(mayRemove("owner", "admin", false), true);
  assert.equal(mayRemove(null, "staff", true), false);
});

test("money, sponsoring and insights wait for verification", () => {
  for (const w of ["money", "sponsor", "insights"] as const) {
    assert.equal(verifiedGate({ verifiedAt: null }, w)?.error.code, "ORG_NOT_VERIFIED", w);
    assert.equal(verifiedGate({ verifiedAt: new Date() }, w), null, w);
  }
});

test("slugs come from names and keep to letters, digits and dashes", () => {
  assert.equal(slugify("Spurs Sports & Entertainment"), "spurs-sports-entertainment");
  assert.equal(slugify("  I-35 3v3 League "), "i-35-3v3-league");
  assert.equal(slugify("Équipe Montréal"), "equipe-montreal");
  assert.equal(validSlug("austin-spurs"), true);
  assert.equal(validSlug("a"), false);
  assert.equal(validSlug("-austin"), false);
  assert.equal(validSlug("Austin"), false);
  assert.equal(validSlug("manage"), false);
});
