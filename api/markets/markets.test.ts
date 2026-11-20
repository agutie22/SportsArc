/**
 * Pro markets (api/markets): settings, token sealing, the OAuth state,
 * Gemini request signing and error mapping, the catalog and its cache,
 * order quoting, token refresh, the adults-only gate, and odds history.
 * Pure: no database, no network (Gemini is a fake fetch). Run with `pnpm test`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { canTradeMarkets, marketsGate } from "./access.js";
import { createCatalog, eventTickerOf, forList, headline, normalizeEvent, sideChance, FRESH_MS, STALE_MS, type PublicContract, type PublicMarketEvent } from "./catalog.js";
import { createOddsRecorder, KEEP_MS, parseHours, parseSymbols, ticksOf, type Tick } from "./history.js";
import { marketsConfig, parseTokenKey } from "./config.js";
import { geminiClient, mapRejection, nextNonce, signedRequest, type FetchFn, type GeminiClient } from "./gemini.js";
import { liveToken, needsRefresh, parseTokens, pkceChallenge, type OAuthClient } from "./oauth.js";
import { fromScaled, quote, readFill, rememberOrder, seenOrder, toScaled } from "./orders.js";
import { open, seal } from "./seal.js";
import { newState, openState, signState } from "./state.js";
import type { GeminiLink } from "./GeminiLink.js";

const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/events.sample.json", import.meta.url), "utf8"));
const RAW_GAME = FIXTURE.data[0];
const KEY = randomBytes(32);

// ── config ────────────────────────────────────────────────────────────

test("practice is the default outside production, off in production", () => {
  assert.equal(marketsConfig({}).trading, "practice");
  assert.equal(marketsConfig({}).dataEnv, "production");
  assert.equal(marketsConfig({ NODE_ENV: "production" }).trading, "off");
  assert.equal(marketsConfig({ NODE_ENV: "production" }).enabled, false);
});

test("demo-key is refused in production and without a key", () => {
  const prod = marketsConfig({ NODE_ENV: "production", GEMINI_TRADING: "demo-key", GEMINI_DEMO_KEY: "k", GEMINI_DEMO_SECRET: "s" });
  assert.equal(prod.trading, "off");
  assert.match(prod.problem ?? "", /sandbox only/);
  assert.equal(marketsConfig({ GEMINI_TRADING: "demo-key", GEMINI_ENV: "production", GEMINI_DEMO_KEY: "k", GEMINI_DEMO_SECRET: "s" }).trading, "off");
  assert.equal(marketsConfig({ GEMINI_TRADING: "demo-key" }).trading, "off");
  const ok = marketsConfig({ GEMINI_TRADING: "demo-key", GEMINI_DEMO_KEY: "k", GEMINI_DEMO_SECRET: "s" });
  assert.equal(ok.trading, "demo-key");
  assert.equal(ok.dataEnv, "sandbox", "real trading reads data from the same Gemini it trades on");
});

test("oauth needs every setting and a 32-byte token key", () => {
  const full = {
    GEMINI_TRADING: "oauth", GEMINI_CLIENT_ID: "id", GEMINI_CLIENT_SECRET: "secret",
    GEMINI_REDIRECT_URI: "http://localhost:3000/api/markets/callback", GEMINI_TOKEN_KEY: KEY.toString("base64"),
  };
  assert.equal(marketsConfig(full).trading, "oauth");
  assert.equal(marketsConfig(full).authBase, "https://exchange.sandbox.gemini.com");
  assert.equal(marketsConfig({ ...full, GEMINI_CLIENT_SECRET: "" }).trading, "off");
  const shortKey = marketsConfig({ ...full, GEMINI_TOKEN_KEY: randomBytes(16).toString("base64") });
  assert.equal(shortKey.trading, "off");
  assert.match(shortKey.problem ?? "", /32 bytes/);
  assert.equal(parseTokenKey("not base64 at all"), null);
});

// ── sealing ───────────────────────────────────────────────────────────

test("sealed tokens open with their key and nothing else", () => {
  const sealed = seal("refresh-token-123", KEY);
  assert.notEqual(seal("refresh-token-123", KEY), sealed, "a fresh IV every time");
  assert.equal(open(sealed, KEY), "refresh-token-123");
  assert.equal(open(sealed, randomBytes(32)), null);
  const parts = sealed.split(".");
  for (const i of [1, 2, 3]) {
    const bad = [...parts];
    const b = Buffer.from(bad[i], "base64url");
    b[0] ^= 1;
    bad[i] = b.toString("base64url");
    assert.equal(open(bad.join("."), KEY), null, `changing part ${i} is caught`);
  }
  assert.equal(open("v2.a.b.c", KEY), null);
  assert.equal(open(undefined, KEY), null);
});

// ── OAuth state ───────────────────────────────────────────────────────

test("the state cookie opens only for its user, unexpired, unchanged", () => {
  const secret = "test-secret";
  const s = newState("user-1", "basketball", 1_000);
  const signed = signState(s, secret);
  assert.deepEqual(openState(signed, "user-1", secret, 2_000), s);
  assert.equal(openState(signed, "user-2", secret, 2_000), null, "another user");
  assert.equal(openState(signed, "user-1", secret, s.exp + 1), null, "expired");
  assert.equal(openState(signed, "user-1", "other-secret", 2_000), null, "another secret");
  assert.equal(openState(signed.replace(/^./, "x"), "user-1", secret, 2_000), null, "changed");
  // A session-style token (same HMAC, no prefix) is not a state.
  const body = signed.slice(0, signed.lastIndexOf("."));
  const sessionMac = createHmac("sha256", secret).update(body).digest("base64url");
  assert.equal(openState(`${body}.${sessionMac}`, "user-1", secret, 2_000), null);
});

test("PKCE challenge is the S256 of the verifier", () => {
  // RFC 7636 appendix B.
  assert.equal(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
});

// ── Gemini requests ───────────────────────────────────────────────────

test("an HMAC call carries the payload, the key and an HMAC-SHA384 signature", () => {
  const { headers, body } = signedRequest({ kind: "hmac", key: "account-abc", secret: "s3cr3t" },
    "/v1/prediction-markets/order", { symbol: "GEMI-X-Y", quantity: "1" }, false, 1700000000000);
  const payload = JSON.parse(Buffer.from(headers["x-gemini-payload"], "base64").toString("utf8"));
  assert.deepEqual(payload, { request: "/v1/prediction-markets/order", symbol: "GEMI-X-Y", quantity: "1", nonce: 1700000000000 });
  assert.equal(headers["x-gemini-apikey"], "account-abc");
  assert.equal(headers["x-gemini-signature"], createHmac("sha384", "s3cr3t").update(headers["x-gemini-payload"]).digest("hex"));
  assert.equal(headers["content-length"], "0");
  assert.equal(body, undefined);
});

test("a Bearer call has no nonce and no signature; JSON mode adds a body", () => {
  const { headers, body } = signedRequest({ kind: "bearer", token: "tok" }, "/v1/balances", { a: 1 }, true);
  assert.equal(headers.authorization, "Bearer tok");
  assert.equal(headers["x-gemini-signature"], undefined);
  assert.equal(JSON.parse(Buffer.from(headers["x-gemini-payload"], "base64").toString()).nonce, undefined);
  assert.equal(body, JSON.stringify({ a: 1 }));
});

test("nonces always increase, even within one millisecond", () => {
  const a = nextNonce(5_000_000_000_000);
  const b = nextNonce(5_000_000_000_000);
  const c = nextNonce(4_000_000_000_000);
  assert.ok(b > a && c > b);
});

test("Gemini's refusals map to our codes", () => {
  assert.equal(mapRejection(400, { reason: "TERMS_NOT_ACCEPTED" }), "TERMS_NOT_ACCEPTED");
  assert.equal(mapRejection(400, { reason: "InsufficientFunds" }), "INSUFFICIENT_FUNDS");
  assert.equal(mapRejection(403, { code: "ACCOUNT_GROUP_BLOCKED" }), "MARKETS_NOT_AVAILABLE_FOR_ACCOUNT");
  assert.equal(mapRejection(400, { reason: "ACCOUNT_RESTRICTED_SELL_ONLY" }), "ACCOUNT_SELL_ONLY");
  assert.equal(mapRejection(400, { reason: "InvalidPrice" }), "INVALID_ORDER");
  assert.equal(mapRejection(400, { reason: "InvalidSignature" }), "GEMINI_AUTH_FAILED");
  assert.equal(mapRejection(403, { reason: "MissingRole" }), "GEMINI_SCOPE_MISSING");
  assert.equal(mapRejection(401, {}), "GEMINI_AUTH_FAILED");
  assert.equal(mapRejection(429, {}), "GEMINI_UNAVAILABLE");
  assert.equal(mapRejection(400, { reason: "SomethingNew" }), "GEMINI_REJECTED");
});

const fakeFetch = (handler: (url: string) => { status: number; body: unknown } | Error): { fn: FetchFn; calls: string[] } => {
  const calls: string[] = [];
  const fn: FetchFn = async (url) => {
    calls.push(url);
    const r = handler(url);
    if (r instanceof Error) throw r;
    return { status: r.status, text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)) };
  };
  return { fn, calls };
};

test("the client never throws: network, 5xx, bad JSON and 4xx all come back as results", async () => {
  const cfg = { dataBase: "https://data", restBase: "https://rest" };
  const down = geminiClient(fakeFetch(() => new Error("timeout")).fn, cfg);
  assert.equal((await down.publicGet("/x") as any).error.code, "GEMINI_UNAVAILABLE");
  const five = geminiClient(fakeFetch(() => ({ status: 502, body: {} })).fn, cfg);
  assert.equal((await five.publicGet("/x") as any).error.code, "GEMINI_UNAVAILABLE");
  const junk = geminiClient(fakeFetch(() => ({ status: 200, body: "<html>" })).fn, cfg);
  assert.equal((await junk.publicGet("/x") as any).error.code, "GEMINI_BAD_RESPONSE");
  const no = geminiClient(fakeFetch(() => ({ status: 400, body: { reason: "InsufficientFunds", message: "need $" } })).fn, cfg);
  const r = await no.privatePost({ kind: "bearer", token: "t" }, "/v1/prediction-markets/order") as any;
  assert.equal(r.error.code, "INSUFFICIENT_FUNDS");
  assert.equal(r.rejected, true);
  assert.equal(r.error.detail, "need $", "Gemini's own words stay in detail");
  const { fn, calls } = fakeFetch(() => ({ status: 200, body: { ok: 1 } }));
  await geminiClient(fn, cfg).publicGet("/v1/e", { sport: "basketball", skip: undefined });
  assert.equal(calls[0], "https://data/v1/e?sport=basketball", "public reads go to the data host");
});

// ── catalog ───────────────────────────────────────────────────────────

test("a Gemini game becomes our event: teams in order, short labels, chances, lines", () => {
  const e = normalizeEvent(RAW_GAME, "basketball");
  assert.equal(e.kind, "moneyline");
  assert.equal(e.leagueCode, "NBA");
  assert.equal(e.league, "NBA");
  assert.equal(e.contracts.length, 2);
  assert.equal(e.contracts[0].side, "away", "the away team comes first, as a scoreboard reads");
  for (const c of e.contracts) {
    assert.match(c.symbol, /^GEMI-NBA-/);
    assert.equal(eventTickerOf(c.symbol), e.ticker);
    assert.ok(c.short.length <= 4, `short label ${c.short}`);
    assert.ok(c.chance !== null && c.chance >= 0 && c.chance <= 100);
  }
  assert.ok(e.lines.total && e.lines.total.contracts.length > 0);
  assert.ok(e.lines.total.contracts.every((c) => /^Over \d/.test(c.short)));
  assert.ok(e.lines.spread && e.lines.spread.contracts.every((c) => c.short.includes("−")));
  const listed = forList(e);
  assert.equal(listed.lines.total?.contracts.length, 1, "a list keeps one line per child market");
  const c = listed.lines.total!.contracts[0];
  for (const other of e.lines.total.contracts.filter((x) => x.chance !== null && x.yes.buy)) {
    assert.ok(Math.abs(c.chance! - 50) <= Math.abs(other.chance! - 50), "and it is the most even one");
  }
});

test("contracts that cannot take an order now are dropped, unless kept for settlement", () => {
  const raw = structuredClone(RAW_GAME);
  raw.contracts[0].marketState = "post_only";
  assert.equal(normalizeEvent(raw, "basketball").contracts.length, 1);
  assert.equal(normalizeEvent(raw, "basketball", { keepClosed: true }).contracts.length, 2);
});

test("eventTickerOf handles dashes in event tickers", () => {
  assert.equal(eventTickerOf("GEMI-NBA-2611170000-ORL-BOS-T-O183"), "NBA-2611170000-ORL-BOS-T");
  assert.equal(eventTickerOf("BTC-USD"), null);
});

function catalogWith(handler: () => { status: number; body: unknown } | Error) {
  let now = Date.parse("2026-11-16T20:00:00Z");
  const { fn, calls } = fakeFetch(handler);
  const client = geminiClient(fn, { dataBase: "https://data", restBase: "https://rest" });
  const cat = createCatalog(() => client as GeminiClient, () => now);
  return { cat, calls, tick: (ms: number) => { now += ms; } };
}

test("one fetch per sport serves everyone while fresh, and concurrent asks share it", async () => {
  const { cat, calls, tick } = catalogWith(() => ({ status: 200, body: FIXTURE }));
  const [a, b] = await Promise.all([cat.list("basketball"), cat.list("basketball")]);
  assert.ok(a.ok && b.ok);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /sport=basketball/);
  assert.match(calls[0], /sports_market_type=moneyline/);
  tick(FRESH_MS - 1);
  await cat.list("basketball");
  assert.equal(calls.length, 1);
  tick(2);
  await cat.list("basketball");
  assert.equal(calls.length, 2, "refreshes once stale");
});

test("a Gemini outage serves the last list for 5 minutes, then says unavailable", async () => {
  let fail = false;
  const { cat, tick } = catalogWith(() => (fail ? { status: 503, body: {} } : { status: 200, body: FIXTURE }));
  assert.ok((await cat.list("basketball")).ok);
  fail = true;
  tick(FRESH_MS + 1);
  const stale = await cat.list("basketball");
  assert.ok(stale.ok && stale.events.length === 1);
  tick(STALE_MS);
  const gone = await cat.list("basketball");
  assert.equal(gone.ok, false);
  assert.equal((gone as any).error.code, "MARKETS_UNAVAILABLE");
});

test("quarter and half markets, and games nobody can buy, are left out of the list", async () => {
  const quarter = structuredClone(RAW_GAME);
  quarter.ticker = "NBA-2611170000-ORL-BOS-1QM";
  quarter.sportsMarket = { ...quarter.sportsMarket, scope: { type: "quarter" } };
  const unpriced = structuredClone(RAW_GAME);
  unpriced.ticker = "NBA-2611170000-ORL-BOS-X";
  for (const c of unpriced.contracts) c.prices = {};
  const soccerStyle = structuredClone(RAW_GAME);
  soccerStyle.ticker = "NBA-2611170000-ORL-BOS-R";
  soccerStyle.sportsMarket = { ...soccerStyle.sportsMarket, scope: { type: "regulation" } };
  const { cat } = catalogWith(() => ({ status: 200, body: { data: [RAW_GAME, quarter, unpriced, soccerStyle] } }));
  const r = await cat.list("basketball");
  assert.ok(r.ok);
  assert.deepEqual(r.events.map((e) => e.ticker).sort(), [RAW_GAME.ticker, soccerStyle.ticker].sort(), "regulation (soccer's 90 minutes) is the whole game");
});

test("unknown sports and long-finished games are left out", async () => {
  const { cat, tick } = catalogWith(() => ({ status: 200, body: FIXTURE }));
  assert.equal(((await cat.list("pickleball")) as any).error.code, "UNKNOWN_SPORT");
  tick(2 * 86_400_000);
  const later = await cat.list("basketball");
  assert.ok(later.ok && later.events.length === 0, "a game that started days ago is over");
});

test("the catalog remembers which sports were viewed, and warm() refreshes only stale ones", async () => {
  const { cat, calls, tick } = catalogWith(() => ({ status: 200, body: FIXTURE }));
  assert.deepEqual(cat.recentlyViewed(60_000), []);
  await cat.list("basketball");
  tick(1_000);
  await cat.list("soccer");
  assert.deepEqual(cat.recentlyViewed(60_000), ["soccer", "basketball"], "most recent first");
  const before = calls.length;
  await cat.warm("basketball");
  assert.equal(calls.length, before, "still fresh: no fetch");
  tick(FRESH_MS);
  await cat.warm("basketball");
  assert.equal(calls.length, before + 1);
  await cat.warm("pickleball");
  assert.equal(calls.length, before + 1, "a sport without markets is never fetched");
  tick(61_000);
  assert.deepEqual(cat.recentlyViewed(60_000), []);
});

test("the headline is a pro game, close if possible", () => {
  const e = normalizeEvent(RAW_GAME, "basketball");
  const college = { ...e, ticker: "NCAAM-1", leagueCode: "NCAAM", volumeUsd: e.volumeUsd * 100 };
  assert.equal(headline([college, e], Date.parse("2026-11-16T20:00:00Z"))?.ticker, e.ticker);
});

// ── quoting ───────────────────────────────────────────────────────────

const contract = (over: Partial<PublicContract> = {}): PublicContract => ({
  symbol: "GEMI-NBA-1-A-B-M-A", label: "Alpha", short: "A", side: "away", marketState: "open",
  yes: { buy: "0.62", sell: "0.61" }, no: { buy: "0.39", sell: "0.38" }, chance: 62,
  priceIncrement: "0.01", priceMinimum: "0.01", quantityIncrement: "0.01", quantityMinimum: "0.01",
  resolutionSide: null, ...over,
});
const ev = { ticker: "NBA-1-A-B-M", title: "Alpha vs Beta" };

test("decimal helpers round-trip without floats", () => {
  assert.equal(toScaled("0.0125"), 1_250_000n);
  assert.equal(fromScaled(1_250_000n), "0.0125");
  assert.equal(fromScaled(toScaled("12")!), "12");
  assert.equal(toScaled("1e3"), null);
});

test("$10 at 62¢ with a 0.01 size step buys 16.12 contracts for $9.99", () => {
  const q = quote(ev, contract(), "yes", 10);
  assert.ok(q.ok);
  assert.equal(q.quote.price, "0.62");
  assert.equal(q.quote.qty, "16.12");
  assert.equal(q.quote.cost, "9.9944");
  assert.equal(q.quote.costCents, 1000, "cents round up");
  assert.equal(q.quote.payout, "16.12");
});

test("the price rounds up to its step and the size down to its step", () => {
  const q = quote(ev, contract({ yes: { buy: "0.433", sell: null }, quantityIncrement: "1", quantityMinimum: "1" }), "yes", 10);
  assert.ok(q.ok);
  assert.equal(q.quote.price, "0.44");
  assert.equal(q.quote.qty, "22");
  const tenths = quote(ev, contract({ yes: { buy: "0.3", sell: null }, priceIncrement: "0.001", quantityIncrement: "0.1" }), "yes", 5);
  assert.ok(tenths.ok);
  assert.equal(tenths.quote.price, "0.3");
  assert.equal(tenths.quote.qty, "16.6");
});

test("the no side is priced from the no buy price and its chance is the rest", () => {
  const q = quote(ev, contract(), "no", 10);
  assert.ok(q.ok);
  assert.equal(q.quote.price, "0.39");
  assert.equal(q.quote.chance, 38);
});

test("too small, out of range, closed and unpriced orders are refused", () => {
  const big = contract({ quantityIncrement: "1", quantityMinimum: "5" });
  assert.equal((quote(ev, big, "yes", 2) as any).error.code, "AMOUNT_TOO_SMALL");
  assert.match((quote(ev, big, "yes", 2) as any).error.message, /\$3\.10/);
  assert.equal((quote(ev, contract(), "yes", 0.5) as any).error.code, "VALIDATION_ERROR");
  assert.equal((quote(ev, contract(), "yes", 20_000) as any).error.code, "VALIDATION_ERROR");
  assert.equal((quote(ev, contract({ marketState: "closed" }), "yes", 10) as any).error.code, "MARKET_CLOSED");
  assert.equal((quote(ev, contract({ yes: { buy: null, sell: null } }), "yes", 10) as any).error.code, "MARKET_CLOSED");
  assert.equal((quote(ev, contract(), "maybe" as any, 10) as any).error.code, "VALIDATION_ERROR");
});

test("what filled is read from filledQuantity: nothing is PRICE_MOVED, less is partial", () => {
  const q = quote(ev, contract(), "yes", 10);
  assert.ok(q.ok);
  assert.equal((readFill({ status: "cancelled", filledQuantity: "0" }, q.quote) as any).error.code, "PRICE_MOVED");
  const part = readFill({ status: "cancelled", filledQuantity: "5", avgExecutionPrice: "0.61", orderId: 9 }, q.quote);
  assert.ok(part.ok);
  assert.equal(part.fill.partial, true);
  assert.equal(part.fill.cost, "3.05");
  assert.equal(part.fill.orderId, "9");
  const full = readFill({ status: "filled", filledQuantity: "16.12", avgExecutionPrice: "0.62" }, q.quote);
  assert.ok(full.ok && !full.fill.partial);
});

test("a repeated clientOrderId gets the first answer for 10 minutes", () => {
  rememberOrder("u1", "order-aaaa-1", { ok: true, n: 1 }, 0);
  assert.deepEqual(seenOrder("u1", "order-aaaa-1", 60_000), { ok: true, n: 1 });
  assert.equal(seenOrder("u2", "order-aaaa-1", 60_000), undefined, "per user");
  assert.equal(seenOrder("u1", "order-aaaa-1", 11 * 60_000), undefined);
});

// ── token refresh ─────────────────────────────────────────────────────

const link = (expiresInMs: number): GeminiLink => ({
  id: "l1", env: "sandbox", accessToken: seal("old-access", KEY), refreshToken: seal("old-refresh", KEY),
  accessExpiresAt: new Date(Date.now() + expiresInMs), scopes: "orders:read",
} as GeminiLink);

const tokenClient = (answer: Awaited<ReturnType<OAuthClient["token"]>>): OAuthClient & { calls: Record<string, string>[] } => {
  const calls: Record<string, string>[] = [];
  return { calls, token: async (p) => { calls.push(p); return answer; }, revoke: async () => {} };
};

test("a token with time left is used as it is", async () => {
  const l = link(60 * 60_000);
  const client = tokenClient({ ok: false, invalidGrant: false, code: "X", detail: "" });
  const r = await liveToken(l, KEY, client, "sandbox");
  assert.deepEqual(r, { ok: true, token: "old-access", refreshed: false });
  assert.equal(client.calls.length, 0);
  assert.equal(needsRefresh(l), false);
});

test("a token about to expire is refreshed and both new tokens are stored sealed", async () => {
  const l = link(60_000);
  assert.equal(needsRefresh(l), true);
  const tokens = parseTokens({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 86399, scope: "orders:read,orders:create" })!;
  const client = tokenClient({ ok: true, tokens });
  const r = await liveToken(l, KEY, client, "sandbox");
  assert.deepEqual(r, { ok: true, token: "new-access", refreshed: true });
  assert.deepEqual(client.calls[0], { grant_type: "refresh_token", refresh_token: "old-refresh" });
  assert.equal(open(l.accessToken, KEY), "new-access");
  assert.equal(open(l.refreshToken, KEY), "new-refresh");
  assert.ok(!l.refreshToken.includes("new-refresh"), "stored sealed, not in the clear");
  assert.equal(l.scopes, "orders:read,orders:create");
});

test("a refresh Gemini refuses disconnects; an outage does not", async () => {
  const gone = await liveToken(link(0), KEY, tokenClient({ ok: false, invalidGrant: true, code: "GEMINI_AUTH_FAILED", detail: "invalid_grant" }), "sandbox");
  assert.deepEqual(gone, { ok: false, gone: true, code: "GEMINI_NOT_CONNECTED" });
  const down = await liveToken(link(0), KEY, tokenClient({ ok: false, invalidGrant: false, code: "GEMINI_UNAVAILABLE", detail: "" }), "sandbox");
  assert.deepEqual(down, { ok: false, gone: false, code: "GEMINI_UNAVAILABLE" });
  const wrongKey = await liveToken(link(0), randomBytes(32), tokenClient({ ok: false, invalidGrant: false, code: "X", detail: "" }), "sandbox");
  assert.equal((wrongKey as any).gone, true, "tokens the key cannot open are useless");
});

test("token answers without both tokens are refused", () => {
  assert.equal(parseTokens({ access_token: "a" }), null);
  const t = parseTokens({ access_token: "a", refresh_token: "r" }, 0)!;
  assert.equal(t.expiresAt.getTime(), 86_399_000, "24 hours when Gemini does not say");
});

// ── who may trade ─────────────────────────────────────────────────────

test("adults and guardians may use Pro markets; minors and unknowns may not", () => {
  assert.equal(canTradeMarkets({ audience: "adult" }), true);
  assert.equal(canTradeMarkets({ audience: "guardian" }), true);
  assert.equal(canTradeMarkets({ audience: "minor" }), false);
  assert.equal(canTradeMarkets({ audience: null }), false);
  assert.equal(canTradeMarkets(undefined), false);
  assert.equal(marketsGate({ audience: "adult" }, true), null);
  assert.equal(marketsGate({ audience: "adult" }, false)?.error.code, "MARKETS_NOT_ALLOWED");
  assert.equal(marketsGate({ audience: "minor" }, true)?.error.code, "MARKETS_NOT_ALLOWED");
});

// ── practice settlement ───────────────────────────────────────────────

test("practice settlement pays $1 a contract to the winning side, one notice per user and contract", async () => {
  const { settlementsFor } = await import("./practice.js");
  const fill = (id: string, user: string, symbol: string, outcome: "yes" | "no", qty: string) =>
    ({ id, user: { id: user }, symbol, outcome, qty, label: symbol === "S-DEN" ? "Denver" : "Phoenix" });
  const open = [
    fill("1", "a", "S-DEN", "yes", "10"),
    fill("2", "a", "S-DEN", "yes", "2.5"),
    fill("3", "b", "S-DEN", "no", "4"),
    fill("4", "b", "S-PHX", "yes", "3"),
    fill("5", "c", "S-OTHER", "yes", "1"),
  ];
  const out = settlementsFor(open, [
    { symbol: "S-DEN", resolutionSide: "yes" },
    { symbol: "S-PHX", resolutionSide: "no" },
    { symbol: "S-OTHER", resolutionSide: null },
  ]);
  const by = Object.fromEntries(out.map((s) => [`${s.userId}|${s.symbol}`, s]));
  assert.equal(out.length, 3, "c's contract has not resolved");
  assert.equal(by["a|S-DEN"].paidCents, 1250);
  assert.deepEqual(by["a|S-DEN"].fills.map((f) => f.id), ["1", "2"]);
  assert.equal(by["b|S-DEN"].paidCents, 0, "the losing side is paid nothing");
  assert.equal(by["b|S-PHX"].paidCents, 0);
  assert.equal(by["a|S-DEN"].label, "Denver");
});

test("pick history: one row per contract and side, newest first, with a won/lost record", async () => {
  const { practiceHistory, recordOf } = await import("./picks.js");
  const f = (symbol: string, outcome: "yes" | "no", costCents: number, payoutCents: number | null, at: number | null) =>
    ({ symbol, title: "DEN vs PHX", label: symbol, outcome, costCents, payoutCents, settledAt: at === null ? null : new Date(at) });
  const picks = practiceHistory([
    f("DEN", "yes", 650, 1000, 2000),
    f("DEN", "yes", 325, 500, 1500),
    f("PHX", "yes", 400, 0, 3000),
    f("KC", "yes", 500, null, null),   // still open: not history
  ]);
  assert.deepEqual(picks.map((p) => p.label), ["PHX", "DEN"]);
  assert.equal(picks[1].cost, "9.75");
  assert.equal(picks[1].payout, "15.00");
  assert.equal(picks[1].won, true);
  assert.equal(picks[0].won, false);
  assert.deepEqual(recordOf(picks), { won: 1, lost: 1, net: "1.25" });
});

test("a shared side's result: open until Gemini settles, then won or lost for that side", async () => {
  const { resultOf } = await import("./picks.js");
  assert.equal(resultOf(null, "yes"), null);
  assert.equal(resultOf(undefined, "no"), null);
  assert.equal(resultOf("yes", "yes"), "won");
  assert.equal(resultOf("yes", "no"), "lost");
  assert.equal(resultOf("no", "no"), "won");
  assert.equal(resultOf("no", "yes"), "lost");
});

// ── odds history ──────────────────────────────────────────────────────

const GAME = () => normalizeEvent(RAW_GAME, "basketball");

test("the recorded contracts are a game's moneyline sides and the lines a card shows", () => {
  const e = GAME();
  const ticks = ticksOf([e], Date.parse("2026-11-16T20:00:42Z"));
  const symbols = ticks.map((t) => t.symbol);
  for (const c of e.contracts.filter((x) => x.chance !== null)) assert.ok(symbols.includes(c.symbol));
  const shown = forList(e);
  for (const line of [shown.lines.spread, shown.lines.total]) {
    if (line?.contracts[0]?.chance != null) assert.ok(symbols.includes(line.contracts[0].symbol));
  }
  // Every tick sits on its minute, so two instances agree on the key.
  assert.ok(ticks.every((t) => t.at.toISOString() === "2026-11-16T20:00:00.000Z"));
});

test("odds are written only when a chance moves, and old points are pruned hourly", async () => {
  let now = Date.parse("2026-11-16T20:00:00Z");
  const written: Tick[][] = [];
  const pruned: Date[] = [];
  const rec = createOddsRecorder(async (t) => { written.push(t); }, async (d) => { pruned.push(d); }, () => now);
  const e = GAME();
  const first = await rec.record([e]);
  assert.ok(first > 0);
  assert.equal(await rec.record([e]), 0, "nothing moved, nothing written");
  const moved: PublicMarketEvent = { ...e, contracts: e.contracts.map((c, i) => (i === 0 ? { ...c, chance: (c.chance ?? 50) + 3 } : c)) };
  now += 60_000;
  assert.equal(await rec.record([moved]), 1, "only the contract that moved");
  assert.equal(written.length, 2);
  assert.equal(pruned.length, 1, "pruned once in the first hour");
  assert.equal(pruned[0].getTime(), Date.parse("2026-11-16T20:00:00Z") - KEEP_MS);
  now += 3600_000;
  await rec.record([moved]);
  assert.equal(pruned.length, 2);
});

test("a failed write is tried again on the next refresh", async () => {
  let fail = true;
  const rec = createOddsRecorder(async () => { if (fail) throw new Error("db down"); }, async () => {});
  await assert.rejects(rec.record([GAME()]));
  fail = false;
  assert.ok((await rec.record([GAME()])) > 0, "nothing was remembered as written");
});

test("the catalog tells its listeners about each fresh list, and a failing listener changes nothing", async () => {
  const { cat } = catalogWith(() => ({ status: 200, body: FIXTURE }));
  const seen: number[] = [];
  cat.onRefresh(() => { throw new Error("listener broke"); });
  cat.onRefresh((events) => { seen.push(events.length); });
  const listed = await cat.list("basketball");
  assert.ok(listed.ok);
  assert.deepEqual(seen, [listed.events.length]);
});

test("odds query parameters: GEMI symbols only, deduped and capped; hours 1-168", () => {
  assert.deepEqual(parseSymbols("GEMI-NBA-1-A,GEMI-NBA-1-A, BTC-USD,GEMI-x y,"), ["GEMI-NBA-1-A"]);
  assert.equal(parseSymbols(Array.from({ length: 200 }, (_, i) => `GEMI-E-${i}`).join(",")).length, 120);
  assert.deepEqual(parseSymbols(null), []);
  assert.equal(parseHours("6"), 6);
  for (const bad of [null, "0", "169", "2.5", "x"]) assert.equal(parseHours(bad), 24);
});

test("a side's chance: yes is the contract's, no is the rest", () => {
  assert.equal(sideChance({ chance: 62 }, "yes"), 62);
  assert.equal(sideChance({ chance: 62 }, "no"), 38);
  assert.equal(sideChance({ chance: null }, "no"), null);
});

// ── selling, activity and the portfolio (Your picks rail) ─────────────

test("a sale is priced at the bid rounded down, for what is held rounded down", async () => {
  const { sellQuote } = await import("./orders.js");
  const q = sellQuote(ev, contract({ yes: { buy: "0.62", sell: "0.617" }, quantityIncrement: "1" }), "yes", "10.5");
  assert.ok(q.ok);
  assert.equal(q.quote.price, "0.61");
  assert.equal(q.quote.qty, "10");
  assert.equal(q.quote.costCents, 610, "what the sale brings in, cents rounded down");
  assert.equal((sellQuote(ev, contract(), "yes", "0") as any).error.code, "NOTHING_TO_SELL");
  assert.equal((sellQuote(ev, contract({ yes: { buy: "0.62", sell: null } }), "yes", "5") as any).error.code, "MARKET_CLOSED");
  assert.equal((sellQuote(ev, contract({ marketState: "closed" }), "yes", "5") as any).error.code, "MARKET_CLOSED");
});

test("a partial sale keeps the average price; what is held carries its share of the cost", async () => {
  const { holdingOf } = await import("./practice.js");
  const h = holdingOf([
    { qty: "10", costCents: 420, side: "buy" },
    { qty: "10", costCents: 500, side: "buy" },
    { qty: "5", costCents: -300, side: "sell" },
  ]);
  assert.equal(h.held, toScaled("15"));
  assert.equal(h.avgPrice, "0.46");
  assert.equal(h.heldCostCents, 690, "15 of 20 contracts: 3/4 of $9.20");
  assert.equal(h.soldCents, 300);
  assert.equal(holdingOf([{ qty: "4", costCents: 200, side: "buy" }, { qty: "4", costCents: -260, side: "sell" }]).held, 0n);
});

test("settling a side that was partly sold pays only for the contracts still held", async () => {
  const { settlementsFor } = await import("./practice.js");
  const u = { id: "u1" };
  const [s] = settlementsFor(
    [
      { id: "b", symbol: "S", outcome: "yes", qty: "10", label: "A", side: "buy", user: u },
      { id: "s", symbol: "S", outcome: "yes", qty: "4", label: "A", side: "sell", user: u },
    ],
    [{ symbol: "S", resolutionSide: "yes" }],
  );
  assert.equal(s.paidCents, 600);
  assert.deepEqual(s.fills.map((f) => f.payoutCents), [1000, -400]);
});

test("a sold pick: in is the buys, back is the sale plus any payout; won only if more came back", async () => {
  const { practiceHistory } = await import("./picks.js");
  const at = new Date(5000);
  const row = (side: "buy" | "sell", costCents: number, payoutCents: number) =>
    ({ symbol: "GEMI-NFL-1-X", title: "X vs Y", label: "X", outcome: "yes" as const, side, costCents, payoutCents, settledAt: at });
  const [up] = practiceHistory([row("buy", 420, 0), row("sell", -550, 0)]);
  assert.equal(up.cost, "4.20");
  assert.equal(up.payout, "5.50");
  assert.equal(up.won, true);
  assert.equal(up.sold, true);
  assert.equal(up.league, "NFL");
  const [down] = practiceHistory([row("buy", 420, 0), row("sell", -300, 0)]);
  assert.equal(down.won, false);
});

test("a pick you sold out of counts in the net, not the won–lost record; one Gemini settled after a partial sale counts", async () => {
  const { practiceHistory, recordOf } = await import("./picks.js");
  const fill = (symbol: string, side: "buy" | "sell", costCents: number, payoutCents: number, createdMs: number, settledMs: number) =>
    ({ symbol, title: "X vs Y", label: symbol, outcome: "yes" as const, side, costCents, payoutCents, createdAt: new Date(createdMs), settledAt: new Date(settledMs) });
  const picks = practiceHistory([
    // Sold all of it: every fill settled the moment of the sale.
    fill("GEMI-NBA-1-A", "buy", 420, 0, 1_000, 500_000),
    fill("GEMI-NBA-1-A", "sell", -300, 0, 500_000, 500_000),
    // Sold half, held the rest; Gemini settled it a day later as a loss.
    fill("GEMI-NBA-2-B", "buy", 400, 0, 1_000, 90_000_000),
    fill("GEMI-NBA-2-B", "sell", -150, 0, 2_000, 90_000_000),
  ]);
  const by = Object.fromEntries(picks.map((p) => [p.label, p]));
  assert.equal(by["GEMI-NBA-1-A"].soldOut, true);
  assert.equal(by["GEMI-NBA-2-B"].soldOut, false);
  assert.equal(by["GEMI-NBA-2-B"].sold, true);
  assert.deepEqual(recordOf(picks), { won: 0, lost: 1, net: "-3.70" });
});

test("activity: buys and sales as money out and in; no settlement line for a position closed by a sale", async () => {
  const { practiceActivity } = await import("./activity.js");
  const t = (ms: number) => new Date(ms);
  const base = { title: "X vs Y", label: "X", outcome: "yes" as const, price: "0.42" };
  const items = practiceActivity([
    { ...base, symbol: "A", side: "buy", qty: "10", costCents: 420, payoutCents: 0, createdAt: t(1000), settledAt: t(3000) },
    { ...base, symbol: "A", side: "sell", qty: "10", costCents: -550, payoutCents: 0, createdAt: t(3000), settledAt: t(3000) },
    { ...base, symbol: "B", side: "buy", qty: "5", costCents: 200, payoutCents: 500, createdAt: t(2000), settledAt: t(4000) },
  ]);
  assert.deepEqual(items.map((i) => `${i.kind} ${i.symbol} ${i.amount}`), ["won B 5.00", "sell A 5.50", "buy B -2.00", "buy A -4.20"]);
});

test("portfolio: value is cash plus positions (cost when unpriced); ranges and thinning", async () => {
  const { accountValueCents, parseRange, thin, hourOf } = await import("./portfolio.js");
  assert.equal(accountValueCents({ usdAvailable: "84.20", positions: [{ value: "5.50", cost: "4.20" }, { value: null, cost: "7.60" }] }), 9730);
  assert.equal(accountValueCents({ usdAvailable: null, positions: [] }), null);
  assert.equal(parseRange("1m"), "1m");
  assert.equal(parseRange("5y"), "1w");
  const pts = Array.from({ length: 500 }, (_, i) => i);
  const t = thin(pts, 10);
  assert.equal(t.length, 10);
  assert.equal(t[0], 0);
  assert.equal(t[9], 499);
  assert.equal(hourOf(Date.UTC(2026, 10, 19, 15, 49, 30)).toISOString(), "2026-11-19T15:00:00.000Z");
});

test("a symbol or event ticker names its league from its prefix", async () => {
  const { leagueOf } = await import("./catalog.js");
  assert.equal(leagueOf("GEMI-NCAAM-2611200000-NE-BUT-M-NE"), "NCAA Men's");
  assert.equal(leagueOf("NFL-2611221625-KCBUF"), "NFL");
  assert.equal(leagueOf("GEMI-TEST-1-X"), null);
});

test("a sport's list keeps pro games when college games would fill it, still in start order", async () => {
  const { firstGames } = await import("./routes.js");
  const games = [
    ...Array.from({ length: 65 }, (_, i) => ({ id: `c${i}`, leagueCode: "NCAAF", start: i })),
    ...Array.from({ length: 4 }, (_, i) => ({ id: `n${i}`, leagueCode: "NFL", start: 100 + i })),
  ];
  const shown = firstGames(games);
  assert.equal(shown.length, 60);
  assert.equal(shown.filter((g) => g.leagueCode === "NFL").length, 4);
  assert.deepEqual(shown.map((g) => g.start), [...shown.map((g) => g.start)].sort((a, b) => a - b));
  assert.equal(firstGames(games.slice(0, 10)).length, 10);
});
