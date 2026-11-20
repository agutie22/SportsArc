/**
 * USDC amounts as people read them: "$5.00", and as people type them:
 * "5" or "2.50". Every money feature (events, payments, transfers) goes
 * through here so the app never shows "5 USDC" in one place and "$5.00" in
 * another.
 */

import { formatUnits, parseUnits } from "viem";

const USDC_DECIMALS = 6;

/** "5", "2.5" or "2.50" USDC to base units; null when malformed. */
export function parseUsdc(value: unknown): bigint | null {
  const raw = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!/^\d{1,9}(\.\d{1,6})?$/.test(raw)) return null;
  return parseUnits(raw, USDC_DECIMALS);
}

/** 6-decimal USDC base units to "$5.00" (rounded to cents). */
export function usd(amount: bigint): string {
  return `$${Number(formatUnits(amount, USDC_DECIMALS)).toFixed(2)}`;
}
