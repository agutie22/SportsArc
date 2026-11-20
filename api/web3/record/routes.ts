/**
 * SportsArcRecord: one entry per verified record on chain, and lookups anyone
 * can check. Read-only: the in-process timer (timer.ts) builds and writes
 * records, never HTTP (there is no admin role). Access rules are in
 * lookups.ts and record.ts.
 *
 *   GET /api/web3/record/hashes/:hash       one record by its hash (public, no values),
 *                                           with SportsArcRecord.writtenAt's own answer
 *   GET /api/web3/record/users/:id/summary  how many of a person's records are confirmed (signed in)
 *   GET /api/web3/record/users/:id/record   that player's games (public). A private
 *                                           record names them and returns no games.
 *   GET /api/web3/record/counts?ids=a,b     the same counts for up to 100 people (signed in)
 *   GET /api/web3/record/checkins/:gameId   where your seat in one game stands on the record (signed in)
 *   GET /api/web3/record/mine               your verified record, what is still on its way, your share link (signed in)
 *   POST /api/web3/record/record/privacy    hide or show your game list (signed in)
 *   POST /api/web3/record/record/share      make (or return) your share link (signed in)
 *   DELETE /api/web3/record/record/share    turn your share link off (signed in)
 *   GET /api/web3/record/records/:token     the record behind a share link, games included
 *                                           even when the record is private (public: the token is the key)
 *   GET /api/web3/record/record/export      your portable record as one file (signed in; portable.ts)
 *   POST /api/web3/record/record/ownership  open a PIN challenge: your wallet vouches the record is yours (signed in)
 *   POST /api/web3/record/record/ownership/confirm  keep that signature (signed in)
 */

import { em } from "../../db.js";
import { authed, json, parseJsonBody, requireUser, statusFor } from "../../http.js";
import { del, get, post } from "../../router.js";
import { recordByHash, verifiedCounts, verifiedSummary } from "./lookups.js";
import { confirmOwnership, exportRecord, startOwnership } from "./portable.js";
import { myGameRecord, myRecord, publicRecord, setRecordPrivacy, sharedRecord, shareRecord, unshareRecord } from "./record.js";

const CODES: Record<string, number> = {
  NOT_FOUND: 404,
  NOT_WRITTEN: 404,
  RECORD_MISMATCH: 500,
};

get("/api/web3/record/hashes/:hash", async (ctx) => {
  const result = await recordByHash(em(), ctx.params.hash ?? "");
  json(ctx.res, statusFor(result, CODES), result);
});

get("/api/web3/record/users/:id/summary", async (ctx) => {
  const auth = await requireUser(ctx);
  if (!auth) return;
  const result = await verifiedSummary(auth.fork, ctx.params.id ?? "");
  json(ctx.res, statusFor(result, CODES), result);
});

get("/api/web3/record/users/:id/record", async (ctx) => {
  const result = await publicRecord(em(), ctx.params.id ?? "");
  json(ctx.res, statusFor(result, CODES), result);
});

get("/api/web3/record/counts", authed(async ({ res, query }, { fork }) => {
  json(res, 200, await verifiedCounts(fork, (query.get("ids") ?? "").split(",")));
}));

get("/api/web3/record/checkins/:gameId", authed(async ({ res, params }, { user, fork }) => {
  const result = await myGameRecord(fork, user, params.gameId ?? "");
  json(res, statusFor(result, CODES), result);
}));

get("/api/web3/record/mine", authed(async ({ res }, { user, fork }) => {
  json(res, 200, await myRecord(fork, user));
}));

post("/api/web3/record/record/privacy", authed(async (ctx, { user, fork }) => {
  const body = await parseJsonBody(ctx.req, ctx.res);
  if (body === null) return;
  const result = await setRecordPrivacy(fork, user, body);
  json(ctx.res, statusFor(result, CODES), result);
}));

post("/api/web3/record/record/share", authed(async ({ res }, { user, fork }) => {
  json(res, 200, await shareRecord(fork, user));
}));

del("/api/web3/record/record/share", authed(async ({ res }, { user, fork }) => {
  json(res, 200, await unshareRecord(fork, user));
}));

get("/api/web3/record/records/:token", async (ctx) => {
  const result = await sharedRecord(em(), ctx.params.token ?? "");
  json(ctx.res, statusFor(result, CODES), result);
});

/** Where this server is reached, for the checker's address in an exported file. */
function originOf(req: { headers: Record<string, string | string[] | undefined> }): string {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.split(",")[0]?.trim() ?? "";
  const host = one(req.headers["x-forwarded-host"]) || one(req.headers.host) || "localhost";
  const proto = one(req.headers["x-forwarded-proto"]) || (host.startsWith("localhost") ? "http" : "https");
  return /^[a-z0-9.:-]+$/i.test(host) ? `${proto === "http" ? "http" : "https"}://${host}` : "https://sportsarc.app";
}

get("/api/web3/record/record/export", authed(async ({ req, res }, { user, fork }) => {
  json(res, 200, await exportRecord(fork, user, originOf(req)));
}));

post("/api/web3/record/record/ownership", authed(async ({ res }, { user, fork }) => {
  const result = await startOwnership(fork, user);
  json(res, statusFor(result, CODES), result);
}));

post("/api/web3/record/record/ownership/confirm", authed(async (ctx, { user, fork }) => {
  const body = await parseJsonBody(ctx.req, ctx.res);
  if (body === null) return;
  const result = await confirmOwnership(fork, user, body as Record<string, unknown>);
  json(ctx.res, statusFor(result, CODES), result);
}));
