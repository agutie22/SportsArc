/**
 * The Pro markets catalog: Gemini's sports events for one of our sports,
 * reduced to what a card, the scoreboard strip and the trade sheet need.
 *
 * How Gemini lays it out (checked against the live API, 2026-11-16):
 *   - A game is a "moneyline" event whose contracts are the teams (soccer
 *     adds a draw). Its `events` hold the game's child markets: a point
 *     spread, a total and player props, each with many contracts (one per
 *     line, e.g. "More than 228.5 points scored").
 *   - An instrument symbol is GEMI-<event ticker>-<contract ticker>. Event
 *     tickers contain dashes, contract tickers do not.
 *   - Filters take plain parameters (sport=basketball); bracketed ones
 *     (sport[]=...) are silently ignored.
 *   - A full page is large (100 basketball games ≈ 4.5 MB, mostly props),
 *     so one fetch per sport is shared by everyone through a short cache.
 *
 * A contract can be bought only while its marketState is "open";
 * "post_only" contracts (most props) cannot take an immediate order and are
 * dropped.
 */

import type { GeminiClient, GeminiFailure } from "./gemini.js";
import { gemini, failure } from "./gemini.js";
import type { Sport } from "../entities/Game.js";

/** Our sports → Gemini's `sport` filter. Sports without one have no markets. */
export const SPORT_TO_GEMINI: Partial<Record<Sport, string>> = {
  basketball: "basketball",
  football: "american_football",
  soccer: "soccer",
  hockey: "hockey",
  baseball: "baseball",
  tennis: "tennis",
};

export const marketSports = (): string[] => Object.keys(SPORT_TO_GEMINI);
export const hasMarkets = (sport: string): boolean => sport in SPORT_TO_GEMINI;

/** Ticker prefix → the league name a card shows. Unlisted prefixes show as-is. */
const LEAGUES: Record<string, string> = {
  NBA: "NBA", WNBA: "WNBA", NCAAM: "NCAA Men's", NCAAW: "NCAA Women's",
  NFL: "NFL", NCAAF: "College Football", NHL: "NHL", MLB: "MLB",
  EPL: "Premier League", MLS: "MLS", LALIGA: "La Liga", LIGAMX: "Liga MX",
  UCL: "Champions League", SERIEA: "Serie A", BUNDESLIGA: "Bundesliga",
  ATP: "ATP", WTA: "WTA",
};

/**
 * The league a symbol ("GEMI-NBA-…") or event ticker ("NBA-…") belongs to,
 * from its prefix; null for a prefix we do not name. Settled picks use it,
 * since their event is often gone from the catalog.
 */
export function leagueOf(tickerOrSymbol: string): string | null {
  const code = tickerOrSymbol.replace(/^GEMI-/, "").split("-")[0] ?? "";
  return LEAGUES[code] ?? null;
}

export type MarketKind = "moneyline" | "spread" | "total" | "to_advance" | "prop" | "futures" | "other";
export type Outcome = "yes" | "no";

export interface PublicContract {
  symbol: string;
  /** Gemini's label, e.g. "Boston" or "More than 228.5 points scored". */
  label: string;
  /** What a button shows: "BOS", "Over 228.5", "Boston −4.5". */
  short: string;
  side: "home" | "away" | null;
  marketState: string;
  yes: { buy: string | null; sell: string | null };
  no: { buy: string | null; sell: string | null };
  /** 0–100: the middle of the yes bid and ask, else the last trade. */
  chance: number | null;
  priceIncrement: string;
  priceMinimum: string;
  quantityIncrement: string;
  quantityMinimum: string;
  resolutionSide: Outcome | null;
}

export interface PublicMarketEvent {
  ticker: string;
  /** The game's ticker when this is a child market (spread, total). */
  parentTicker: string | null;
  title: string;
  league: string;
  leagueCode: string;
  sport: string;
  kind: MarketKind;
  startsAt: string | null;
  volumeUsd: number;
  contracts: PublicContract[];
  /** For a game: its most even spread and total line, when Gemini lists them. */
  lines: { spread: PublicMarketEvent | null; total: PublicMarketEvent | null };
}

// ── normalizing ─────────────────────────────────────────────────────────

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const price = (v: unknown): string | null => {
  const s = str(v);
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 && n < 1 ? s : null;
};

