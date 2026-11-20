/**
 * api/circle/budget-handler.ts — Wallet USDC balance (core).
 */

import { createPublicClient, http, erc20Abi, isAddress } from "viem";
import { defineChain } from "viem";
import { CHAIN_DEFAULTS, normalizeBuyerChainKey } from "./chain-config.js";

function formatUsdc(value: bigint): string {
  const whole = value / 1_000_000n;
  const frac = value % 1_000_000n;
  return `${whole}.${frac.toString().padStart(6, "0")}`;
}

export type WalletUsdcBalanceResponse =
  | {
      ok: true;
      address: string;
      chain: string;
      usdcAddress: string;
      balance: string;
    }
  | { ok: false; error: { code: string; message: string } };

export async function handleWalletUsdcBalance(
  address: string | undefined,
): Promise<WalletUsdcBalanceResponse> {
  const addr = (address ?? "").trim();
  if (!addr || !isAddress(addr)) {
    return {
      ok: false,
      error: { code: "VALIDATION_ERROR", message: "A valid 0x wallet address is required." },
    };
  }

  const chainKey = normalizeBuyerChainKey(process.env.BUYER_CHAIN);
  const chainCfg = CHAIN_DEFAULTS[chainKey] ?? CHAIN_DEFAULTS.arcTestnet;
  const rpcUrl = process.env.BUYER_RPC_URL ?? chainCfg.rpc;
  if (!rpcUrl) {
    return {
      ok: false,
      error: { code: "RPC_NOT_CONFIGURED", message: "No RPC URL available for this chain." },
    };
  }

  try {
    const customChain = defineChain({
      id: chainCfg.id,
      name: chainCfg.name,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    });
    const client = createPublicClient({
      chain: customChain,
      transport: http(rpcUrl),
    });
    const raw = await client.readContract({
      address: chainCfg.usdc,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [addr as `0x${string}`],
    });
    const balance = formatUsdc(raw);
    return {
      ok: true,
      address: addr,
      chain: chainKey,
      usdcAddress: chainCfg.usdc,
      balance,
    };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "BALANCE_FETCH_FAILED",
        message: (err as Error).message,
      },
    };
  }
}
