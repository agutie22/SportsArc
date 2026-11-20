/**
 * Pro markets HTTP routes: Gemini sports markets on the sport pages.
 *
 *   GET  /api/markets/me               the account card: allowed? connected? balance, positions
 *   GET  /api/markets?sport=           a sport's markets and its headline game
 *   GET  /api/markets/featured         each sport's featured game and next games (ALL, Home's band)
 *   GET  /api/markets/following        picks people you follow posted (Home › Markets)
 *   GET  /api/markets/history          your settled picks and record (Home › Markets › Your picks)
 *   GET  /api/markets/odds?symbols=    odds over time for the cards on screen (history.ts)
 *   GET  /api/markets/event/:ticker    one event
 *   POST /api/markets/quote            dollars → contracts at the current price
 *   POST /api/markets/order            buy (practice, or the user's Gemini account)
 *   POST /api/markets/sell             sell all of one side you hold, at the bid
 *   GET  /api/markets/activity         buys, sales and settlements (Your picks rail)
 *   GET  /api/markets/portfolio?range= the account's value over 1d|1w|1m|all
 *   POST /api/markets/seen             settled picks up to now are seen ("Needs you")
 *   GET  /api/markets/terms            Gemini's prediction market terms
 *   POST /api/markets/terms/accept     accept them on the user's Gemini account
 *   GET  /api/markets/connect?sport=   start connecting a Gemini account (302 to Gemini)
 *   GET  /api/markets/callback         Gemini sends the user back here (302 to the sport page)
 *   POST /api/markets/disconnect       forget the Gemini account
 *
 * Every route needs a signed-in adult (access.ts). /me is the one that
 * answers a minor, with { allowed: false } and nothing else, so the client
 * knows to hide every market surface.
 */

import type { ServerResponse } from "node:http";
import { parseCookies } from "../auth/session.js";
import { authed, json, parseJsonBody } from "../http.js";
import { log } from "../ops/log.js";
import { get, post } from "../router.js";
import { marketsStatus } from "../routes/status.js";
import { fail } from "../failure.js";
import { canTradeMarkets, marketsGate } from "./access.js";
import { accountSummary, readPositions } from "./account.js";
import { activity } from "./activity.js";
import { catalog, forList, hasMarkets, headline, marketSports, PRO_LEAGUES, teamGame } from "./catalog.js";
import { teamByKey } from "../teams/catalog.js";
import { config } from "./config.js";
import { gemini } from "./gemini.js";
import { GeminiLink } from "./GeminiLink.js";
import { oddsSeries, parseHours, parseSymbols } from "./history.js";
import { accountFor, authorizeUrl, disconnect, exchangeCode, saveLink } from "./oauth.js";
import { fromScaled, isClientOrderId, placeOrder, quote, rememberOrder, seenOrder, sellQuote, toScaled } from "./orders.js";
import { followingPicks, pickHistory } from "./picks.js";
import { accountValueCents, markSeen, parseRange, portfolioSeries, recordSnapshot, seenAt } from "./portfolio.js";
import { holdingOf, placePractice, placePracticeSell } from "./practice.js";
import { PracticeFill } from "./PracticeFill.js";
import { clearStateCookie, newState, openState, setStateCookie, STATE_COOKIE } from "./state.js";

const LIST_MAX = 60;

/**
 * The games a sport's list shows: at most LIST_MAX, pro leagues kept
 * before college ones (a Saturday of college games would otherwise push
 * every NFL game off a list sorted by start), still in start order.
 */
export function firstGames<T extends { leagueCode: string }>(events: T[]): T[] {
  if (events.length <= LIST_MAX) return events;
  const kept = new Set([
    ...events.filter((e) => PRO_LEAGUES.has(e.leagueCode)),
    ...events.filter((e) => !PRO_LEAGUES.has(e.leagueCode)),
  ].slice(0, LIST_MAX));
  return events.filter((e) => kept.has(e));
}

function redirect(res: ServerResponse, location: string): void {
  res.statusCode = 302;
  res.setHeader("Location", location);
  res.setHeader("Cache-Control", "no-store");
  res.end();
}

