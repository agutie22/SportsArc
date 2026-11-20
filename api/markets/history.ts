/**
 * Odds over time: how each game's chances move, recorded as the catalog
 * refreshes and read back as a series for the sparkline on a market card.
 *
 *   recordOdds   called with every fresh list (catalog onRefresh). Keeps the
 *                last chance written per contract in memory and writes a
 *                MarketTick only when it changed; a restart writes each
 *                contract once more, which the unique minute absorbs.
 *   oddsSeries   the points for some symbols over the last `hours`, with
 *                the point just before the window so a line starts at the
 *                left edge instead of wherever the first change fell.
 *
 * What is recorded: every whole-game moneyline contract, and the even line
 * of each game's spread and total (the one a card shows). Props never.
 * Points older than KEEP_MS are deleted at most once an hour.
 *
 * Prices are Gemini's own; nothing here is ours. Reading the series goes
 * through the same adults-only gate as every market route (routes.ts).
 */

import { randomUUID } from "node:crypto";
import type { EntityManager } from "@mikro-orm/postgresql";
import { em as dbEm } from "../db.js";
import { log } from "../ops/log.js";
import { forList, type PublicMarketEvent } from "./catalog.js";

export const KEEP_MS = 7 * 24 * 3600_000;
const PRUNE_EVERY_MS = 3600_000;
export const SERIES_MAX_SYMBOLS = 120;
export const SERIES_MAX_HOURS = 168;

export interface Tick {
  symbol: string;
  chance: number;
  at: Date;
}

const minuteOf = (ms: number): Date => new Date(Math.floor(ms / 60_000) * 60_000);

/** The contracts a card shows for these events, with their chance now. */
export function ticksOf(events: PublicMarketEvent[], now: number): Tick[] {
  const at = minuteOf(now);
  const out: Tick[] = [];
  for (const e of events.map(forList)) {
    const shown = [
      ...(e.kind === "moneyline" ? e.contracts : []),
      ...(e.lines.spread?.contracts ?? []),
      ...(e.lines.total?.contracts ?? []),
    ];
    for (const c of shown) {
      if (c.symbol && c.chance !== null) out.push({ symbol: c.symbol, chance: c.chance, at });
    }
  }
  return out;
}

export interface OddsRecorder {
  record(events: PublicMarketEvent[]): Promise<number>;
}

/**
 * A recorder over `write` (the database, or a list in tests). Returns how
 * many ticks it handed to `write`.
 */
export function createOddsRecorder(
  write: (ticks: Tick[]) => Promise<void>,
  prune: (before: Date) => Promise<void>,
  now: () => number = Date.now,
): OddsRecorder {
  const last = new Map<string, number>();
  let prunedAt = 0;
  return {
    async record(events) {
      const t = now();
      const changed = ticksOf(events, t).filter((k) => last.get(k.symbol) !== k.chance);
      if (changed.length) {
        await write(changed);
        for (const k of changed) last.set(k.symbol, k.chance);
      }
      if (t - prunedAt >= PRUNE_EVERY_MS) {
        prunedAt = t;
        await prune(new Date(t - KEEP_MS));
      }
      return changed.length;
    },
  };
}

const INSERT_CHUNK = 500;

async function writeTicks(ticks: Tick[]): Promise<void> {
  const em = dbEm();
  const created = new Date();
  for (let i = 0; i < ticks.length; i += INSERT_CHUNK) {
    const chunk = ticks.slice(i, i + INSERT_CHUNK);
    const values = chunk.map(() => "(?, ?, ?, ?, ?)").join(", ");
    const params = chunk.flatMap((k) => [randomUUID(), k.symbol, k.chance, k.at, created]);
    await em.execute(
      `insert into market_ticks (id, symbol, chance, at, created_at) values ${values} on conflict (symbol, at) do nothing`,
      params,
    );
  }
}

async function pruneTicks(before: Date): Promise<void> {
  await dbEm().execute("delete from market_ticks where at < ?", [before]);
}

let shared: OddsRecorder | null = null;

/** catalog onRefresh: record a fresh list. Never throws; a failed write only costs a point. */
export async function recordOdds(events: PublicMarketEvent[]): Promise<void> {
  shared ??= createOddsRecorder(writeTicks, pruneTicks);
  try {
    await shared.record(events);
  } catch (err) {
    log.warn("could not record odds", { module: "markets", err });
  }
}

/** [unix seconds, chance] pairs, oldest first. */
export type Series = [number, number][];

/**
 * Each symbol's points over the last `hours`. A symbol with no point at all
 * is left out, so the client draws nothing for it.
 */
export async function oddsSeries(
  em: EntityManager,
  symbols: string[],
  hours: number,
  now = Date.now(),
): Promise<Record<string, Series>> {
  if (symbols.length === 0) return {};
  const since = new Date(now - hours * 3600_000);
  const marks = symbols.map(() => "?").join(", ");
  const before = await em.execute<{ symbol: string; chance: number; at: Date }[]>(
    `select distinct on (symbol) symbol, chance, at from market_ticks
      where symbol in (${marks}) and at < ? order by symbol, at desc`,
    [...symbols, since],
  );
  const inside = await em.execute<{ symbol: string; chance: number; at: Date }[]>(
    `select symbol, chance, at from market_ticks where symbol in (${marks}) and at >= ? order by at asc`,
    [...symbols, since],
  );
  const out: Record<string, Series> = {};
  const sec = (d: Date | string) => Math.floor(new Date(d).getTime() / 1000);
  // The point before the window starts the line at the window's left edge.
  for (const r of before) out[r.symbol] = [[sec(since), Number(r.chance)]];
  for (const r of inside) (out[r.symbol] ??= []).push([sec(r.at), Number(r.chance)]);
  return out;
}

/** Symbols from a query string: comma-separated, deduped, capped, GEMI- only. */
export function parseSymbols(raw: string | null): string[] {
  const list = (raw ?? "").split(",").map((s) => s.trim()).filter((s) => /^GEMI-[A-Za-z0-9.-]{1,114}$/.test(s));
  return [...new Set(list)].slice(0, SERIES_MAX_SYMBOLS);
}

/** Hours from a query string: 1–168, default 24. */
export function parseHours(raw: string | null): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= SERIES_MAX_HOURS ? n : 24;
}
