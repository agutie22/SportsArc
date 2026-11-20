/**
 * Activity: what a user did in Pro markets and what came of it, newest
 * first, for the Activity card beside Your picks.
 *
 *   practice   every buy and sale (practice_fills), and each settlement by
 *              Gemini, one line per contract and side and the moment it
 *              settled. A position sold down to nothing was closed by the
 *              sale, not by Gemini, so it gets no settlement line.
 *   Gemini     the settled picks Gemini lists (picks.ts); its order history
 *              is not read yet.
 *
 * `amount` is signed dollars from the account's side: a buy is money out
 * (negative), a sale or a payout is money in.
 */

import type { EntityManager } from "@mikro-orm/postgresql";
import type { User } from "../entities/User.js";
import type { MarketsConfig } from "./config.js";
import type { GeminiClient } from "./gemini.js";
import { pickHistory } from "./picks.js";
import { holdingOf } from "./practice.js";
import { PracticeFill } from "./PracticeFill.js";

const MAX_ITEMS = 50;

export interface ActivityItem {
  at: string;
  kind: "buy" | "sell" | "won" | "lost";
  symbol: string;
  outcome: "yes" | "no";
  label: string;
  title: string;
  /** Contracts, for a buy or a sale. */
  qty: string | null;
  /** Price per contract 0–1, for a buy or a sale. */
  price: string | null;
  amount: string;
}

const dollars = (c: number): string => (c / 100).toFixed(2);

type FillRow = Pick<PracticeFill, "symbol" | "outcome" | "label" | "title" | "qty" | "price" | "costCents" | "payoutCents" | "settledAt" | "createdAt"> & { side?: "buy" | "sell" };

/** Pure: practice fills → activity, newest first. */
export function practiceActivity(fills: FillRow[], max = MAX_ITEMS): ActivityItem[] {
  const items: ActivityItem[] = fills.map((f) => ({
    at: f.createdAt.toISOString(),
    kind: f.side === "sell" ? "sell" : "buy",
    symbol: f.symbol, outcome: f.outcome, label: f.label, title: f.title,
    qty: f.qty, price: f.price,
    amount: dollars(-f.costCents),
  }));
  // Settlements: fills settled together (same contract, side and moment).
  const batches = new Map<string, FillRow[]>();
  for (const f of fills) {
    if (!f.settledAt) continue;
    const k = `${f.symbol}|${f.outcome}|${f.settledAt.getTime()}`;
    batches.set(k, [...(batches.get(k) ?? []), f]);
  }
  for (const batch of batches.values()) {
    if (holdingOf(batch.map((f) => ({ ...f, side: f.side ?? "buy" }))).held === 0n) continue;  // closed by a sale
    const paid = batch.reduce((sum, f) => sum + (f.payoutCents ?? 0), 0);
    const f = batch[0];
    items.push({
      at: f.settledAt!.toISOString(),
      kind: paid > 0 ? "won" : "lost",
      symbol: f.symbol, outcome: f.outcome, label: f.label, title: f.title,
      qty: null, price: null,
      amount: dollars(paid),
    });
  }
  return items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, max);
}

export async function activity(em: EntityManager, user: User, client: GeminiClient, cfg: MarketsConfig): Promise<ActivityItem[]> {
  if (cfg.trading === "practice") {
    const fills = await em.find(PracticeFill, { user: user.id }, { orderBy: { createdAt: "DESC" }, limit: MAX_ITEMS * 2 });
    return practiceActivity(fills);
  }
  if (cfg.trading === "off") return [];
  const { picks } = await pickHistory(em, user, client, cfg);
  return picks.map((p) => ({
    at: p.settledAt, kind: p.won ? "won" : "lost",
    symbol: p.symbol, outcome: p.outcome, label: p.label, title: p.title,
    qty: null, price: null, amount: p.payout,
  }));
}