const sportOr = (v: string | null | undefined, fallback = "basketball"): string =>
  v && hasMarkets(v) ? v : fallback;

get("/api/markets/me", authed(async ({ res }, { user, fork }) => {
  if (!canTradeMarkets(user)) {
    json(res, 200, { ok: true, account: { allowed: false } });
    return;
  }
  const cfg = config();
  if (!cfg.enabled) {
    json(res, 200, { ok: true, account: { allowed: true, enabled: false } });
    return;
  }
  const account = await accountSummary(fork, user, catalog(), gemini(), cfg);
  // Keep the hour's value for the Portfolio line; a failed write never costs the answer.
  const value = account.connected ? accountValueCents(account) : null;
  if (value !== null) {
    await recordSnapshot(fork, user.id, value).catch((err) => log.warn("portfolio snapshot failed", { userId: user.id, err }));
  }
  json(res, 200, { ok: true, account });
}));

get("/api/markets", authed(async ({ res, query }, { user }) => {
  const denied = marketsGate(user);
  if (denied) return json(res, marketsStatus(denied), denied);
  const sport = query.get("sport") ?? "";
  const listed = await catalog().list(sport);
  if (!listed.ok) return json(res, marketsStatus(listed), listed);
  json(res, 200, {
    ok: true,
    sport,
    events: firstGames(listed.events).map(forList),
    headline: (() => { const h = headline(listed.events); return h ? forList(h) : null; })(),
    updatedAt: listed.updatedAt,
  });
}));

/** Games per sport the strip under ALL mixes together. */
const ALL_STRIP_PER_SPORT = 6;

/**
 * For ALL: each sport's featured game and how many games it has (the
 * Markets view), and its next few games, pro leagues first (the strip).
 * `team` is the viewer's team's next game, when they picked a college
 * team and Gemini lists it ("Tonight on Gemini" puts it first).
 */
get("/api/markets/featured", authed(async ({ res }, { user }) => {
  const denied = marketsGate(user);
  if (denied) return json(res, marketsStatus(denied), denied);
  const lists = await Promise.all(marketSports().map(async (sport) => ({ sport, listed: await catalog().list(sport) })));
  const sports = lists.flatMap(({ sport, listed }) => {
    if (!listed.ok) return [];
    const h = headline(listed.events);
    if (!h) return [];
    const games = listed.events.filter((e) => e.kind === "moneyline" && e.contracts.length >= 2);
    const upcoming = [...games.filter((e) => PRO_LEAGUES.has(e.leagueCode)), ...games.filter((e) => !PRO_LEAGUES.has(e.leagueCode))]
      .slice(0, ALL_STRIP_PER_SPORT)
      .map((e) => ({ ...e, lines: { spread: null, total: null } }));
    return [{ sport, count: listed.events.length, headline: forList(h), upcoming }];
  });
  const team = teamByKey(user.teamKey);
  const football = lists.find((l) => l.sport === "football")?.listed;
  const game = team && football?.ok ? teamGame(football.events, team.school) : null;
  json(res, 200, {
    ok: true,
    sports,
    team: game && team ? { key: team.key, school: team.school, game: { ...game, lines: { spread: null, total: null } } } : null,
  });
}));

/** Picks people the viewer follows chose to post (Home › Markets); see picks.ts. */
get("/api/markets/following", authed(async ({ res }, { user, fork }) => {
  const denied = marketsGate(user);
  if (denied) return json(res, marketsStatus(denied), denied);
  json(res, 200, { ok: true, picks: await followingPicks(fork, user, catalog()) });
}));

/** The viewer's own settled picks and their record (Home › Markets › Your picks). */
get("/api/markets/history", authed(async ({ res }, { user, fork }) => {
  const denied = marketsGate(user);
  if (denied) return json(res, marketsStatus(denied), denied);
  const [history, seen] = await Promise.all([pickHistory(fork, user, gemini(), config()), seenAt(fork, user.id)]);
  json(res, 200, { ok: true, ...history, seenAt: seen });
}));