const KINDS: readonly string[] = ["moneyline", "spread", "total", "to_advance", "prop", "futures"];

/**
 * The chance a card shows. The middle of bid and ask while the spread is
 * tight; on a thin market (spread over 10¢) the middle says little, so the
 * last trade is used instead when there is one.
 */
function chanceOf(bid: string | null, ask: string | null, last: string | null): number | null {
  if (bid && ask && (Number(ask) - Number(bid) <= 0.1 || !last)) {
    return Math.round(((Number(bid) + Number(ask)) / 2) * 100);
  }
  if (last) return Math.round(Number(last) * 100);
  if (ask) return Math.round(Number(ask) * 100);
  return null;
}

type Team = { name: string; abbr: string; side: string | null };

function shortLabel(kind: MarketKind, c: Record<string, any>, teams: Team[]): string {
  const strike = (c.strike ?? c.target ?? {}) as { type?: string; value?: string };
  const label = str(c.label) ?? str(c.ticker) ?? "";
  if (kind === "total" && strike.value) {
    const under = strike.type === "under" || strike.type === "under_or_equal";
    return `${under ? "Under" : "Over"} ${strike.value}`;
  }
  if (kind === "spread" && strike.value) {
    return `${str(c.abbreviatedName) ?? label} −${strike.value}`;
  }
  if (kind === "moneyline") {
    // A draw (soccer) has no side: its label ("Draw") reads better than "D".
    if (c.sportsSide !== "home" && c.sportsSide !== "away") return label;
    const team = teams.find((t) => t.side && t.side === c.sportsSide);
    return team?.abbr ?? str(c.abbreviatedName) ?? label;
  }
  return label;
}

function normalizeContract(c: Record<string, any>, kind: MarketKind, teams: Team[]): PublicContract {
  const p = (c.prices ?? {}) as Record<string, any>;
  const bid = price(p.bestBid);
  const ask = price(p.bestAsk);
  const last = price(p.lastTradePrice);
  const res = c.resolutionSide === "yes" || c.resolutionSide === "no" ? c.resolutionSide : null;
  return {
    symbol: String(c.instrumentSymbol ?? ""),
    label: str(c.label) ?? String(c.ticker ?? ""),
    short: shortLabel(kind, c, teams),
    side: c.sportsSide === "home" || c.sportsSide === "away" ? c.sportsSide : null,
    marketState: String(c.marketState ?? ""),
    yes: { buy: price(p.buy?.yes), sell: price(p.sell?.yes) },
    no: { buy: price(p.buy?.no), sell: price(p.sell?.no) },
    chance: chanceOf(bid, ask, last),
    priceIncrement: str(c.priceIncrement) ?? "0.01",
    priceMinimum: str(c.priceMinimum) ?? "0.01",
    quantityIncrement: str(c.quantityIncrement) ?? "1",
    quantityMinimum: str(c.quantityMinimum) ?? "1",
    resolutionSide: res,
  };
}

/** A side's chance, 0–100: yes is the contract's own, no is what is left. */
export function sideChance(c: Pick<PublicContract, "chance">, outcome: Outcome): number | null {
  if (c.chance === null) return null;
  return outcome === "yes" ? c.chance : 100 - c.chance;
}

const leagueCodeOf = (ticker: string): string => ticker.split("-")[0] ?? "";

/** The contract whose chance is closest to even: the line a card shows. */
function evenLine(event: PublicMarketEvent): PublicMarketEvent | null {
  const priced = event.contracts.filter((c) => c.chance !== null && c.yes.buy);
  if (priced.length === 0) return null;
  const best = priced.reduce((a, b) => (Math.abs(b.chance! - 50) < Math.abs(a.chance! - 50) ? b : a));
  return { ...event, contracts: [best] };
}

/**
 * One Gemini event → ours. `keepClosed` keeps contracts that can no longer
 * be bought (a settled game, for practice settlement).
 */
