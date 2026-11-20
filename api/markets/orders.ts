/**
 * Buying a Pro market: turning "$10 on Boston" into an order Gemini takes.
 *
 *   quote       pure: dollars → contracts at the current buy price, rounded
 *               to the contract's own price and size steps. Gemini says not
 *               to assume one grid for every instrument, so nothing here does.
 *   placeOrder  a real order on the user's Gemini account: a limit buy at
 *               the quoted price, immediate-or-cancel, so it fills now or not
 *               at all and never rests on the book. What filled is read from
 *               filledQuantity, never from the order's final status.
 *
 * Practice buys (practice.ts) use the same quote, so practice and real
 * trades price identically.
 *
 * All arithmetic is on bigints scaled by 10^8; floats never touch a price.
 */

import { fail, type Failure } from "../failure.js";
import type { PublicContract, PublicMarketEvent, Outcome } from "./catalog.js";
import type { GeminiAuth, GeminiClient } from "./gemini.js";

const SCALE = 8;
const ONE = 10n ** BigInt(SCALE);

export const MIN_DOLLARS = 1;
export const MAX_DOLLARS = 10_000;

/** "0.0125" → 1250000n (scaled by 10^8). Null if it is not a plain decimal. */
export function toScaled(v: string | number): bigint | null {
  const s = typeof v === "number" ? v.toFixed(SCALE) : v.trim();
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) return null;
  const frac = (m[2] ?? "").slice(0, SCALE).padEnd(SCALE, "0");
  return BigInt(m[1]) * ONE + BigInt(frac);
}

/** 1250000n → "0.0125". */
export function fromScaled(v: bigint): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const whole = a / ONE;
  const frac = (a % ONE).toString().padStart(SCALE, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

/** Scaled dollars → whole cents, rounded up (a cost) or down (a payout). */
export const toCents = (v: bigint, up = true): number =>
  Number(up ? ceilDiv(v, ONE / 100n) : v / (ONE / 100n));

export interface Quote {
  symbol: string;
  eventTicker: string;
  title: string;
  label: string;
  outcome: Outcome;
  /** Price per contract, 0–1. */
  price: string;
  qty: string;
  /** What the buy costs: qty × price. */
  cost: string;
  costCents: number;
  /** What it pays if it wins: $1 a contract. */
  payout: string;
  chance: number | null;
}

export function quote(
  event: Pick<PublicMarketEvent, "ticker" | "title">,
  contract: PublicContract,
  outcome: Outcome,
  dollars: number,
): { ok: true; quote: Quote } | Failure {
  if (outcome !== "yes" && outcome !== "no") return fail("VALIDATION_ERROR", "Pick a side.");
  if (!Number.isFinite(dollars) || dollars < MIN_DOLLARS || dollars > MAX_DOLLARS) {
    return fail("VALIDATION_ERROR", `Enter an amount from $${MIN_DOLLARS} to $${MAX_DOLLARS.toLocaleString("en-US")}.`);
  }
  if (contract.marketState !== "open") return fail("MARKET_CLOSED", "This market is not taking orders right now.");
  const buy = contract[outcome].buy;
  const raw = buy ? toScaled(buy) : null;
  const pStep = toScaled(contract.priceIncrement);
  const pMin = toScaled(contract.priceMinimum);
  const qStep = toScaled(contract.quantityIncrement);
  const qMin = toScaled(contract.quantityMinimum);
  if (!raw || !pStep || !qStep || pMin === null || qMin === null || raw <= 0n || raw >= ONE) {
    return fail("MARKET_CLOSED", "Nobody is selling that side right now.");
  }

  // The price rounds up to its step: rounding down would ask below the offer
  // and an immediate-or-cancel order would not fill.
  let price = ceilDiv(raw, pStep) * pStep;
  if (price < pMin) price = pMin;
  if (price >= ONE) return fail("MARKET_CLOSED", "Nobody is selling that side right now.");

  const budget = toScaled(dollars)!;
  // Contracts the budget buys, rounded down to the size step.
  const most = (budget * ONE) / price;
  const qty = (most / qStep) * qStep;
  if (qty < qMin || qty === 0n) {
    const minCost = (qMin * price) / ONE;
    return fail("AMOUNT_TOO_SMALL", `The smallest order here is $${(toCents(minCost) / 100).toFixed(2)}.`);
  }
  const cost = (qty * price) / ONE;
  return {
    ok: true,
    quote: {
      symbol: contract.symbol,
      eventTicker: event.ticker,
      title: event.title,
      label: contract.short,
      outcome,
      price: fromScaled(price),
      qty: fromScaled(qty),
      cost: fromScaled(cost),
      costCents: toCents(cost),
      payout: fromScaled(qty),
      chance: outcome === "yes" ? contract.chance : contract.chance === null ? null : 100 - contract.chance,
    },
  };
}

/**
 * Selling what you hold: `held` contracts of one side, at what buyers pay
 * now (the side's sell price, its bid). The price rounds down to its step,
 * so an immediate-or-cancel order is not priced above the bid; the size
 * rounds down to its step too. `cost` is what the sale brings in.
 */
export function sellQuote(
  event: Pick<PublicMarketEvent, "ticker" | "title">,
  contract: PublicContract,
  outcome: Outcome,
  held: string,
): { ok: true; quote: Quote } | Failure {
  if (outcome !== "yes" && outcome !== "no") return fail("VALIDATION_ERROR", "Pick a side.");
  if (contract.marketState !== "open") return fail("MARKET_CLOSED", "This market is not taking orders right now.");
  const raw = contract[outcome].sell ? toScaled(contract[outcome].sell!) : null;
  const pStep = toScaled(contract.priceIncrement);
  const qStep = toScaled(contract.quantityIncrement);
  const qMin = toScaled(contract.quantityMinimum);
  const have = toScaled(held);
  if (!raw || !pStep || !qStep || qMin === null || raw <= 0n || raw >= ONE) {
    return fail("MARKET_CLOSED", "Nobody is buying that side right now.");
  }
  if (!have || have <= 0n) return fail("NOTHING_TO_SELL", "You don't hold that side.");
  const price = (raw / pStep) * pStep;
  const qty = (have / qStep) * qStep;
  if (price <= 0n) return fail("MARKET_CLOSED", "Nobody is buying that side right now.");
  if (qty < qMin || qty === 0n) return fail("AMOUNT_TOO_SMALL", "That is less than the smallest order here.");
  const proceeds = (qty * price) / ONE;
  return {
    ok: true,
    quote: {
      symbol: contract.symbol,
      eventTicker: event.ticker,
      title: event.title,
      label: contract.short,
      outcome,
      price: fromScaled(price),
      qty: fromScaled(qty),
      cost: fromScaled(proceeds),
      costCents: toCents(proceeds, false),
      payout: fromScaled(qty),
      chance: outcome === "yes" ? contract.chance : contract.chance === null ? null : 100 - contract.chance,
    },
  };
}

export interface Fill {
  qty: string;
  avgPrice: string;
  cost: string;
  partial: boolean;
  orderId: string | null;
}

// ── duplicate taps ──────────────────────────────────────────────────────

const SEEN_MS = 10 * 60_000;
const seen = new Map<string, { at: number; result: unknown }>();

/** The first answer for this user's clientOrderId, if it was placed in the last 10 minutes. */
export function seenOrder<T>(userId: string, clientOrderId: string, now = Date.now()): T | undefined {
  for (const [k, v] of seen) if (now - v.at > SEEN_MS) seen.delete(k);
  return seen.get(`${userId}:${clientOrderId}`)?.result as T | undefined;
}

export function rememberOrder(userId: string, clientOrderId: string, result: unknown, now = Date.now()): void {
  seen.set(`${userId}:${clientOrderId}`, { at: now, result });
}

export const isClientOrderId = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9-]{8,64}$/.test(v);