/** Buys, sales and settlements, newest first (the Activity card); see activity.ts. */
get("/api/markets/activity", authed(async ({ res }, { user, fork }) => {
  const denied = marketsGate(user);
  if (denied) return json(res, marketsStatus(denied), denied);
  json(res, 200, { ok: true, items: await activity(fork, user, gemini(), config()) });
}));

/** The account's value over a range (the Portfolio card); see portfolio.ts. */
get("/api/markets/portfolio", authed(async ({ res, query }, { user, fork }) => {
  const denied = marketsGate(user);
  if (denied) return json(res, marketsStatus(denied), denied);
  const range = parseRange(query.get("range"));
  json(res, 200, { ok: true, range, points: await portfolioSeries(fork, user.id, range) });
}));

/** Settled picks up to now are seen: "Needs you" stops listing them. */
post("/api/markets/seen", authed(async ({ res }, { user, fork }) => {
  const denied = marketsGate(user);
  if (denied) return json(res, marketsStatus(denied), denied);
  json(res, 200, { ok: true, seenAt: await markSeen(fork, user.id) });
}));

/**
 * Odds over time for the cards on screen (history.ts):
 * ?symbols=GEMI-…,GEMI-…&hours=24 → { series: { symbol: [[unixSec, chance], …] } }.
 */
get("/api/markets/odds", authed(async ({ res, query }, { user, fork }) => {
  const denied = marketsGate(user);
  if (denied) return json(res, marketsStatus(denied), denied);
  const symbols = parseSymbols(query.get("symbols"));
  const hours = parseHours(query.get("hours"));
  json(res, 200, { ok: true, hours, series: await oddsSeries(fork, symbols, hours) });
}));

get("/api/markets/event/:ticker", authed(async ({ res, params }, { user }) => {
  const denied = marketsGate(user);
  if (denied) return json(res, marketsStatus(denied), denied);
  const found = await catalog().event(params.ticker);
  if (!found.ok) return json(res, marketsStatus(found), found);
  json(res, 200, { ok: true, event: found.event });
}));

interface BuyBody { symbol?: unknown; outcome?: unknown; dollars?: unknown; clientOrderId?: unknown }

const outcomeOf = (v: unknown): "yes" | "no" | null => (v === "yes" || v === "no" ? v : null);

post("/api/markets/quote", authed(async ({ req, res }, { user }) => {
  const denied = marketsGate(user);
  if (denied) return json(res, marketsStatus(denied), denied);
  const body = await parseJsonBody<BuyBody>(req, res);
  if (body === null) return;
  const outcome = outcomeOf(body.outcome);
  if (typeof body.symbol !== "string" || !outcome) {
    return json(res, 400, fail("VALIDATION_ERROR", "Pick a market and a side."));
  }
  const found = await catalog().contract(body.symbol);
  if (!found.ok) return json(res, marketsStatus(found), found);
  const q = quote(found.event, found.contract, outcome, Number(body.dollars));
  json(res, marketsStatus(q), q);
}));

