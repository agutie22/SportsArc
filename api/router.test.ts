/**
 * The route table's matching rules: an `:id` param is a uuid or no match,
 * a malformed percent-escape is no match, and a path that only a bad id
 * kept from matching is a 404 rather than a 405.
 * Pure: no database. Run with `pnpm test`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { get, match, pathExists } from "./router.js";

const ID = "6f1c2a9e-3b7d-4e8a-9c0f-1a2b3c4d5e6f";
const noop = () => {};

get("/t/router/things/:id", noop);
get("/t/router/things/:id/parts", noop);
get("/t/router/things/mine", noop);
get("/t/router/share/:token", noop);

test("an :id param matches a uuid, in either case", () => {
  assert.deepEqual(match("GET", `/t/router/things/${ID}`)?.params, { id: ID });
  assert.equal(match("GET", `/t/router/things/${ID.toUpperCase()}/parts`)?.pattern, "/t/router/things/:id/parts");
});

test("anything else in an :id slot matches nothing, and is not a 405", () => {
  for (const bad of ["abc", "123", `${ID}x`, "%20", ""]) {
    assert.equal(match("GET", `/t/router/things/${bad}/parts`), null, bad);
    assert.equal(pathExists(`/t/router/things/${bad}/parts`), false, bad);
  }
  assert.equal(pathExists(`/t/router/things/${ID}`), true);
});

test("a literal segment beside :id is never taken for an id", () => {
  assert.equal(match("GET", "/t/router/things/mine")?.pattern, "/t/router/things/mine");
});

test("params not named id take any text, decoded", () => {
  assert.deepEqual(match("GET", "/t/router/share/a%20b")?.params, { token: "a b" });
});

test("a malformed percent-escape is no match, not a throw", () => {
  assert.equal(match("GET", "/t/router/share/%E0%A4%A"), null);
  assert.equal(pathExists("/t/router/share/%E0%A4%A"), false);
});
