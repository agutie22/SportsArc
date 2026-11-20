/**
 * PIN-signed typed data: how a player authorizes something without sending
 * a transaction or paying gas. The server builds EIP-712 data, opens a
 * Circle challenge for the player's Arc wallet, and the browser posts back
 * the signature the web SDK returns. acceptSignature checks that signature
 * against the data stored here and the player's wallet address before
 * anything is relayed with it (relayer/submit.ts).
 *
 * Eligibility is the same as for a signed transaction (service.ts
 * mayTransact): a signature here moves money, so only adults and guardians
 * get a challenge.
 */

import type { EntityManager } from "@mikro-orm/postgresql";
import { getAddress, isAddress, verifyTypedData, type Address, type Hex } from "viem";
import { circleUserIdFor, type User } from "../../entities/User.js";
import { fail, type Failure } from "../../failure.js";
import { isUuid } from "../../validate.js";
import { arcBlockchain, circleApi } from "./circle.js";
import { mayTransact, type ChallengeHandoff } from "./service.js";
import { UserSignature } from "./UserSignature.js";

const MEMO_MAX = 120;

export interface TypedField {
  name: string;
  type: string;
}

/** EIP-712 data in viem's form: integers are bigint, no EIP712Domain type. */
export interface TypedData {
  domain: { name: string; version: string; chainId: number; verifyingContract: Address };
  types: Record<string, readonly TypedField[]>;
  primaryType: string;
  message: Record<string, unknown>;
}

const DOMAIN_TYPE: TypedField[] = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
];

/** The JSON Circle signs: eth_signTypedData_v4's shape, integers as decimal strings. */
export function typedDataJson(data: TypedData): string {
  return JSON.stringify(
    { types: { EIP712Domain: DOMAIN_TYPE, ...data.types }, primaryType: data.primaryType, domain: data.domain, message: data.message },
    (_key, value) => (typeof value === "bigint" ? value.toString() : value),
  );
}

/** One stored value back in viem's form, by its declared type. */
function revive(types: TypedData["types"], type: string, value: unknown): unknown {
  const array = /^(.*)\[\d*\]$/.exec(type);
  if (array) return (value as unknown[]).map((v) => revive(types, array[1], v));
  if (/^u?int\d*$/.test(type)) return BigInt(value as string | number);
  const struct = types[type];
  if (struct) {
    const row = value as Record<string, unknown>;
    return Object.fromEntries(struct.map((f) => [f.name, revive(types, f.type, row[f.name])]));
  }
  return value;
}

/** typedDataJson's inverse. */
export function parseTypedDataJson(json: string): TypedData {
  const raw = JSON.parse(json) as TypedData & { types: Record<string, TypedField[]> };
  const { EIP712Domain: _domain, ...types } = raw.types;
  return {
    domain: { ...raw.domain, chainId: Number(raw.domain.chainId), verifyingContract: getAddress(raw.domain.verifyingContract) },
    types,
    primaryType: raw.primaryType,
    message: revive(types, raw.primaryType, raw.message) as Record<string, unknown>,
  };
}

export async function signedBy(address: Address, data: TypedData, signature: Hex): Promise<boolean> {
  try {
    return await verifyTypedData({ address, ...data, signature } as Parameters<typeof verifyTypedData>[0]);
  } catch {
    return false;
  }
}

export type SignatureRequest = { ok: true; signatureId: string; signer: Address; challenge: ChallengeHandoff } | Failure;

/**
 * Store `typedData` and open the challenge for the user to sign it. `kind`
 * names what it authorizes; acceptSignature must be given the same one.
 */
export async function requestSignature(
  em: EntityManager,
  user: User,
  input: { kind: string; typedData: TypedData; memo?: string },
): Promise<SignatureRequest> {
  if (!mayTransact(user)) return fail("INELIGIBLE", "Only adult and guardian accounts can move money.");
  const circle = circleApi();
  if (!circle) return fail("NOT_CONFIGURED", "Circle is not configured (CIRCLE_API_KEY).");
  const raw = user.walletAddress?.trim() ?? "";
  if (!isAddress(raw)) return fail("NO_WALLET", "Set up your wallet first.");
  const signer = getAddress(raw);

  let challenge: ChallengeHandoff;
  try {
    const auth = await circle.userToken(circleUserIdFor(user));
    const wallets = await circle.listWallets(auth.userToken);
    const chain = arcBlockchain();
    const wallet = wallets.find((w) => w.blockchain === chain && w.address.toLowerCase() === signer.toLowerCase());
    if (!wallet) return fail("NO_WALLET", "Set up your wallet first.");
    const challengeId = await circle.signTypedData({
      userToken: auth.userToken,
      walletId: wallet.id,
      data: typedDataJson(input.typedData),
      memo: input.memo?.trim().slice(0, MEMO_MAX) || undefined,
    });
    challenge = { challengeId, ...auth };
  } catch (err) {
    return fail("CIRCLE_FAILED", `Circle request failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const row = new UserSignature();
  row.user = user;
  row.kind = input.kind;
  row.signerAddress = signer;
  row.typedData = typedDataJson(input.typedData);
  row.challengeId = challenge.challengeId;
  em.persist(row);
  await em.flush();
  return { ok: true, signatureId: row.id, signer, challenge };
}

export interface SignedTypedData {
  id: string;
  signer: Address;
  typedData: TypedData;
  signature: Hex;
}

export type SignatureResult = { ok: true; signed: SignedTypedData } | Failure;

/**
 * The browser's signature for a request of this user's: checked against the
 * stored data and wallet, then kept. Posting the same signature again is
 * fine; a different one for a request already signed is refused.
 */
export async function acceptSignature(
  em: EntityManager,
  user: User,
  input: { signatureId: unknown; kind: string; signature: unknown },
): Promise<SignatureResult> {
  const id = typeof input.signatureId === "string" ? input.signatureId : "";
  const row = isUuid(id) ? await em.findOne(UserSignature, { id, user, kind: input.kind }) : null;
  if (!row) return fail("SIGNATURE_NOT_FOUND", "There is nothing waiting to be signed.");
  const raw = typeof input.signature === "string" ? input.signature.trim().toLowerCase() : "";
  if (!/^0x[0-9a-f]{130}$/.test(raw)) return fail("VALIDATION_ERROR", "signature must be a 65-byte hex signature.");
  const signature = raw as Hex;
  const signer = getAddress(row.signerAddress);
  const typedData = parseTypedDataJson(row.typedData);

  if (row.status === "signed") {
    if (row.signature !== signature) return fail("SIGNATURE_MISMATCH", "This was already signed.");
    return { ok: true, signed: { id: row.id, signer, typedData, signature } };
  }
  if (!(await signedBy(signer, typedData, signature))) {
    return fail("SIGNATURE_MISMATCH", "That signature is not from your wallet for this request.");
  }
  row.status = "signed";
  row.signature = signature;
  row.signedAt = new Date();
  await em.flush();
  return { ok: true, signed: { id: row.id, signer, typedData, signature } };
}
