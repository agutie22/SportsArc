/**
 * Practice trading (GEMINI_TRADING=practice): Pro markets with no Gemini
 * account and no money.
 *
 * Prices are Gemini's live ones, from the catalog. A buy fills at once at
 * the quoted price into the user's practice account (PracticeFill rows),
 * which starts at GEMINI_PRACTICE_START dollars. A sale fills at once at
 * the bid; selling everything held closes the position there and then. Settlement waits for
 * Gemini to resolve the contract, then pays $1 a contract to the side that
 * won, and sends a market_settled notification. Nothing in practice mode
 * ever calls Gemini with an account.
 *
 * This exists because Gemini's sandbox lists no sports markets, so a demo
 * cannot trade sports on test money there.
 */

import { LockMode } from "@mikro-orm/core";
import type { EntityManager } from "@mikro-orm/postgresql";
import { User } from "../entities/User.js";
import { fail, type Failure } from "../failure.js";
import { notify } from "../social/notifications.js";
import { leagueOf, sideChance, type Catalog } from "./catalog.js";
import { config } from "./config.js";
import { PracticeFill } from "./PracticeFill.js";
import { fromScaled, toCents, toScaled, type Fill, type Quote } from "./orders.js";

export interface PublicPosition {
  symbol: string;
  eventTicker: string;
  title: string;
  label: string;
  outcome: "yes" | "no";
  qty: string;
  avgPrice: string;
  cost: string;
  /** What it would sell for now, when there is a price. */
  value: string | null;
  pnl: string | null;
  /**
   * The side's chance now, 0–100 (yes: the card's number; no: 100 minus it),
   * so a row can say how far the price moved since the pick. The middle of
   * the market, not the sell price, so the spread alone never reads as a drop.
   */
  chanceNow: number | null;
  /** The game's league and start, from the catalog; null when the event is not cached. */
  league: string | null;
  startsAt: string | null;
}

const cents = (n: number): string => (n / 100).toFixed(2);

export async function practiceBalanceCents(em: EntityManager, user: User | string): Promise<number> {
  const userId = typeof user === "string" ? user : user.id;
  const fills = await em.find(PracticeFill, { user: userId });
  let spent = 0;
  let paid = 0;
  for (const f of fills) {
    spent += f.costCents;
    paid += f.payoutCents ?? 0;
  }
  return config().practiceStart * 100 - spent + paid;
}

