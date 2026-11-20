/**
 * The rail beside Your picks (frontend/markets/picks-rail.js), server side:
 *
 *   accountValueCents  what an account is worth now: money available plus
 *                      open positions at their value (their cost when Gemini
 *                      has no price)
 *   recordSnapshot     keep that value for the hour (PortfolioSnapshot); called
 *                      when the account is read, so a user who looks gets a line
 *   portfolioSeries    the values over 1D / 1W / 1M / All for the Portfolio card,
 *                      starting from the last value before the range
 *   seenAt / markSeen  when the user last looked at settled picks ("Needs you")
 */

import type { EntityManager } from "@mikro-orm/postgresql";
import { randomUUID } from "node:crypto";
import { User } from "../entities/User.js";
import { PicksSeen } from "./PicksSeen.js";
import { PortfolioSnapshot } from "./PortfolioSnapshot.js";

export type Range = "1d" | "1w" | "1m" | "all";

const HOUR = 3_600_000;
const SPAN: Record<Exclude<Range, "all">, number> = { "1d": 24 * HOUR, "1w": 7 * 24 * HOUR, "1m": 30 * 24 * HOUR };
/** Points a series sends at most; a longer one is thinned evenly, keeping the last. */
const MAX_POINTS = 120;

export const parseRange = (v: unknown): Range => (v === "1d" || v === "1w" || v === "1m" || v === "all" ? v : "1w");

/** Pure: the hour a time falls in. */
export const hourOf = (t: number): Date => new Date(Math.floor(t / HOUR) * HOUR);

/** Pure: money available plus open positions at value (cost when unpriced), in cents; null without a balance. */
export function accountValueCents(a: { usdAvailable: string | null; positions: { value: string | null; cost: string }[] }): number | null {
  if (a.usdAvailable === null) return null;
  const cash = Math.round(Number(a.usdAvailable) * 100);
  if (!Number.isFinite(cash)) return null;
  return a.positions.reduce((sum, p) => sum + Math.round(Number(p.value ?? p.cost) * 100 || 0), cash);
}

/** Keep the account's value for this hour; a later read in the same hour replaces it. */
export async function recordSnapshot(em: EntityManager, userId: string, valueCents: number, now = Date.now()): Promise<void> {
  await em.createQueryBuilder(PortfolioSnapshot)
    // A query-builder insert skips the entity's defaults, so the id is given here.
    .insert({ id: randomUUID(), user: userId, valueCents, at: hourOf(now), createdAt: new Date(now) })
    .onConflict(["user", "at"]).merge(["valueCents"])
    .execute();
}

/** Pure: thin a series to at most `max` points, evenly, always keeping the first and the last. */
export function thin<T>(points: T[], max = MAX_POINTS): T[] {
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => points[Math.round(i * step)]);
}

/** The account's values over `range`, oldest first, in dollars; the first point is the value at the range's start. */
export async function portfolioSeries(
  em: EntityManager,
  userId: string,
  range: Range,
  now = Date.now(),
): Promise<{ at: string; value: string }[]> {
  const start = range === "all" ? null : new Date(now - SPAN[range]);
  const rows = await em.find(
    PortfolioSnapshot,
    { user: userId, ...(start ? { at: { $gte: start } } : {}) },
    { orderBy: { at: "ASC" }, fields: ["at", "valueCents"] },
  );
  // Where the range starts: the last value before it, so the line begins at the left edge.
  const before = start
    ? await em.findOne(PortfolioSnapshot, { user: userId, at: { $lt: start } }, { orderBy: { at: "DESC" }, fields: ["at", "valueCents"] })
    : null;
  const all = before ? [{ at: start!, valueCents: before.valueCents }, ...rows] : rows;
  return thin(all).map((r) => ({ at: r.at.toISOString(), value: (r.valueCents / 100).toFixed(2) }));
}

export async function seenAt(em: EntityManager, userId: string): Promise<string | null> {
  const row = await em.findOne(PicksSeen, { user: userId }, { fields: ["seenAt"] });
  return row?.seenAt ? row.seenAt.toISOString() : null;
}

/** Settled picks up to now are seen. */
export async function markSeen(em: EntityManager, userId: string, now = Date.now()): Promise<string> {
  const at = new Date(now);
  await em.createQueryBuilder(PicksSeen)
    .insert({ id: randomUUID(), user: em.getReference(User, userId), seenAt: at, updatedAt: at })
    .onConflict(["user"]).merge(["seenAt", "updatedAt"])
    .execute();
  return at.toISOString();
}
