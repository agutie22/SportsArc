/**
 * Chains and viem clients for the web3 workstreams. Contracts live on Arc
 * testnet. WEB3_CHAIN may name arcTestnet; any other value is Arc too.
 * TESTNET_PRIVATE_KEY is the server's relayer key. Mainnets are
 * deliberately absent.
 *
 * Separate from chain-config.ts, which drives the wallet's USDC balance.
 * HyperEVM is a CCTP withdrawal destination (cctp/config.ts), not a chain
 * this server deploys to or signs on.
 */

import { createPublicClient, defineChain, http, type Chain, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";
import { serialWalletClient } from "./relayer/nonce.js";
import { CHAIN_DEFAULTS } from "../circle/chain-config.js";

/**
 * Arc testnet with the hosts Arc's own docs list (docs.arc.io, Connect to
 * Arc): viem's definition still names the older rpc.testnet.arc.network and
 * testnet.arcscan.app. The RPC is the default for server reads and what a
 * browser is told to ask (publicChainView); the explorer is every Arc link.
 */
export const ARC_TESTNET = defineChain({
  ...arcTestnet,
  rpcUrls: { default: { http: [CHAIN_DEFAULTS.arcTestnet.rpc], webSocket: ["wss://rpc.testnet.arc.io"] } },
  blockExplorers: { default: { name: "Arc Explorer", url: CHAIN_DEFAULTS.arcTestnet.explorer } },
});

export const WEB3_CHAINS = {
  arcTestnet: ARC_TESTNET,
} as const satisfies Record<string, Chain>;

export type Web3ChainKey = keyof typeof WEB3_CHAINS;

export function web3ChainKey(): Web3ChainKey {
  const raw = process.env.WEB3_CHAIN?.trim() ?? "";
  return raw in WEB3_CHAINS ? (raw as Web3ChainKey) : "arcTestnet";
}

function transport() {
  return http(process.env.WEB3_RPC_URL?.trim() || undefined);
}

export function publicClient() {
  return createPublicClient({ chain: WEB3_CHAINS[web3ChainKey()], transport: transport() });
}

/**
 * What a browser needs to ask the chain itself (frontend/chain-check.js).
 * Always the chain's public RPC, never WEB3_RPC_URL, which may carry a key.
 */
export function publicChainView() {
  const chain = WEB3_CHAINS[web3ChainKey()];
  return { id: chain.id, name: chain.name, rpcUrl: chain.rpcUrls.default.http[0] ?? null };
}

/**
 * Server-signed transactions (record entries, settlement). Null without a key.
 * Every client this returns shares one nonce queue per address and chain
 * (relayer/nonce.ts), so the timers, claims and events can send at the same
 * time without picking the same nonce, and a send the node refuses leaves no
 * gap. Across API instances too, once the database is up: each send holds a
 * Postgres advisory lock per address and chain and a shared nonce mark.
 */
export function relayer() {
  const key = process.env.TESTNET_PRIVATE_KEY?.trim();
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) return null;
  return serialWalletClient({
    account: privateKeyToAccount(key as Hex),
    chain: WEB3_CHAINS[web3ChainKey()],
    transport: transport(),
  });
}

/**
 * The Gateway payout wallet (gateway/payouts.ts): EventVault's payout
 * router, which receives a routed player's money and forwards it to the
 * chain they chose. A key of its own, PAYOUT_PRIVATE_KEY, never the
 * relayer's, so the key that signs permits and results is not the one
 * holding money in transit; the deploy script refuses a vault whose router
 * is the relayer. Null without a key, which turns routed payouts off. Same
 * nonce queue as relayer(), on its own address.
 */
export function payoutWallet() {
  const key = process.env.PAYOUT_PRIVATE_KEY?.trim();
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) return null;
  return serialWalletClient({
    account: privateKeyToAccount(key as Hex),
    chain: WEB3_CHAINS[web3ChainKey()],
    transport: transport(),
  });
}