/** Buy at the quote, if the practice account can afford it. A repeated clientOrderId returns the first fill. */
export async function placePractice(
  em: EntityManager,
  user: User,
  q: Quote,
  sport: string,
  clientOrderId: string,
): Promise<{ ok: true; fill: Fill } | Failure> {
  return em.transactional(async (tx) => {
    // One buy at a time per user, so two taps cannot both spend the same dollars.
    await tx.findOne(User, { id: user.id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    const dupe = await tx.findOne(PracticeFill, { user: user.id, clientOrderId });
    if (dupe) return { ok: true as const, fill: fillOf(dupe) };
    const balance = await practiceBalanceCents(tx, user);
    if (q.costCents > balance) {
      return fail("INSUFFICIENT_FUNDS", `You have $${cents(Math.max(balance, 0))} left to trade.`);
    }
    const f = new PracticeFill();
    f.user = tx.getReference(User, user.id);
    f.clientOrderId = clientOrderId;
    f.symbol = q.symbol;
    f.eventTicker = q.eventTicker;
    f.title = q.title.slice(0, 160);
    f.label = q.label.slice(0, 120);
    f.sport = sport.slice(0, 24);
    f.outcome = q.outcome;
    f.qty = q.qty;
    f.price = q.price;
    f.costCents = q.costCents;
    tx.persist(f);
    await tx.flush();
    return { ok: true as const, fill: fillOf(f) };
  });
}

const fillOf = (f: PracticeFill): Fill => ({
  qty: f.qty,
  avgPrice: f.price,
  cost: cents(Math.abs(f.costCents)),
  partial: false,
  orderId: f.id,
});

/**
 * Pure: one side of one contract from its open fills: what was bought, what
 * was sold back (and brought in), and what is still held. The cost of what
 * is held is the buys' cost in proportion, so a partial sale moves neither
 * the average price nor the P&L of what is left.
 */
export function holdingOf(fills: Pick<PracticeFill, "qty" | "costCents" | "side">[]): {
  bought: bigint; sold: bigint; held: bigint; boughtCents: number; soldCents: number; heldCostCents: number; avgPrice: string;
} {
  let bought = 0n;
  let sold = 0n;
  let boughtCents = 0;
  let soldCents = 0;
  for (const f of fills) {
    const q = toScaled(f.qty) ?? 0n;
    if (f.side === "sell") { sold += q; soldCents -= f.costCents; } else { bought += q; boughtCents += f.costCents; }
  }
  const held = bought > sold ? bought - sold : 0n;
  const heldCostCents = bought > 0n ? Number((BigInt(boughtCents) * held) / bought) : 0;
  const avgPrice = bought > 0n ? fromScaled((toScaled(cents(boughtCents))! * 10n ** 8n) / bought) : "0";
  return { bought, sold, held, boughtCents, soldCents, heldCostCents, avgPrice };
}

/** Open practice positions, one per contract and side, valued at the current sell price. */
export async function practicePositions(em: EntityManager, user: User, cat: Catalog): Promise<PublicPosition[]> {
  const fills = await em.find(PracticeFill, { user: user.id, settledAt: null }, { orderBy: { createdAt: "DESC" } });
  const groups = new Map<string, PracticeFill[]>();
  for (const f of fills) {
    const k = `${f.symbol}|${f.outcome}`;
    groups.set(k, [...(groups.get(k) ?? []), f]);
  }
  const out: PublicPosition[] = [];
  for (const group of groups.values()) {
    const first = group[0];
    const h = holdingOf(group);
    if (h.held <= 0n) continue;
    const found = await cat.contract(first.symbol);
    const sell = found.ok ? found.contract[first.outcome].sell : null;
    const value = sell ? (h.held * toScaled(sell)!) / 10n ** 8n : null;
    out.push({
      symbol: first.symbol,
      eventTicker: first.eventTicker,
      title: first.title,
      label: first.label,
      outcome: first.outcome,
      qty: fromScaled(h.held),
      avgPrice: h.avgPrice,
      cost: cents(h.heldCostCents),
      value: value === null ? null : cents(toCents(value, false)),
      pnl: value === null ? null : cents(toCents(value, false) - h.heldCostCents),
      chanceNow: found.ok ? sideChance(found.contract, first.outcome) : null,
      league: found.ok ? found.event.league : leagueOf(first.eventTicker),
      startsAt: found.ok ? found.event.startsAt : null,
    });
  }
  return out;
}

/**
 * Sell contracts of one side back at the quoted bid (a sellQuote). Selling
 * everything held closes the position: its fills, the sale included, are
 * settled now with no payout. A settled position with nothing held was
 * therefore closed by a sale, never by Gemini (activity.ts relies on it).
 */
export async function placePracticeSell(
  em: EntityManager,
  user: User,
  q: Quote,
  sport: string,
  clientOrderId: string,
): Promise<{ ok: true; fill: Fill; closed: boolean } | Failure> {
  return em.transactional(async (tx) => {
    await tx.findOne(User, { id: user.id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    const dupe = await tx.findOne(PracticeFill, { user: user.id, clientOrderId });
    if (dupe) return { ok: true as const, fill: fillOf(dupe), closed: dupe.settledAt !== null && dupe.settledAt !== undefined };
    const open = await tx.find(PracticeFill, { user: user.id, symbol: q.symbol, outcome: q.outcome, settledAt: null });
    const h = holdingOf(open);
    const want = toScaled(q.qty) ?? 0n;
    if (h.held <= 0n) return fail("NOTHING_TO_SELL", "You don't hold that side.");
    if (want <= 0n || want > h.held) return fail("VALIDATION_ERROR", "You hold fewer contracts than that.");
    const at = new Date();
    const f = new PracticeFill();
    f.user = tx.getReference(User, user.id);
    f.clientOrderId = clientOrderId;
    f.symbol = q.symbol;
    f.eventTicker = q.eventTicker;
    f.title = (open[0]?.title ?? q.title).slice(0, 160);
    f.label = (open[0]?.label ?? q.label).slice(0, 120);
    f.sport = (open[0]?.sport ?? sport).slice(0, 24);
    f.outcome = q.outcome;
    f.side = "sell";
    f.qty = q.qty;
    f.price = q.price;
    f.costCents = -q.costCents;
    tx.persist(f);
    const closed = want === h.held;
    if (closed) for (const o of [...open, f]) { o.settledAt = at; o.payoutCents = 0; }
    await tx.flush();
    return { ok: true as const, fill: fillOf(f), closed };
  });
}

/** When each event was last asked whether it settled. */
const checked = new Map<string, number>();
const CHECK_EVERY_MS = 2 * 60_000;
const MAX_CHECKS = 8;

type OpenFill = Pick<PracticeFill, "id" | "symbol" | "outcome" | "qty" | "label"> & { side?: "buy" | "sell"; user: { id: string } };

/** One user's payout on one resolved contract: what to write and what to say. */
export interface Settlement {
  userId: string;
  symbol: string;
  label: string;
  paidCents: number;
  fills: { id: string; payoutCents: number }[];
}

/**
 * Pure: the settlements for open fills on contracts that have resolved, one
 * per user and contract ($1 a contract to the side that won, 0 otherwise).
 * A sale of the winning side pays minus that: those contracts were sold.
 */
export function settlementsFor(
  open: OpenFill[],
  contracts: { symbol: string; resolutionSide?: "yes" | "no" | null }[],
): Settlement[] {
  const out = new Map<string, Settlement>();
  for (const c of contracts) {
    if (!c.resolutionSide) continue;
    for (const f of open) {
      if (f.symbol !== c.symbol) continue;
      const won = f.outcome === c.resolutionSide ? toCents(toScaled(f.qty)!, false) : 0;
      const payoutCents = f.side === "sell" ? -won : won;
      const key = `${f.user.id}|${c.symbol}`;
      const s = out.get(key) ?? { userId: f.user.id, symbol: c.symbol, label: f.label, paidCents: 0, fills: [] };
      s.paidCents += payoutCents;
      s.fills.push({ id: f.id, payoutCents });
      out.set(key, s);
    }
  }
  return [...out.values()];
}

/**
 * Settle the given open fills against Gemini's results, checking each event
 * at most once per CHECK_EVERY_MS. Each fill is written only if it is still
 * open (`settledAt IS NULL`), so the job and a user's own look can race
 * without paying or notifying twice.
 */
async function settleOpen(em: EntityManager, open: PracticeFill[], cat: Catalog, now: number, maxChecks: number): Promise<number> {
  const tickers = [...new Set(open.map((f) => f.eventTicker))]
    .filter((t) => now - (checked.get(t) ?? 0) >= CHECK_EVERY_MS)
    .slice(0, maxChecks);
  let settled = 0;
  for (const ticker of tickers) {
    checked.set(ticker, now);
    const found = await cat.event(ticker, { fresh: true });
    if (!found.ok) continue;
    for (const s of settlementsFor(open.filter((f) => f.eventTicker === ticker), found.event.contracts)) {
      let paid = 0;
      let wrote = 0;
      for (const f of s.fills) {
        const at = new Date(now);
        const n = await em.nativeUpdate(PracticeFill, { id: f.id, settledAt: null }, { settledAt: at, payoutCents: f.payoutCents });
        if (n === 0) continue;
        wrote++;
        paid += f.payoutCents;
        // Keep the loaded copy in step: the balance and positions read right after use it.
        const loaded = open.find((o) => o.id === f.id);
        if (loaded) { loaded.settledAt = at; loaded.payoutCents = f.payoutCents; }
      }
      if (wrote === 0) continue;  // someone else settled these first
      settled += wrote;
      await notify(em, {
        recipient: s.userId,
        kind: "market_settled",
        detail: paid > 0 ? `${s.label} · paid $${cents(paid)}` : `${s.label} · settled at $0`,
      });
    }
  }
  return settled;
}

/**
 * Settle one user's practice fills whose contract Gemini has resolved, when
 * they look at their account. The settle job (settle-job.ts) does the same
 * for everyone, so a win is noticed without anyone looking.
 */
export async function settlePractice(em: EntityManager, user: User, cat: Catalog, now = Date.now()): Promise<number> {
  const open = await em.find(PracticeFill, { user: user.id, settledAt: null });
  return settleOpen(em, open, cat, now, MAX_CHECKS);
}

/** How many events one job tick may ask Gemini about. */
const JOB_MAX_CHECKS = 25;

/** Settle every user's open practice fills; the settle job's tick. */
export async function settleAllPractice(em: EntityManager, cat: Catalog, now = Date.now()): Promise<number> {
  const open = await em.find(PracticeFill, { settledAt: null }, { orderBy: { createdAt: "ASC" }, limit: 2000 });
  return settleOpen(em, open, cat, now, JOB_MAX_CHECKS);
}
