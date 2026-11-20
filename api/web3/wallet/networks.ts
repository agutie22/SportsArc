/**
 * Which chains the user's EVM-TESTNET wallet may build, broadcast and read
 * txs on, and a read client for each. Circle's EVM-TESTNET wallet is one
 * EOA with the same address on every EVM testnet, so the only per-chain
 * parts are the RPC, the nonce, fees, gas and the native/USDC balances.
 * Arc withdrawals sign through this wallet: the burn is an Arc transaction,
 * and Circle's EVM-TESTNET key signs it.
 *
 * Allowed chains are exactly WEB3_CHAINS in ../chains.ts: Arc testnet
 * (5042002). No mainnet; any other chain id is CHAIN_NOT_ALLOWED.
 *
 * RPC per chain, first match wins:
 *   1. WALLET_RPC_URL_<chainId>, e.g. WALLET_RPC_URL_5042002
 *   2. WEB3_RPC_URL, only for the chain WEB3_CHAIN names (as chains.ts)
 *   3. viem's default public RPC for the chain
 * A URL serving some other chain is caught by the chain id check before
 * anything is built or broadcast (CHAIN_MISMATCH).
 *
 * USDC: WEB3_USDC_ADDRESS when it is set (null if invalid), else Arc's
 * ERC-20 view of its native gas token.
 */

import { createPublicClient, http, type Address } from "viem";
import { WEB3_CHAINS, web3ChainKey, type Web3ChainKey } from "../chains.js";
import { contractAddress } from "../contracts.js";
import { CHAIN_DEFAULTS } from "../../circle/chain-config.js";
import { failure, type Client, type Failure } from "./tx.js";

export interface WalletChain {
  key: Web3ChainKey;
  chainId: number;
  name: string;
  nativeSymbol: string;
  usdcAddress: Address | null;
}

const KEYS = Object.keys(WEB3_CHAINS) as Web3ChainKey[];

function keyFor(chainId: number): Web3ChainKey | null {
  return KEYS.find((k) => WEB3_CHAINS[k].id === chainId) ?? null;
}

/** WEB3_CHAIN's id: what a caller that names no chain gets. */
export function defaultChainId(): number {
  return WEB3_CHAINS[web3ChainKey()].id;
}

export function isAllowedChainId(chainId: unknown): chainId is number {
  return typeof chainId === "number" && Number.isSafeInteger(chainId) && keyFor(chainId) !== null;
}

export function allowedChainIds(): number[] {
  return KEYS.map((k) => WEB3_CHAINS[k].id);
}

export function chainNotAllowed(chainId: unknown): Failure {
  return failure(
    "CHAIN_NOT_ALLOWED",
    `Chain ${String(chainId)} is not one the wallet serves (${allowedChainIds().join(", ")}; testnets only).`,
  );
}

export function rpcUrlFor(chainId: number): string | null {
  const key = keyFor(chainId);
  if (!key) return null;
  const own = process.env[`WALLET_RPC_URL_${chainId}`]?.trim();
  if (own) return own;
  const shared = process.env.WEB3_RPC_URL?.trim();
  if (shared && key === web3ChainKey()) return shared;
  return WEB3_CHAINS[key].rpcUrls.default.http[0];
}

export function usdcFor(chainId: number): Address | null {
  if (keyFor(chainId) !== "arcTestnet") return null;
  if (process.env.WEB3_USDC_ADDRESS?.trim()) return contractAddress("usdc");
  return CHAIN_DEFAULTS.arcTestnet.usdc;
}

/** USDC on WEB3_CHAIN: what a caller that names no chain gets. */
export function usdcAddress(): Address | null {
  return usdcFor(defaultChainId());
}

export function walletChain(chainId: number): WalletChain | null {
  const key = keyFor(chainId);
  if (!key) return null;
  const chain = WEB3_CHAINS[key];
  return {
    key,
    chainId,
    name: chain.name,
    nativeSymbol: chain.nativeCurrency.symbol,
    usdcAddress: usdcFor(chainId),
  };
}

export function walletChains(): WalletChain[] {
  return allowedChainIds().map((id) => walletChain(id) as WalletChain);
}

const clients = new Map<string, Client>();

/**
 * A read client for an allowed chain. Cached per chain and URL, so a
 * changed env var takes effect without a restart of anything.
 */
export function walletClientFor(chainId: unknown): { ok: true; client: Client } | Failure {
  if (!isAllowedChainId(chainId)) return chainNotAllowed(chainId);
  const key = keyFor(chainId) as Web3ChainKey;
  const url = rpcUrlFor(chainId) as string;
  const cacheKey = `${chainId}|${url}`;
  let client = clients.get(cacheKey);
  if (!client) {
    client = createPublicClient({ chain: WEB3_CHAINS[key], transport: http(url) }) as Client;
    clients.set(cacheKey, client);
  }
  return { ok: true, client };
}
