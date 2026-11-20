/**
 * Username rules: one spelling, any capitals. Pure, no database.
 * Run with `pnpm test`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeUsername, usernameDisplay } from "./pin-login.js";

test("usernames fold to lowercase and drop a leading @", () => {
  assert.equal(normalizeUsername("Alex"), "alex");
  assert.equal(normalizeUsername("  @ALEX "), "alex");
  assert.equal(normalizeUsername("Hooper_23"), "hooper_23");
  assert.equal(normalizeUsername("abc"), "abc");
  assert.equal(normalizeUsername("a".repeat(20)), "a".repeat(20));
});

test("a username that is only a different case of another is the same username", () => {
  assert.equal(normalizeUsername("Alex"), normalizeUsername("alex"));
  assert.equal(normalizeUsername("ALEX"), normalizeUsername("alex"));
  assert.equal(normalizeUsername("@Alex"), normalizeUsername("alex"));
});

test("the profile keeps the typed spelling", () => {
  assert.equal(usernameDisplay("Alex"), "Alex");
  assert.equal(usernameDisplay("  @Hooper_23 "), "Hooper_23");
  assert.equal(usernameDisplay("ALEX"), "ALEX");
  assert.equal(usernameDisplay("Alex")?.toLowerCase(), normalizeUsername("alex"));
});

test("usernames are 3–20 letters, numbers or underscores", () => {
  for (const raw of ["ab", "a".repeat(21), "has space", "Alex!", "", "  @  ", 12, null]) {
    assert.equal(normalizeUsername(raw), null, String(raw));
    assert.equal(usernameDisplay(raw), null, String(raw));
  }
});
