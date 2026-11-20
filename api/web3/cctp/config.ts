/**
 * Where CCTP lives on the testnets this workstream bridges, and the
 * read-only clients for them. Withdrawals burn on Arc and Circle's
 * Forwarding Service mints on any chain in CCTP_TESTNETS, HyperEVM
 * included. Testnet only: chain ids outside that table, and mainnet RPC
 * or Iris hosts, are refused rather than configured.
 *
 * Sources for every constant below, checked 2026-09-25 (destination
 * domains re-read 2026-11-04):
 *   - Circle's CCTP v2 testnet contracts are CREATE2-deployed at the same
 *     addresses on every EVM testnet (developers.circle.com/cctp/references/
 *     contract-addresses; github.com/circlefin/evm-cctp-contracts, src/v2/).
 *     Each address is also checked on chain. `check.ts --live` repeats
 *     those reads:
 *       MessageTransmitterV2.localDomain() = 26 on Arc, 19 on HyperEVM
 *       TokenMessengerV2.localMessageTransmitter() / localMinter() match
 *       TokenMessengerV2.remoteTokenMessengers(19) on Arc, and (26) on
 *         HyperEVM, are both this TokenMessengerV2: the route is open
 *       TokenMinterV2.getLocalToken(26, Arc USDC) on HyperEVM = HyperEVM USDC
 *   - Arc testnet USDC: api/circle/chain-config.ts (ERC-20 view of the native gas
 *     token, 6 dp; the native balance carries 18 dp).
 *   - HyperEVM testnet USDC: 0x2B3370eE501B4a559b57D449569354196457D8Ab
 *     (ERC-20, 6 decimals). Hyperliquid's testnet spotMeta lists a different
 *     evmContract; that proxy is not this token.
 *   - Iris sandbox: https://iris-api-sandbox.circle.com (Circle's CCTP API
 *     reference).
 */

import { createPublicClient, http, type Address, type Chain, type PublicClient } from "viem";
import {
  arbitrumSepolia,
  avalancheFuji,
  baseSepolia,
  lineaSepolia,
  optimismSepolia,
  polygonAmoy,
  hyperliquidEvmTestnet,
  sepolia,
  sonicTestnet,
  unichainSepolia,
  worldchainSepolia,
} from "viem/chains";
import { WEB3_CHAINS, web3ChainKey } from "../chains.js";
import { CHAIN_DEFAULTS } from "../../circle/chain-config.js";

/** CCTP v2 testnet deployments; identical on every EVM testnet. */
export const CCTP_V2_TESTNET = {
  tokenMessenger: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
  messageTransmitter: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275",
  tokenMinter: "0xb43db544E2c27092c107639Ad201b3dEfAbcF192",
} as const satisfies Record<string, Address>;

/** Mainnet CCTP v2, listed only so it can be refused. */
const CCTP_V2_MAINNET: Address[] = [
  "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
  "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
];

/** Standard (finalized) transfer: attested once the burn is final. */
export const FINALITY_STANDARD = 2000;

export const IRIS_SANDBOX_URL = "https://iris-api-sandbox.circle.com";

export interface CctpChain {
  key: string;
  name: string;
  chainId: number;
  domain: number;
  tokenMessenger: Address;
  messageTransmitter: Address;
  tokenMinter: Address;
  usdc: Address;
}

export interface CctpRoute {
  source: CctpChain;
  destination: CctpChain;
}

export const ARC_TESTNET: CctpChain = {
  key: "arcTestnet",
  name: "Arc",
  chainId: CHAIN_DEFAULTS.arcTestnet.id,
  domain: 26,
  ...CCTP_V2_TESTNET,
  usdc: CHAIN_DEFAULTS.arcTestnet.usdc,
};

function testnet(key: string, name: string, chain: Chain, domain: number, usdc: Address): CctpChain {
  return { key, name, chainId: chain.id, domain, ...CCTP_V2_TESTNET, usdc };
}

/**
 * HyperEVM testnet, as a withdrawal destination only. Circle submits the
 * mint; this server does not build or sign transactions there.
 */
