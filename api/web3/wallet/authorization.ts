/**
 * EIP-3009 authorizations on USDC: the typed data a player signs to move
 * their own USDC without sending a transaction, and the call that spends
 * it. Whoever submits the call pays the gas; here that is the relayer
 * (relayer/submit.ts).
 *
 *   transfer  transferWithAuthorization: anyone may submit it. For paying a
 *             person.
 *   receive   receiveWithAuthorization: only `to` may submit it, so a
 *             contract that calls it knows the money was meant for it. For
 *             paying into a contract.
 *
 * The EIP-712 domain is read from the token (name, version) rather than
 * assumed. On Arc testnet it is "USDC", "2", chain 5042002, at
 * 0x3600…0000.
 */

import { randomBytes } from "node:crypto";
import { parseAbi, parseSignature, toHex, type Address, type Hex } from "viem";
import { fail, type Failure } from "../../failure.js";
import { usdcFor, walletClientFor } from "./networks.js";
import type { TypedData, TypedField } from "./signature.js";

export const usdcAuthorizationAbi = parseAbi([
  "function name() view returns (string)",
  "function version() view returns (string)",
  "function balanceOf(address account) view returns (uint256)",
  "function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)",
  "function receiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
]);

export const AUTHORIZATION_FIELDS: readonly TypedField[] = [
  { name: "from", type: "address" },
  { name: "to", type: "address" },
  { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" },
  { name: "validBefore", type: "uint256" },
  { name: "nonce", type: "bytes32" },
];

const PRIMARY = { transfer: "TransferWithAuthorization", receive: "ReceiveWithAuthorization" } as const;
export type AuthorizationKind = keyof typeof PRIMARY;

/** How long a player has to enter their PIN, and the relayer to submit. */
export const AUTHORIZATION_TTL_S = 60 * 60;

export interface Authorization {
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
}

export type UsdcDomain = TypedData["domain"];

const domains = new Map<string, UsdcDomain>();

/** The token's EIP-712 domain on `chainId`, read once per process. */
export async function usdcDomain(chainId: number): Promise<{ ok: true; domain: UsdcDomain } | Failure> {
  const usdc = usdcFor(chainId);
  const chain = walletClientFor(chainId);
  if (!usdc || !chain.ok) return fail("NOT_CONFIGURED", "Payments are not configured on this server.");
  const key = `${chainId}:${usdc}`;
  let domain = domains.get(key);
  if (!domain) {
    try {
      const [name, version] = await Promise.all([
        chain.client.readContract({ address: usdc, abi: usdcAuthorizationAbi, functionName: "name" }),
        chain.client.readContract({ address: usdc, abi: usdcAuthorizationAbi, functionName: "version" }),
      ]);
      domain = { name, version, chainId, verifyingContract: usdc };
      domains.set(key, domain);
    } catch (err) {
      return fail("CHAIN_UNAVAILABLE", `Could not read USDC: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`);
    }
  }
  return { ok: true, domain };
}

/**
 * An authorization for `value` from `from` to `to`, valid from now for
 * AUTHORIZATION_TTL_S. `nonce` defaults to a random one; pass one to bind
 * the authorization to a single purpose (EventVault requires that).
 */
export function newAuthorization(input: { from: Address; to: Address; value: bigint; nonce?: Hex }): Authorization {
  return {
    from: input.from,
    to: input.to,
    value: input.value,
    validAfter: 0n,
    validBefore: BigInt(Math.floor(Date.now() / 1000) + AUTHORIZATION_TTL_S),
    nonce: input.nonce ?? toHex(randomBytes(32)),
  };
}

export function authorizationTypedData(kind: AuthorizationKind, domain: UsdcDomain, auth: Authorization): TypedData {
  return {
    domain,
    types: { [PRIMARY[kind]]: AUTHORIZATION_FIELDS },
    primaryType: PRIMARY[kind],
    message: { ...auth },
  };
}

/** The authorization inside typed data built by authorizationTypedData. */
export function authorizationOf(data: TypedData): Authorization {
  return data.message as unknown as Authorization;
}

/** A 65-byte signature as the (v, r, s) the token's functions take. */
export function splitSignature(signature: Hex): { v: number; r: Hex; s: Hex } {
  const { r, s, v, yParity } = parseSignature(signature);
  return { v: Number(v ?? BigInt(yParity) + 27n), r, s };
}

/** Arguments for transferWithAuthorization / receiveWithAuthorization. */
export function authorizationArgs(auth: Authorization, signature: Hex) {
  const { v, r, s } = splitSignature(signature);
  return [auth.from, auth.to, auth.value, auth.validAfter, auth.validBefore, auth.nonce, v, r, s] as const;
}
