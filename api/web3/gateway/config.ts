/**
 * Circle Gateway on testnet: where its contracts and API live, which chains
 * a payout can go to, and the chain payouts are funded from.
 *
 * Gateway holds USDC as one balance that is not tied to a chain: deposit on
 * one chain, sign a burn intent, and Circle mints on another within seconds.
 * SportsArc uses it for one thing: paying a player on the chain they chose
 * when their money leaves a game (payouts.ts).
 *
 * Sources, checked 2026-11-10:
 *   - Contracts: developers.circle.com/gateway/references/contract-addresses,
 *     and GET {api}/v1/info, which lists the same two addresses per domain.
 *   - A real payout from Arc testnet to Base Sepolia through the forwarder
 *     confirmed 6.9 s after the request (fee 0.055863 USDC); the testnet API
 *     takes no key.
 * Testnet only: the mainnet API host and contracts are refused.
 */

import type { Address } from "viem";
import { WEB3_CHAINS, web3ChainKey } from "../chains.js";
import { CCTP_TESTNETS, type CctpChain } from "../cctp/config.js";

/** Same addresses on every supported EVM testnet. */
export const GATEWAY_TESTNET = {
  wallet: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
  minter: "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B",
} as const satisfies Record<string, Address>;

export const GATEWAY_API_TESTNET = "https://gateway-api-testnet.circle.com";

/** Circle domains Gateway serves on testnet (Linea is CCTP-only). */
const GATEWAY_DOMAINS = new Set([0, 1, 2, 3, 6, 7, 10, 13, 14, 19, 26]);

/** A chain Gateway can pay out on: the CCTP table's entry (domain, USDC). */
export type GatewayChain = CctpChain;

export function gatewayChains(): GatewayChain[] {
  return CCTP_TESTNETS.filter((c) => GATEWAY_DOMAINS.has(c.domain));
}

/** The chain payouts are funded from: WEB3_CHAIN, when Gateway serves it. */
export function payoutSource(): GatewayChain | null {
  const chainId = WEB3_CHAINS[web3ChainKey()].id;
  return gatewayChains().find((c) => c.chainId === chainId) ?? null;
}

/** Where a payout may go: every Gateway chain but the source. */
export function payoutChains(): GatewayChain[] {
  const source = payoutSource();
  return source ? gatewayChains().filter((c) => c.chainId !== source.chainId) : [];
}

export function payoutChainByKey(key: unknown): GatewayChain | null {
  return payoutChains().find((c) => c.key === key) ?? null;
}

/** API base URL: GATEWAY_API_URL or the testnet. Null when it names mainnet. */
export function gatewayApiUrl(): string | null {
  const raw = (process.env.GATEWAY_API_URL?.trim() || GATEWAY_API_TESTNET).replace(/\/+$/, "");
  try {
    const host = new URL(raw).hostname.toLowerCase();
    if (host === "gateway-api.circle.com" || /mainnet/.test(host)) return null;
  } catch {
    return null;
  }
  return raw;
}

function envUsdc(name: string, fallback: string): bigint {
  const raw = process.env[name]?.trim() || fallback;
  return /^\d{1,9}$/.test(raw) ? BigInt(raw) * 1_000_000n : BigInt(fallback) * 1_000_000n;
}

/** Most one payout may send, and most all payouts may send in 24 hours. */
export function payoutCaps(): { perPayout: bigint; daily: bigint } {
  return {
    perPayout: envUsdc("GATEWAY_MAX_PAYOUT_USDC", "500"),
    daily: envUsdc("GATEWAY_DAILY_CAP_USDC", "2000"),
  };
}