export const HYPEREVM_TESTNET: CctpChain = testnet(
  "hyperevmTestnet",
  "HyperEVM",
  hyperliquidEvmTestnet,
  19,
  "0x2B3370eE501B4a559b57D449569354196457D8Ab",
);

/**
 * Every testnet a withdrawal may go to. Domains and USDC addresses from
 * developers.circle.com/cctp/references/contract-addresses and
 * /stablecoins/usdc-contract-addresses, checked 2026-11-04; each domain was
 * also read live from MessageTransmitterV2.localDomain() on its chain (all
 * matched; Polygon Amoy's public RPC was down at the time). All are
 * Forwarding Service destinations, so Circle submits the mint and the
 * recipient needs no gas there.
 */
export const CCTP_TESTNETS: readonly CctpChain[] = [
  ARC_TESTNET,
  HYPEREVM_TESTNET,
  testnet("baseSepolia", "Base", baseSepolia, 6, "0x036CbD53842c5426634e7929541eC2318f3dCF7e"),
  testnet("sepolia", "Ethereum", sepolia, 0, "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238"),
  testnet("arbitrumSepolia", "Arbitrum", arbitrumSepolia, 3, "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d"),
  testnet("optimismSepolia", "Optimism", optimismSepolia, 2, "0x5fd84259d66Cd46123540766Be93DFE6D43130D7"),
  testnet("polygonAmoy", "Polygon", polygonAmoy, 7, "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582"),
  testnet("avalancheFuji", "Avalanche", avalancheFuji, 1, "0x5425890298aed601595a70AB815c96711a31Bc65"),
  testnet("unichainSepolia", "Unichain", unichainSepolia, 10, "0x31d0220469e10c4E71834a79b1f276d740d3768F"),
  testnet("lineaSepolia", "Linea", lineaSepolia, 11, "0xFEce4462D57bD51A6A552365A011b95f0E16d9B7"),
  testnet("worldchainSepolia", "World Chain", worldchainSepolia, 14, "0x66145f38cBAC35Ca6F1Dfb4914dF98F1614aeA88"),
  testnet("sonicTestnet", "Sonic", sonicTestnet, 13, "0x0BA304580ee7c9a980CF72e55f5Ed2E9fd30Bc51"),
];

const VIEM_CHAINS: Record<string, Chain> = {
  arcTestnet: WEB3_CHAINS.arcTestnet,
  hyperevmTestnet: hyperliquidEvmTestnet,
  baseSepolia, sepolia, arbitrumSepolia, optimismSepolia, polygonAmoy,
  avalancheFuji, unichainSepolia, lineaSepolia, worldchainSepolia, sonicTestnet,
};

/** Where withdrawals burn: the user's USDC lives on Arc. */
export const WITHDRAW_SOURCE = ARC_TESTNET;

export function cctpChainByKey(key: unknown): CctpChain | null {
  return CCTP_TESTNETS.find((c) => c.key === key) ?? null;
}

export function cctpChainById(chainId: number): CctpChain | null {
  return CCTP_TESTNETS.find((c) => c.chainId === chainId) ?? null;
}

/** Block explorer base URL for a CCTP chain, if viem knows one. */
export function explorerFor(chain: CctpChain): string | null {
  return VIEM_CHAINS[chain.key]?.blockExplorers?.default.url ?? null;
}

/** What a browser wallet needs to add or switch to a chain (EIP-3085). */
export function walletChainParams(chain: CctpChain) {
  const v = VIEM_CHAINS[chain.key];
  return {
    chainId: `0x${chain.chainId.toString(16)}`,
    chainName: v.name,
    nativeCurrency: v.nativeCurrency,
    rpcUrls: [...v.rpcUrls.default.http],
    blockExplorerUrls: v.blockExplorers?.default.url ? [v.blockExplorers.default.url] : [],
  };
}

/** Fast transfer: attested after a soft confirmation, for a small fee. */
export const FINALITY_FAST = 1000;

