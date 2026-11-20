/**
 * Access guard over the whole route table. Every registered route either
 * answers 401 to a signed-out caller or is listed in PUBLIC below, so a new
 * route is private by default and making one public is a reviewed diff.
 * Needs no database: a route that reaches one before checking the session
 * fails here. This covers signed-out callers only, not which signed-in user
 * may do what.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { handleRequest } from "./app.js";
import { listRoutes } from "./router.js";

const PUBLIC = new Set([
  "GET /health",
  "GET /health/ready",
  "GET /api/config",
  "GET /api/meta",
  "GET /api/wallet/usdc-balance",
  "POST /api/auth/otp/start",
  "POST /api/auth/otp/verify",
  "POST /api/auth/username/signup",
  "POST /api/auth/pin/start",
  "POST /api/auth/pin/finish",
  "POST /api/auth/logout",
  "POST /api/client-errors",
  "GET /api/venues",
  "GET /api/venues/:id/regulars",
  "GET /api/orgs/:slug",
  "GET /api/orgs/:id/leagues",
  "GET /api/seasons/:id",
  "GET /api/teams/:id",
  "GET /api/teams/join/:code",
  "GET /api/seasons",
  "GET /api/orgs/:id/sponsorships",
  "GET /api/orgs/:id/tryouts",
  "GET /api/tryouts/:id",
  "GET /api/insights/map",
  "GET /api/games",
  "GET /api/games/:id",
  "GET /api/games/:id/result",
  "GET /api/people",
  "GET /api/users/:id",
  "GET /api/users/:id/games",
  "GET /api/users/:id/records",
  "GET /api/users/:id/venues",
  "GET /api/feed",
  "GET /api/posts/:id",
  "GET /api/posts/:id/replies",
  "GET /api/athletes",
  "GET /api/ingest/sources",
  "GET /api/web3/record/hashes/:hash",
  "GET /api/web3/record/users/:id/record",
  "GET /api/web3/record/records/:token",
  "GET /uploads/:name",
]);

let server: Server;
let base: string;

before(async () => {
  server = createServer((req, res) => void handleRequest(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

const key = (r: { method: string; pattern: string }) => `${r.method} ${r.pattern}`;

test("every route that is not listed as public answers 401 signed out", async () => {
  const leaks: string[] = [];
  for (const r of listRoutes().filter((x) => !PUBLIC.has(key(x)))) {
    const path = r.pattern.replace(/:[A-Za-z]+/g, "00000000-0000-4000-8000-000000000000");
    const hasBody = r.method !== "GET" && r.method !== "DELETE";
    const res = await fetch(base + path, {
      method: r.method,
      ...(hasBody ? { body: "{}", headers: { "Content-Type": "application/json" } } : {}),
    });
    if (res.status !== 401) leaks.push(`${key(r)} answered ${res.status}`);
    await res.body?.cancel();
  }
  assert.deepEqual(leaks, []);
});

test("the public list names only routes that exist", () => {
  const registered = new Set(listRoutes().map(key));
  assert.deepEqual([...PUBLIC].filter((r) => !registered.has(r)), []);
});
