/**
 * Gateway burn intents: the EIP-712 message the holder of a Gateway balance
 * signs to move USDC to another chain. Pure; no network.
 *
 * Layout from developers.circle.com/gateway/references/technical-guide and
 * the unified-balance quickstart; the domain has a name and version only (no
 * chain id, no verifying contract), and every address is left-padded to 32
 * bytes. Verified live: a signature built here was accepted by the testnet
 * API on 2026-11-10.
 */

import { keccak256, pad, toHex, zeroAddress, type Address, type Hex, type LocalAccount } from "viem";
import { GATEWAY_TESTNET, type GatewayChain } from "./config.js";

export const GATEWAY_DOMAIN = { name: "GatewayWallet", version: "1" } as const;

export const BURN_INTENT_TYPES = {
  TransferSpec: [
    { name: "version", type: "uint32" },
    { name: "sourceDomain", type: "uint32" },
    { name: "destinationDomain", type: "uint32" },
    { name: "sourceContract", type: "bytes32" },
    { name: "destinationContract", type: "bytes32" },
    { name: "sourceToken", type: "bytes32" },
    { name: "destinationToken", type: "bytes32" },
    { name: "sourceDepositor", type: "bytes32" },
    { name: "destinationRecipient", type: "bytes32" },
    { name: "sourceSigner", type: "bytes32" },
    { name: "destinationCaller", type: "bytes32" },
    { name: "value", type: "uint256" },
    { name: "salt", type: "bytes32" },
    { name: "hookData", type: "bytes" },
  ],
  BurnIntent: [
    { name: "maxBlockHeight", type: "uint256" },
    { name: "maxFee", type: "uint256" },
    { name: "spec", type: "TransferSpec" },
  ],
} as const;

export interface TransferSpec {
  version: number;
  sourceDomain: number;
  destinationDomain: number;
  sourceContract: Hex;
  destinationContract: Hex;
  sourceToken: Hex;
  destinationToken: Hex;
  sourceDepositor: Hex;
  destinationRecipient: Hex;
  sourceSigner: Hex;
  destinationCaller: Hex;
  value: bigint;
  salt: Hex;
  hookData: Hex;
}

export interface BurnIntent {
  maxBlockHeight: bigint;
  maxFee: bigint;
  spec: TransferSpec;
}

const b32 = (a: Address): Hex => pad(a.toLowerCase() as Hex, { size: 32 });

/**
 * The same payout attempt always carries the same salt, so asking Gateway
 * twice for one attempt names one transfer rather than two.
 */
export function payoutSalt(payoutId: string, attempt: number): Hex {
  return keccak256(toHex(`sportsarc-payout:${payoutId}:${attempt}`));
}

/** `value` of the depositor's balance on `source`, minted to `recipient` on `destination`. */
export function transferSpec(a: {
  source: GatewayChain;
  destination: GatewayChain;
  depositor: Address;
  recipient: Address;
  value: bigint;
  salt: Hex;
}): TransferSpec {
  return {
    version: 1,
    sourceDomain: a.source.domain,
    destinationDomain: a.destination.domain,
    sourceContract: b32(GATEWAY_TESTNET.wallet),
    destinationContract: b32(GATEWAY_TESTNET.minter),
    sourceToken: b32(a.source.usdc),
    destinationToken: b32(a.destination.usdc),
    sourceDepositor: b32(a.depositor),
    destinationRecipient: b32(a.recipient),
    sourceSigner: b32(a.depositor),
    destinationCaller: b32(zeroAddress), // anyone may mint: Circle's forwarder does
    value: a.value,
    salt: a.salt,
    hookData: "0x",
  };
}

/** Signatures are local; the account never touches an RPC. */
export function signBurnIntent(signer: LocalAccount, intent: BurnIntent): Promise<Hex> {
  return signer.signTypedData({
    domain: GATEWAY_DOMAIN,
    types: BURN_INTENT_TYPES,
    primaryType: "BurnIntent",
    message: intent,
  });
}

/** JSON has no bigint: amounts go out as decimal strings. */
export function toJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}