post("/api/markets/order", authed(async ({ req, res }, { user, fork }) => {
  const denied = marketsGate(user);
  if (denied) return json(res, marketsStatus(denied), denied);
  const body = await parseJsonBody<BuyBody>(req, res);
  if (body === null) return;
  const outcome = outcomeOf(body.outcome);
  if (typeof body.symbol !== "string" || !outcome || !isClientOrderId(body.clientOrderId)) {
    return json(res, 400, fail("VALIDATION_ERROR", "Pick a market, a side and an amount."));
  }
  const clientOrderId = body.clientOrderId;
  const again = seenOrder<Record<string, unknown>>(user.id, clientOrderId);
  if (again) return json(res, marketsStatus(again as { ok: boolean }), again);

  const cfg = config();
  // Price the order on fresh data, never on a cached page.
  const found = await catalog().contract(body.symbol, { fresh: true });
  if (!found.ok) return json(res, marketsStatus(found), found);
  const q = quote(found.event, found.contract, outcome, Number(body.dollars));
  if (!q.ok) return json(res, marketsStatus(q), q);

  let result;
  if (cfg.trading === "practice") {
    result = await placePractice(fork, user, q.quote, found.event.sport, clientOrderId);
  } else {
    const account = await accountFor(fork, user, cfg);
    result = account.ok ? await placeOrder(gemini(), account.auth, q.quote, clientOrderId) : account;
  }
  const answer = result.ok
    ? { ok: true, practice: cfg.trading === "practice", fill: result.fill, quote: q.quote }
    : { ...result, quote: q.quote };
  if (result.ok || result.error.code !== "PRICE_MOVED") rememberOrder(user.id, clientOrderId, answer);
  log.info(result.ok ? "market order filled" : "market order refused", {
    userId: user.id,
    symbol: q.quote.symbol,
    outcome,
    qty: result.ok ? result.fill.qty : q.quote.qty,
    trading: cfg.trading,
    ...(result.ok ? {} : { error: result.error.code }),
  });
  json(res, marketsStatus(answer as { ok: boolean; error?: { code: string } }), answer);
}));

interface SellBody { symbol?: unknown; outcome?: unknown; clientOrderId?: unknown; part?: unknown }

/**
 * Sell all of one side the user holds, or half of it (`part: "half"`), at
 * the bid now. How much is held comes from the server (practice fills, or
 * the Gemini account's positions), never from the client.
 */
post("/api/markets/sell", authed(async ({ req, res }, { user, fork }) => {
  const denied = marketsGate(user);
  if (denied) return json(res, marketsStatus(denied), denied);
  const body = await parseJsonBody<SellBody>(req, res);
  if (body === null) return;
  const outcome = outcomeOf(body.outcome);
  if (typeof body.symbol !== "string" || !outcome || !isClientOrderId(body.clientOrderId)) {
    return json(res, 400, fail("VALIDATION_ERROR", "Pick the position to sell."));
  }
  const clientOrderId = body.clientOrderId;
  // Half rounds down to the contract's step in sellQuote; less than its minimum is refused there.
  const part = (held: bigint | null) => fromScaled(body.part === "half" ? (held ?? 0n) / 2n : held ?? 0n);
  const again = seenOrder<Record<string, unknown>>(user.id, clientOrderId);
  if (again) return json(res, marketsStatus(again as { ok: boolean }), again);

  const cfg = config();
  if (cfg.trading === "off") return json(res, 403, fail("MARKETS_NOT_ALLOWED", "Pro markets are not switched on."));
  const found = await catalog().contract(body.symbol, { fresh: true });
  if (!found.ok) return json(res, marketsStatus(found), found);

  let result;
  let q;
  if (cfg.trading === "practice") {
    const open = await fork.find(PracticeFill, { user: user.id, symbol: body.symbol, outcome, settledAt: null });
    q = sellQuote(found.event, found.contract, outcome, part(holdingOf(open).held));
    result = q.ok ? await placePracticeSell(fork, user, q.quote, found.event.sport, clientOrderId) : q;
  } else {
    const account = await accountFor(fork, user, cfg);
    if (!account.ok) return json(res, marketsStatus(account), account);
    const listed = await gemini().privatePost(account.auth, "/v1/prediction-markets/positions", {}, { limit: 50 });
    const held = listed.ok
      ? (await readPositions(listed.data, catalog())).find((p) => p.symbol === body.symbol && p.outcome === outcome)?.qty ?? "0"
      : "0";
    q = sellQuote(found.event, found.contract, outcome, part(toScaled(held)));
    result = q.ok ? await placeOrder(gemini(), account.auth, q.quote, clientOrderId, "sell") : q;
  }
  const answer = result.ok
    ? { ok: true, practice: cfg.trading === "practice", fill: result.fill, closed: "closed" in result ? result.closed : null, quote: q.ok ? q.quote : null }
    : { ...result, quote: q.ok ? q.quote : null };
  if (result.ok || result.error.code !== "PRICE_MOVED") rememberOrder(user.id, clientOrderId, answer);
  log.info(result.ok ? "market sale filled" : "market sale refused", {
    userId: user.id,
    symbol: body.symbol,
    outcome,
    qty: result.ok ? result.fill.qty : q.ok ? q.quote.qty : null,
    trading: cfg.trading,
    ...(result.ok ? {} : { error: result.error.code }),
  });
  json(res, marketsStatus(answer as { ok: boolean; error?: { code: string } }), answer);
}));