export function normalizeEvent(
  raw: Record<string, any>,
  sport: string,
  opts: { parentTicker?: string | null; keepClosed?: boolean } = {},
): PublicMarketEvent {
  const ticker = String(raw.ticker ?? "");
  const sm = (raw.sportsMarket ?? {}) as Record<string, any>;
  const kind = (KINDS.includes(sm.type) ? sm.type : "other") as MarketKind;
  const teams: Team[] = Array.isArray(raw.participants)
    ? raw.participants.map((p: Record<string, any>) => ({
      name: String(p.name ?? ""),
      abbr: String(p.abbreviation ?? p.name ?? ""),
      side: str(p.side),
    }))
    : [];
  const contracts = (Array.isArray(raw.contracts) ? raw.contracts : [])
    .filter((c: Record<string, any>) => opts.keepClosed || (c.marketState === "open" && c.status === "active"))
    .map((c: Record<string, any>) => normalizeContract(c, kind, teams))
    .filter((c: PublicContract) => c.symbol);

  if (kind === "moneyline") {
    // Away team first, as a scoreboard reads; then a draw if there is one.
    const order = (c: PublicContract) => (c.side === "away" ? 0 : c.side === "home" ? 1 : 2);
    contracts.sort((a: PublicContract, b: PublicContract) => order(a) - order(b));
  } else if (kind === "futures") {
    contracts.sort((a: PublicContract, b: PublicContract) => (b.chance ?? -1) - (a.chance ?? -1));
  }

  const code = leagueCodeOf(ticker);
  const event: PublicMarketEvent = {
    ticker,
    parentTicker: opts.parentTicker ?? null,
    title: String(raw.title ?? ticker),
    league: LEAGUES[code] ?? str(raw.subcategory?.name) ?? code,
    leagueCode: code,
    sport,
    kind,
    startsAt: str(raw.startTime) ?? str(raw.effectiveDate),
    volumeUsd: num(raw.volume),
    contracts,
    lines: { spread: null, total: null },
  };

  if (!opts.parentTicker && Array.isArray(raw.events)) {
    for (const kid of raw.events as Record<string, any>[]) {
      const t = kid.sportsMarket?.type;
      if (t !== "spread" && t !== "total") continue;
      const child = normalizeEvent(kid, sport, { parentTicker: ticker, keepClosed: opts.keepClosed });
      event.lines[t as "spread" | "total"] = child;
    }
  }
  return event;
}

/** A smaller copy for lists: each child market down to its most even line. */
export function forList(e: PublicMarketEvent): PublicMarketEvent {
  return {
    ...e,
    lines: {
      spread: e.lines.spread ? evenLine(e.lines.spread) : null,
      total: e.lines.total ? evenLine(e.lines.total) : null,
    },
  };
}

/** "GEMI-NBA-2611170000-ORL-BOS-T-O183" → "NBA-2611170000-ORL-BOS-T". */
export function eventTickerOf(symbol: string): string | null {
  if (!symbol.startsWith("GEMI-")) return null;
  const last = symbol.lastIndexOf("-");
  return last > 5 ? symbol.slice(5, last) : null;
}

// ── the cache ───────────────────────────────────────────────────────────

export const FRESH_MS = 20_000;
export const STALE_MS = 5 * 60_000;
export const GAME_OVER_MS = 4 * 3600_000;
/** Scopes that are the whole game, as opposed to a quarter, half or period. */
const WHOLE_GAME: ReadonlySet<string> = new Set(["full_contest", "regulation"]);
const PAGE = 100;

interface Entry {
  at: number;
  events: PublicMarketEvent[] | null;
  inflight: Promise<void> | null;
}

export interface Catalog {
  list(sport: string): Promise<{ ok: true; events: PublicMarketEvent[]; updatedAt: string } | GeminiFailure>;
  /** Refresh a sport's list now if it is no longer fresh; used by the warmer. */
  warm(sport: string): Promise<void>;
  /** Sports someone listed within `ms`, most recent first. */
  recentlyViewed(ms: number): string[];
  /** Call `fn` with each sport's list whenever it is fetched fresh (history.ts records odds from it). */
  onRefresh(fn: (events: PublicMarketEvent[]) => unknown): void;
  event(ticker: string, opts?: { fresh?: boolean }): Promise<{ ok: true; event: PublicMarketEvent } | GeminiFailure>;
  contract(symbol: string, opts?: { fresh?: boolean }):
    Promise<{ ok: true; event: PublicMarketEvent; contract: PublicContract } | GeminiFailure>;
}