/**
 * Forwarding Service hook, version 0: "cctp-forward" as bytes24, then a
 * uint32 version (0) and a uint32 length of Circle hook data (0). The burn
 * carries it as hookData; Circle then submits the mint on the destination.
 * developers.circle.com/cctp/concepts/forwarding-service
 */
export const FORWARD_HOOK_DATA = "0x636374702d666f72776172640000000000000000000000000000000000000000" as const;

// ── testnet guard ──

const TESTNET_CHAIN_IDS = new Set(CCTP_TESTNETS.map((c) => c.chainId));

/** Hosts that serve mainnets. Anything matching is refused, whatever the path. */
const MAINNET_HOSTS = [
  /(^|\.)iris-api\.circle\.com$/, // the sandbox is iris-api-sandbox.circle.com
  /(^|\.)hyperliquid\.xyz$/, // testnet is hyperliquid-testnet.xyz
  /^rpc\.mainnet\.arc\.io$/, // testnet is rpc.testnet.arc.io
  /^rpc\.arc\.network$/, // the older name; testnet was rpc.testnet.arc.network
];

export function isTestnetChainId(chainId: number): boolean {
  return TESTNET_CHAIN_IDS.has(chainId);
}

/** Null when the URL is acceptable, else why it is not. */
export function refuseUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `Not a URL: ${raw}`;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return `Unsupported scheme in ${raw}`;
  const host = url.hostname.toLowerCase();
  if (/mainnet/.test(host) || MAINNET_HOSTS.some((re) => re.test(host))) {
    return `${host} serves a mainnet; this workstream is testnet only.`;
  }
  return null;
}

/** Null when the route is testnet-only, else why it is not. */
export function refuseRoute(route: CctpRoute): string | null {
  for (const chain of [route.source, route.destination]) {
    if (!isTestnetChainId(chain.chainId)) return `Chain ${chain.chainId} is not a supported testnet.`;
    const addrs = [chain.tokenMessenger, chain.messageTransmitter].map((a) => a.toLowerCase());
    if (CCTP_V2_MAINNET.some((m) => addrs.includes(m.toLowerCase()))) {
      return "Mainnet CCTP contracts are refused.";
    }
  }
  return null;
}

// ── clients ──

const RPC_ENV: Record<string, string> = {
  arcTestnet: "CCTP_ARC_RPC_URL",
  hyperevmTestnet: "CCTP_HYPEREVM_RPC_URL",
};

/**
 * RPC for a chain: CCTP_ARC_RPC_URL / CCTP_HYPEREVM_RPC_URL, else
 * CCTP_RPC_URL_<chainId> (any chain), else WEB3_RPC_URL when WEB3_CHAIN is
 * that chain, else viem's public default.
 */
export function rpcUrlFor(chain: CctpChain): string {
  const named = RPC_ENV[chain.key];
  const own = (named && process.env[named]?.trim()) || process.env[`CCTP_RPC_URL_${chain.chainId}`]?.trim();
  if (own) return own;
  const shared = process.env.WEB3_RPC_URL?.trim();
  if (shared && web3ChainKey() === chain.key) return shared;
  const viemChain = VIEM_CHAINS[chain.key];
  if (!viemChain) throw new Error(`No RPC known for chain ${chain.chainId}.`);
  return viemChain.rpcUrls.default.http[0];
}

const clients = new Map<string, PublicClient>();

/** Read-only client for a CCTP chain. Throws on a mainnet URL (a config error). */
export function clientFor(chain: CctpChain): PublicClient {
  const url = rpcUrlFor(chain);
  const refused = refuseUrl(url);
  if (refused) throw new Error(refused);
  const key = `${chain.chainId}|${url}`;
  let client = clients.get(key);
  if (!client) {
    const viemChain: Chain = VIEM_CHAINS[chain.key];
    client = createPublicClient({ chain: viemChain, transport: http(url) }) as PublicClient;
    clients.set(key, client);
  }
  return client;
}

/** Iris base URL: CCTP_IRIS_URL or the sandbox. */
export function irisUrl(): string {
  return (process.env.CCTP_IRIS_URL?.trim() || IRIS_SANDBOX_URL).replace(/\/+$/, "");
}