get("/api/markets/terms", authed(async ({ res }, { user }) => {
  const denied = marketsGate(user);
  if (denied) return json(res, marketsStatus(denied), denied);
  if (config().trading === "practice") {
    json(res, 200, { ok: true, terms: { version: "practice", content: null } });
    return;
  }
  const t = await gemini().publicGet<{ version?: string; content?: string }>("/v1/prediction-markets/terms");
  if (!t.ok) return json(res, marketsStatus(t), t);
  json(res, 200, {
    ok: true,
    terms: { version: String(t.data?.version ?? ""), content: String(t.data?.content ?? "").slice(0, 100_000) },
  });
}));

post("/api/markets/terms/accept", authed(async ({ res }, { user, fork }) => {
  const denied = marketsGate(user);
  if (denied) return json(res, marketsStatus(denied), denied);
  const cfg = config();
  if (cfg.trading === "practice") return json(res, 200, { ok: true });
  const account = await accountFor(fork, user, cfg);
  if (!account.ok) return json(res, marketsStatus(account), account);
  const done = await gemini().privatePost<{ success?: boolean }>(account.auth, "/v1/prediction-markets/terms/accept");
  if (!done.ok) return json(res, marketsStatus(done), done);
  const status = await gemini().privatePost<{ acceptedVersion?: string }>(account.auth, "/v1/prediction-markets/terms/status");
  if (account.link && status.ok) {
    await fork.nativeUpdate(GeminiLink, { id: account.link.id }, { termsVersion: String(status.data?.acceptedVersion ?? "") || null });
  }
  log.info("gemini terms accepted", { userId: user.id });
  json(res, 200, { ok: true });
}));

get("/api/markets/connect", authed(async ({ res, query }, { user }) => {
  const cfg = config();
  const sport = sportOr(query.get("sport"));
  const denied = marketsGate(user);
  if (denied || cfg.trading !== "oauth") {
    return redirect(res, `/#/sport/${sport}?gemini=error&code=${denied ? "MARKETS_NOT_ALLOWED" : "NOT_OAUTH"}`);
  }
  const state = newState(user.id, sport);
  setStateCookie(res, state);
  redirect(res, authorizeUrl(state.n, state.v, cfg));
}));

get("/api/markets/callback", authed(async ({ req, res, query }, { user, fork }) => {
  const cfg = config();
  const state = openState(parseCookies(req)[STATE_COOKIE], user.id);
  clearStateCookie(res);
  const sport = sportOr(state?.s);
  const back = (code?: string) => redirect(res, `/#/sport/${sport}?gemini=${code ? `error&code=${code}` : "connected"}`);

  if (marketsGate(user) || cfg.trading !== "oauth") return back("MARKETS_NOT_ALLOWED");
  if (!state || query.get("state") !== state.n) return back("STATE_MISMATCH");
  if (query.get("error")) return back("DECLINED");
  const code = query.get("code");
  if (!code) return back("NO_CODE");

  const tokens = await exchangeCode(code, state.v);
  if (!tokens.ok) {
    log.warn("gemini connect failed", { userId: user.id, error: tokens.code, detail: tokens.detail });
    return back(tokens.code);
  }
  await saveLink(fork, user, tokens.tokens, cfg);
  log.info("gemini connected", { userId: user.id, env: cfg.env });
  back();
}));

post("/api/markets/disconnect", authed(async ({ res }, { user, fork }) => {
  await disconnect(fork, user);
  log.info("gemini disconnected", { userId: user.id });
  json(res, 200, { ok: true });
}));
