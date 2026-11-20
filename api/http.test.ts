/**
 * JSON answers (http.ts json()): browsers that accept gzip get large bodies
 * compressed and compact; everything else gets indented JSON as before.
 * Pure: a fake response, no server. Run with `pnpm test`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import type { ServerResponse } from "node:http";
import { json } from "./http.js";

function fakeRes(acceptEncoding?: string) {
  const headers: Record<string, unknown> = {};
  let sent: Buffer | string = "";
  const res = {
    req: { headers: acceptEncoding === undefined ? {} : { "accept-encoding": acceptEncoding } },
    statusCode: 0,
    setHeader: (k: string, v: unknown) => { headers[k.toLowerCase()] = v; },
    end: (b: Buffer | string) => { sent = b; },
  };
  return { res: res as unknown as ServerResponse, headers, body: () => sent };
}

const big = { ok: true, rows: Array.from({ length: 200 }, (_, i) => ({ i, name: `row ${i}` })) };

test("a large body is gzipped for a client that accepts it", () => {
  const r = fakeRes("gzip, deflate, br");
  json(r.res, 200, big);
  assert.equal(r.headers["content-encoding"], "gzip");
  assert.equal(r.headers.vary, "Accept-Encoding");
  const out = gunzipSync(r.body() as Buffer).toString("utf8");
  assert.deepEqual(JSON.parse(out), big);
  assert.ok(!out.includes("\n"), "compact");
  assert.equal(r.headers["content-length"], (r.body() as Buffer).length);
});

test("small bodies, and clients without gzip, get plain JSON", () => {
  const small = fakeRes("gzip");
  json(small.res, 200, { ok: true });
  assert.equal(small.headers["content-encoding"], undefined);
  assert.deepEqual(JSON.parse(String(small.body())), { ok: true });

  const curl = fakeRes();
  json(curl.res, 200, big);
  assert.equal(curl.headers["content-encoding"], undefined);
  assert.ok(String(curl.body()).includes("\n  "), "indented for reading");

  const refused = fakeRes("gzip;q=0, identity");
  json(refused.res, 200, big);
  assert.equal(refused.headers["content-encoding"], undefined);
});
