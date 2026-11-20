/**
 * Picks: the social and personal history side of Pro markets, for Home's
 * Markets tab (frontend/markets/home.js).
 *
 *   followingPicks  picks people you follow chose to post, newest first. Only
 *                   what the post already says (side, price when posted),
 *                   never how much anyone holds, plus the side's price now
 *                   and, once Gemini settles it, whether it won.
 *   pickHistory     your own settled picks, won or lost, with the payout,
 *                   and the record across them. Practice reads practice_fills;
 *                   a Gemini account reads Gemini's settled positions.
 *
 * Both are adults only; routes.ts gates them like every other market route.
 */

import type { EntityManager } from "@mikro-orm/postgresql";
import { Follow } from "../entities/Follow.js";
import { Post } from "../entities/Post.js";
import type { User } from "../entities/User.js";
import { leagueOf, type Catalog, type Outcome } from "./catalog.js";
import type { MarketsConfig } from "./config.js";
import type { GeminiClient } from "./gemini.js";
import { accountFor } from "./oauth.js";
import { PracticeFill } from "./PracticeFill.js";

/** How far back a friend's pick is still worth showing. */
const PICKS_WINDOW_MS = 3 * 24 * 3600_000;
const PICKS_MAX = 20;
const HISTORY_MAX = 50;

export interface FollowingPick {
  postId: string;
  createdAt: string;
  author: { id: string; name: string | null; avatarUrl: string | null; role: string | null };
  market: NonNullable<Post["market"]>;
  /** The side's buy price now, 0–1; null when Gemini has no price (or no longer lists it). */
  priceNow: string | null;
  /** Once the market settles: how the side the author took did. */
  result: "won" | "lost" | null;
}

/** Pure: how a side did, given the side Gemini settled the contract on (null while open). */
export function resultOf(resolutionSide: Outcome | null | undefined, outcome: Outcome): "won" | "lost" | null {
  if (resolutionSide !== "yes" && resolutionSide !== "no") return null;
  return resolutionSide === outcome ? "won" : "lost";
}

export async function followingPicks(
  em: EntityManager,
  viewer: User,
  cat: Pick<Catalog, "contract">,
  now = Date.now(),
): Promise<FollowingPick[]> {
  const follows = await em.find(Follow, { follower: viewer }, { fields: ["followee"] });
  const ids = follows.map((f) => f.followee.id);
  if (!ids.length) return [];
  const posts = (await em.find(
    Post,
    { author: { $in: ids }, market: { $ne: null }, createdAt: { $gte: new Date(now - PICKS_WINDOW_MS) } },
    { populate: ["author"], orderBy: { createdAt: "DESC" }, limit: PICKS_MAX },
  )).filter((p) => p.market);
  // One catalog read per contract; the catalog caches by event, so most are free.
  const symbols = [...new Set(posts.map((p) => p.market!.symbol))];
  const found = new Map(await Promise.all(symbols.map(async (s) => [s, await cat.contract(s)] as const)));
  return posts.map((p) => {
    const m = p.market!;
    const f = found.get(m.symbol);
    const c = f?.ok ? f.contract : null;
    return {
      postId: p.id,
      createdAt: p.createdAt.toISOString(),
      author: { id: p.author.id, name: p.author.name ?? null, avatarUrl: p.author.avatarUrl ?? null, role: p.author.role ?? null },
      market: m,
      priceNow: c ? c[m.outcome].buy : null,
      result: m.result ?? (c ? resultOf(c.resolutionSide, m.outcome) : null),
    };
  });
}

export interface SettledPick {
  symbol: string;
  title: string;
  label: string;
  outcome: "yes" | "no";
  /** The league, from the symbol's prefix; null when we do not name it. */
  league: string | null;
  /** What went in: the buys. */
  cost: string;
  /** What came back: sales plus Gemini's payout. */
  payout: string;
  /** Came back with more than went in. */
  won: boolean;
  /** Some or all of it was sold before Gemini settled it. */
  sold: boolean;
  /** All of it was sold: you closed it yourself, so it counts in the net but not the won–lost record. */
  soldOut: boolean;
  settledAt: string;
}

export interface PickHistory {
  picks: SettledPick[];
  record: { won: number; lost: number; net: string };
}

const dollars = (cents: number): string => (cents / 100).toFixed(2);