// ── a real order ────────────────────────────────────────────────────────

/** Gemini's order answer → a Fill, or PRICE_MOVED when nothing filled. */
export function readFill(json: unknown, q: Quote): { ok: true; fill: Fill } | Failure {
  const j = (json ?? {}) as Record<string, unknown>;
  const filled = toScaled(String(j.filledQuantity ?? "0")) ?? 0n;
  if (filled <= 0n) return fail("PRICE_MOVED", "The price moved before your order filled. Check the new price.");
  const avg = toScaled(String(j.avgExecutionPrice ?? q.price)) ?? toScaled(q.price)!;
  const want = toScaled(q.qty)!;
  return {
    ok: true,
    fill: {
      qty: fromScaled(filled),
      avgPrice: fromScaled(avg),
      cost: fromScaled((filled * avg) / ONE),
      partial: filled < want,
      orderId: j.orderId === undefined ? null : String(j.orderId),
    },
  };
}

/** A real order on Gemini: a buy from quote(), or a sale from sellQuote() with `side: "sell"`. */
export async function placeOrder(
  client: GeminiClient,
  auth: GeminiAuth,
  q: Quote,
  clientOrderId: string,
  side: "buy" | "sell" = "buy",
): Promise<{ ok: true; fill: Fill } | Failure> {
  const res = await client.privatePost(auth, "/v1/prediction-markets/order", {
    symbol: q.symbol,
    orderType: "limit",
    side,
    quantity: q.qty,
    price: q.price,
    outcome: q.outcome,
    timeInForce: "immediate-or-cancel",
    clientOrderId,
  });
  if (!res.ok) return fail(res.error.code, res.error.message);
  return readFill(res.data, q);
}