/** Every event, child markets included, by ticker. */
function index(events: PublicMarketEvent[], into: Map<string, PublicMarketEvent>): void {
  for (const e of events) {
    into.set(e.ticker, e);
    if (e.lines.spread) into.set(e.lines.spread.ticker, e.lines.spread);
    if (e.lines.total) into.set(e.lines.total.ticker, e.lines.total);
  }
}

export function createCatalog(client: () => GeminiClient = gemini, now: () => number = Date.now): Catalog {
  const bySport = new Map<string, Entry>();
  const byTicker = new Map<string, { at: number; event: PublicMarketEvent }>();
  const viewed = new Map<string, number>();
  const listeners: ((events: PublicMarketEvent[]) => unknown)[] = [];

  const entryFor = (sport: string): Entry => {
    let entry = bySport.get(sport);
    if (!entry) {
      entry = { at: 0, events: null, inflight: null };
      bySport.set(sport, entry);
    }
    return entry;
  };

  const refresh = async (sport: string, entry: Entry): Promise<void> => {
    const g = SPORT_TO_GEMINI[sport as Sport]!;
    const res = await client().publicGet<{ data?: unknown[] }>("/v1/prediction-markets/events", {
      category: "sports", sport: g, sports_market_type: "moneyline", status: "active", limit: PAGE,
    });
    if (!res.ok) {
      console.warn(`[markets] could not refresh ${sport}: ${res.error.code} ${res.error.detail ?? ""}`);
      return;
    }
    const raw = Array.isArray(res.data?.data) ? res.data.data as Record<string, any>[] : [];
    // Gemini keeps a game "active" until it settles, often a day after it
    // was played. A game that started over 4 hours ago is over.
    const oldest = now() - GAME_OVER_MS;
    // Gemini also lists quarter and half moneylines under each game (e.g.
    // "1st Quarter Moneyline"), most with no prices; a game card is the
    // whole game only (soccer's is "regulation", the 90 minutes), and only
    // when someone can buy a side.
    const events = raw
      .filter((r) => WHOLE_GAME.has(r.sportsMarket?.scope?.type ?? "full_contest"))
      .map((r) => normalizeEvent(r, sport))
      .filter((e) => e.contracts.some((c) => c.yes.buy) && (!e.startsAt || Date.parse(e.startsAt) > oldest))
      .sort((a, b) => (a.startsAt ?? "").localeCompare(b.startsAt ?? "") || b.volumeUsd - a.volumeUsd);
    entry.events = events;
    entry.at = now();
    const t = now();
    const tickers = new Map<string, PublicMarketEvent>();
    index(events, tickers);
    for (const [k, e] of tickers) byTicker.set(k, { at: t, event: e });
    // Not awaited: a slow listener (a database write) never delays a list
    // someone is waiting on, and one that fails never breaks a refresh.
    for (const fn of listeners) {
      try { void Promise.resolve(fn(events)).catch(() => {}); } catch { /* see above */ }
    }
  };

  const list: Catalog["list"] = async (sport) => {
    if (!hasMarkets(sport)) return failure("UNKNOWN_SPORT", `No markets for ${sport}.`, true);
    viewed.set(sport, now());
    const entry = entryFor(sport);
    if (now() - entry.at >= FRESH_MS) {
      entry.inflight ??= refresh(sport, entry).finally(() => { entry.inflight = null; });
      // Wait only when there is nothing fresh enough to show meanwhile.
      if (!entry.events || now() - entry.at >= STALE_MS) await entry.inflight;
    }
    if (!entry.events || now() - entry.at >= STALE_MS) {
      return failure("MARKETS_UNAVAILABLE", "Gemini market data is unavailable.");
    }
    return { ok: true, events: entry.events, updatedAt: new Date(entry.at).toISOString() };
  };

  const event: Catalog["event"] = async (ticker, opts = {}) => {
    const hit = byTicker.get(ticker);
    if (hit && !opts.fresh && now() - hit.at < FRESH_MS) return { ok: true, event: hit.event };
    const res = await client().publicGet<Record<string, any>>(`/v1/prediction-markets/events/${encodeURIComponent(ticker)}`);
    if (!res.ok) {
      if (hit && !opts.fresh && now() - hit.at < STALE_MS) return { ok: true, event: hit.event };
      return res;
    }
    const raw = (res.data?.data ?? res.data) as Record<string, any>;
    if (!raw || typeof raw.ticker !== "string") return failure("MARKET_NOT_FOUND", ticker, true);
    const sport = Object.entries(SPORT_TO_GEMINI).find(([, g]) => g === raw.sportsMarket?.sport)?.[0] ?? "other";
    const parent = hit?.event.parentTicker ?? null;
    const e = normalizeEvent(raw, sport, { parentTicker: parent, keepClosed: true });
    const t = now();
    const tickers = new Map<string, PublicMarketEvent>();
    index([e], tickers);
    for (const [k, v] of tickers) byTicker.set(k, { at: t, event: v });
    return { ok: true, event: e };
  };

  const contract: Catalog["contract"] = async (symbol, opts = {}) => {
    const ticker = eventTickerOf(symbol);
    if (!ticker) return failure("MARKET_NOT_FOUND", symbol, true);
    const found = await event(ticker, opts);
    if (!found.ok) return found;
    const c = found.event.contracts.find((x) => x.symbol === symbol);
    if (!c) return failure("MARKET_NOT_FOUND", symbol, true);
    return { ok: true, event: found.event, contract: c };
  };

  const warm: Catalog["warm"] = async (sport) => {
    if (!hasMarkets(sport)) return;
    const entry = entryFor(sport);
    if (now() - entry.at < FRESH_MS) return;
    entry.inflight ??= refresh(sport, entry).finally(() => { entry.inflight = null; });
    await entry.inflight;
  };

  const recentlyViewed: Catalog["recentlyViewed"] = (ms) =>
    [...viewed.entries()].filter(([, at]) => now() - at < ms).sort((a, b) => b[1] - a[1]).map(([s]) => s);

  const onRefresh: Catalog["onRefresh"] = (fn) => { listeners.push(fn); };

  return { list, event, contract, warm, recentlyViewed, onRefresh };
}