/** Pure: a won/lost record over the picks Gemini settled, and the net over all of them (sales included). */
export function recordOf(picks: (Pick<SettledPick, "won" | "cost" | "payout"> & { soldOut?: boolean })[]): PickHistory["record"] {
  let won = 0;
  let lost = 0;
  let netCents = 0;
  for (const p of picks) {
    if (!p.soldOut) { if (p.won) won++; else lost++; }
    netCents += Math.round(Number(p.payout) * 100) - Math.round(Number(p.cost) * 100);
  }
  return { won, lost, net: dollars(netCents) };
}

/** A sale that closes a position settles every fill at that moment (practice.ts), so settled ≈ the last sale means sold out. */
const SOLD_OUT_MS = 60_000;

/**
 * Pure: practice fills grouped into one pick per contract and side. What
 * went in is the buys; what came back is the sales (their negative cost)
 * plus every payout, a sale's included (minus $1 a contract it gave up on
 * a win). A pick won when more came back than went in.
 */
export function practiceHistory(
  fills: (Pick<PracticeFill, "symbol" | "title" | "label" | "outcome" | "costCents" | "payoutCents" | "settledAt"> & { side?: "buy" | "sell"; createdAt?: Date })[],
): SettledPick[] {
  const groups = new Map<string, Omit<SettledPick, "cost" | "payout" | "won" | "soldOut" | "settledAt"> & { inCents: number; backCents: number; at: number; lastSale: number }>();
  for (const f of fills) {
    if (!f.settledAt) continue;
    const key = `${f.symbol}|${f.outcome}`;
    const g = groups.get(key) ?? {
      symbol: f.symbol, title: f.title, label: f.label, outcome: f.outcome,
      league: leagueOf(f.symbol), sold: false, inCents: 0, backCents: 0, at: 0, lastSale: 0,
    };
    if (f.side === "sell") {
      g.sold = true;
      g.backCents -= f.costCents;
      g.lastSale = Math.max(g.lastSale, f.createdAt?.getTime() ?? 0);
    } else g.inCents += f.costCents;
    g.backCents += f.payoutCents ?? 0;
    g.at = Math.max(g.at, f.settledAt.getTime());
    groups.set(key, g);
  }
  return [...groups.values()]
    .sort((a, b) => b.at - a.at)
    .map(({ inCents, backCents, at, lastSale, ...p }) => ({
      ...p, cost: dollars(inCents), payout: dollars(backCents), won: backCents > inCents,
      soldOut: p.sold && lastSale > 0 && Math.abs(at - lastSale) < SOLD_OUT_MS,
      settledAt: new Date(at).toISOString(),
    }));
}

export async function pickHistory(em: EntityManager, user: User, client: GeminiClient, cfg: MarketsConfig): Promise<PickHistory> {
  let picks: SettledPick[] = [];
  if (cfg.trading === "practice") {
    const fills = await em.find(PracticeFill, { user: user.id, settledAt: { $ne: null } }, { orderBy: { settledAt: "DESC" }, limit: HISTORY_MAX * 4 });
    picks = practiceHistory(fills).slice(0, HISTORY_MAX);
  } else if (cfg.trading !== "off") {
    const account = await accountFor(em, user, cfg);
    if (account.ok) {
      const res = await client.privatePost<{ positions?: Record<string, any>[] }>(
        account.auth, "/v1/prediction-markets/positions/settled", {}, { limit: HISTORY_MAX, sort: "-date" },
      );
      if (res.ok && Array.isArray(res.data?.positions)) picks = res.data.positions.map(fromGemini);
    }
  }
  return { picks, record: recordOf(picks) };
}

/** One of Gemini's settled positions → ours. */
function fromGemini(p: Record<string, any>): SettledPick {
  const meta = (p.contractMetadata ?? {}) as Record<string, any>;
  const qty = Number(p.totalQuantity ?? p.quantity ?? 0);
  const cost = Number.isFinite(Number(p.costBasis)) ? Number(p.costBasis) : qty * Number(p.avgPrice ?? 0);
  const payout = Number(p.payout ?? 0);
  return {
    symbol: String(p.symbol ?? ""),
    title: String(meta.eventName ?? meta.eventTitle ?? p.symbol ?? ""),
    label: String(meta.contractName ?? meta.label ?? ""),
    outcome: p.outcome === "no" ? "no" : "yes",
    league: leagueOf(String(p.symbol ?? "")),
    cost: (Number.isFinite(cost) ? cost : 0).toFixed(2),
    payout: (Number.isFinite(payout) ? payout : 0).toFixed(2),
    won: payout > cost,
    sold: false,
    soldOut: false,
    settledAt: String(p.settledAt ?? ""),
  };
}