/** The most-traded game starting next: the timeline's headline. */
export function headline(events: PublicMarketEvent[], now = Date.now()): PublicMarketEvent | null {
  const soon = events.filter((e) => {
    if (e.kind !== "moneyline" || !e.startsAt) return false;
    const until = Date.parse(e.startsAt) - now;
    return until > -3 * 3600_000 && until < 36 * 3600_000;
  });
  let pool = soon.length ? soon : events.filter((e) => e.kind === "moneyline");
  // A pro game beats a college one; then a close game beats a lopsided one.
  const pro = pool.filter((e) => PRO_LEAGUES.has(e.leagueCode));
  if (pro.length) pool = pro;
  const close = pool.filter((e) => e.contracts.every((c) => c.chance === null || (c.chance >= 20 && c.chance <= 80)));
  if (close.length) pool = close;
  if (pool.length === 0) return null;
  return pool.reduce((a, b) => (b.volumeUsd > a.volumeUsd ? b : a));
}

/**
 * A college team's next game (or the one on now), for "Tonight on Gemini"
 * when the viewer picked a team (api/teams/catalog.ts). Gemini labels a
 * college side by its school ("Ohio State"), which is ESPN's `location`.
 */
export function teamGame(events: PublicMarketEvent[], school: string, now = Date.now()): PublicMarketEvent | null {
  const want = school.trim().toLowerCase();
  const games = events.filter((e) => e.kind === "moneyline" && e.leagueCode === "NCAAF"
    && (!e.startsAt || Date.parse(e.startsAt) > now - 4 * 3600_000)
    && e.contracts.some((c) => c.label.trim().toLowerCase() === want));
  games.sort((a, b) => Date.parse(a.startsAt ?? "") - Date.parse(b.startsAt ?? ""));
  return games[0] ?? null;
}

/** Leagues the headline and the strip put first. */
export const PRO_LEAGUES: ReadonlySet<string> = new Set([
  "NBA", "WNBA", "NFL", "NHL", "MLB", "EPL", "MLS", "LALIGA", "LIGAMX", "UCL", "SERIEA", "BUNDESLIGA", "ATP", "WTA",
]);

let shared: Catalog | null = null;

export function catalog(): Catalog {
  shared ??= createCatalog();
  return shared;
}
