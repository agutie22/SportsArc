/**
 * Wallet workstream handlers: the user's EVM-TESTNET wallet, transactions
 * it signs through Circle, and balances. Each returns a result object;
 * routes.ts maps error codes to HTTP statuses.
 *
 * Chains: the wallet is one address on every EVM testnet, so a tx can be
 * built on any chain networks.ts allows (Arc testnet). Arc withdrawals
 * sign through this wallet.
 * prepareUserTx takes an optional chainId (default WEB3_CHAIN);
 * submit and status use the chain stored on the tx row. Users pay their own
 * gas, so the gas quote and shortfall are for that chain's
 * native balance.
 *
 * Eligibility (M4): a Circle user-controlled wallet signs only
 * through a challenge that this server opens, so this is where a minor's
 * wallet stays receive-and-hold. Every user-signed tx spends at least gas,
 * so every one counts as a money path: only a self-declared adult or
 * guardian may prepare one, and "minor" or unset fails closed. Creating the
 * wallet and reading balances are open to everyone.
 *
 * Other workstreams that need a user-signed tx (e.g. moving money to another network)
 * call prepareUserTx with their own calldata and `kind`.
 */

import type { EntityManager } from "@mikro-orm/postgresql";
import { getAddress, isHex, keccak256, type Address, type Hex } from "viem";
import { circleUserIdFor, type User } from "../../entities/User.js";
import { UserEvmWallet } from "./UserEvmWallet.js";
import { EVM_TESTNET, arcBlockchain, circleApi, pickEvmWallet } from "./circle.js";
import { UserEvmTx, type EvmTxStatus } from "./UserEvmTx.js";
import {
  defaultChainId,
  usdcAddress,
  walletChains,
  walletClientFor,
  type WalletChain,
} from "./networks.js";
import {
  broadcast,
  buildTx,
  failure,
  receiptState,
  verifySignedTx,
  type Failure,
  type Funds,
  type GasQuote,
} from "./tx.js";
import { isUuid } from "../../validate.js";

const KIND_MAX = 32;

export function mayTransact(user: Pick<User, "audience">): boolean {
  return user.audience === "adult" || user.audience === "guardian";
}

function notConfigured(): Failure {
  return failure("NOT_CONFIGURED", "Circle is not configured (CIRCLE_API_KEY).");
}

async function circleCall<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | Failure> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return failure("CIRCLE_FAILED", `Circle request failed: ${message}`);
  }
}

// ── wallet ──

export interface WalletView {
  blockchain: typeof EVM_TESTNET;
  status: "none" | "pending" | "ready";
  /** The EVM-TESTNET wallet, once Circle lists it. */
  address: string | null;
  /** The user's Arc wallet; the EVM-TESTNET wallet has the same address. */
  arcAddress: string | null;
  /** WEB3_CHAIN: where a tx goes when the caller names no chain. */
  chainId: number;
  usdcAddress: string | null;
  /** Every chain the wallet can build txs on, with its USDC token. */
  chains: WalletChain[];
  canTransact: boolean;
}

function walletView(user: User, link: UserEvmWallet | null): WalletView {
  return {
    blockchain: EVM_TESTNET,
    status: link?.address ? "ready" : link?.challengeId ? "pending" : "none",
    address: link?.address ?? null,
    arcAddress: user.walletAddress ?? null,
    chainId: defaultChainId(),
    usdcAddress: usdcAddress(),
    chains: walletChains(),
    canTransact: mayTransact(user),
  };
}

/** A challenge for the browser's Circle SDK to execute. */
export interface ChallengeHandoff {
  challengeId: string;
  userToken: string;
  encryptionKey: string;
}

export type EnsureWalletResult =
  | { ok: true; wallet: WalletView; challenge: ChallengeHandoff | null }
  | Failure;

/**
 * Link the user's EVM-TESTNET wallet, or start creating it. Idempotent: the
 * browser calls it, completes the returned challenge, and calls it again.
 */
export async function ensureWallet(fork: EntityManager, user: User): Promise<EnsureWalletResult> {
  const circle = circleApi();
  if (!circle) return notConfigured();
  const arcAddress = user.walletAddress;
  if (!arcAddress) {
    return failure("NO_ARC_WALLET", "Set up your wallet first (POST /api/auth/init).");
  }

  let link = await fork.findOne(UserEvmWallet, { user });
  if (link?.address) return { ok: true, wallet: walletView(user, link), challenge: null };

  const auth = await circleCall(() => circle.userToken(circleUserIdFor(user)));
  if (!auth.ok) return auth;
  const { userToken, encryptionKey } = auth.value;

  const listed = await circleCall(() => circle.listWallets(userToken));
  if (!listed.ok) return listed;

  if (!link) {
    link = new UserEvmWallet();
    link.user = user;
    fork.persist(link);
  }

  const found = pickEvmWallet(listed.value, arcAddress, arcBlockchain());
  if (found) {
    if (found.address.toLowerCase() !== arcAddress.toLowerCase()) {
      return failure(
        "ADDRESS_MISMATCH",
        `Circle's EVM-TESTNET wallet is ${found.address}, not the Arc address ${arcAddress}.`,
      );
    }
    link.circleWalletId = found.id;
    link.address = getAddress(found.address);
    link.challengeId = null;
    await fork.flush();
    return { ok: true, wallet: walletView(user, link), challenge: null };
  }

  // Not listed yet: hand back the open challenge, wait on a completed one,
  // or open a new one if the last failed or expired.
  const openId = link.challengeId;
  if (openId) {
    const status = await circleCall(() => circle.challengeStatus(userToken, openId));
    if (!status.ok) return status;
    if (status.value === "PENDING" || status.value === "IN_PROGRESS") {
      return {
        ok: true,
        wallet: walletView(user, link),
        challenge: { challengeId: openId, userToken, encryptionKey },
      };
    }
    if (status.value === "COMPLETE") {
      return { ok: true, wallet: walletView(user, link), challenge: null };
    }
  }

  const created = await circleCall(() => circle.createEvmTestnetWallet(userToken));
  if (!created.ok) return created;
  link.challengeId = created.value;
  await fork.flush();
  return {
    ok: true,
    wallet: walletView(user, link),
    challenge: { challengeId: created.value, userToken, encryptionKey },
  };
}

// ── transactions ──

export interface PrepareTxInput {
  /** Any chain networks.ts allows; defaults to WEB3_CHAIN. */
  chainId?: number;
  to: Address;
  value?: bigint;
  data?: Hex;
  /** Shown in Circle's confirmation screen. */
  memo?: string;
  /** What the tx is for, e.g. "cctp_burn". Defaults to "call". */
  kind?: string;
}

export interface TxView {
  id: string;
  kind: string;
  status: EvmTxStatus;
  chainId: number;
  from: string;
  to: string;
  value: string;
  data: string;
  nonce: number;
  gasLimit: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  memo: string | null;
  challengeId: string | null;
  txHash: string | null;
  blockNumber: string | null;
  gasUsed: string | null;
  error: string | null;
  createdAt: Date;
  submittedAt: Date | null;
}

export function txView(row: UserEvmTx): TxView {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    chainId: row.chainId,
    from: row.fromAddress,
    to: row.toAddress,
    value: row.value,
    data: row.data,
    nonce: row.nonce,
    gasLimit: row.gasLimit,
    maxFeePerGas: row.maxFeePerGas,
    maxPriorityFeePerGas: row.maxPriorityFeePerGas,
    memo: row.memo ?? null,
    challengeId: row.challengeId ?? null,
    txHash: row.txHash ?? null,
    blockNumber: row.blockNumber ?? null,
    gasUsed: row.gasUsed ?? null,
    error: row.error ?? null,
    createdAt: row.createdAt,
    submittedAt: row.submittedAt ?? null,
  };
}

/** What the tx needs in gas, and whether the wallet holds it. Who pays is still open. */
export interface GasView {
  gasLimit: string;
  baseFeePerGas: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  maxCostWei: string;
  expectedCostWei: string;
  balanceWei: string;
  requiredWei: string;
  sufficient: boolean;
  shortfallWei: string;
}

function gasView(quote: GasQuote, funds: Funds): GasView {
  return {
    gasLimit: quote.gasLimit.toString(),
    baseFeePerGas: quote.baseFeePerGas.toString(),
    maxFeePerGas: quote.maxFeePerGas.toString(),
    maxPriorityFeePerGas: quote.maxPriorityFeePerGas.toString(),
    maxCostWei: quote.maxCostWei.toString(),
    expectedCostWei: quote.expectedCostWei.toString(),
    balanceWei: funds.balanceWei.toString(),
    requiredWei: funds.requiredWei.toString(),
    sufficient: funds.sufficient,
    shortfallWei: funds.shortfallWei.toString(),
  };
}

export type PrepareTxResult =
  | { ok: true; tx: TxView; gas: GasView; challenge: ChallengeHandoff }
  | Failure;

/**
 * Build a tx from the user's EVM-TESTNET wallet on `input.chainId` (default
 * WEB3_CHAIN) and open a Circle challenge for them to sign it. Any earlier
 * unsigned tx of theirs on the same chain is superseded, so two prepared
 * txs never share a nonce; unsigned txs on different chains coexist, since
 * each chain has its own nonce.
 */
export async function prepareUserTx(
  fork: EntityManager,
  user: User,
  input: PrepareTxInput,
): Promise<PrepareTxResult> {
  if (!mayTransact(user)) {
    return failure("INELIGIBLE", "Only adult and guardian accounts can send transactions.");
  }
  const kind = input.kind ?? "call";
  if (!kind || kind.length > KIND_MAX) return failure("VALIDATION_ERROR", "kind is 1-32 characters.");
  const chainId = input.chainId ?? defaultChainId();
  const chain = walletClientFor(chainId);
  if (!chain.ok) return chain;
  const circle = circleApi();
  if (!circle) return notConfigured();

  const link = await fork.findOne(UserEvmWallet, { user });
  const walletId = link?.circleWalletId;
  if (!link?.address || !walletId) {
    return failure("WALLET_NOT_READY", "Set up your wallet first (POST /api/web3/wallet).");
  }

  const value = input.value ?? 0n;
  const data = input.data ?? "0x";
  const built = await buildTx(chain.client, {
    from: getAddress(link.address), to: input.to, value, data,
  });
  if (!built.ok) return built;
  const { tx, unsigned, quote, funds } = built.built;

  const auth = await circleCall(() => circle.userToken(circleUserIdFor(user)));
  if (!auth.ok) return auth;
  const memo = input.memo?.trim() || undefined;
  const challenge = await circleCall(() => circle.signTransaction({
    userToken: auth.value.userToken, walletId, rawTransaction: unsigned, memo,
  }));
  if (!challenge.ok) return challenge;

  const open = await fork.find(UserEvmTx, { user, chainId: tx.chainId, status: "awaiting_signature" });
  for (const old of open) old.status = "superseded";

  const row = new UserEvmTx();
  row.user = user;
  row.kind = kind;
  row.chainId = tx.chainId;
  row.fromAddress = getAddress(link.address);
  row.toAddress = input.to;
  row.value = value.toString();
  row.data = data;
  row.nonce = tx.nonce;
  row.gasLimit = quote.gasLimit.toString();
  row.maxFeePerGas = quote.maxFeePerGas.toString();
  row.maxPriorityFeePerGas = quote.maxPriorityFeePerGas.toString();
  row.unsignedTx = unsigned;
  row.memo = memo ?? null;
  row.challengeId = challenge.value;
  fork.persist(row);
  await fork.flush();

  return {
    ok: true,
    tx: txView(row),
    gas: gasView(quote, funds),
    challenge: { challengeId: challenge.value, ...auth.value },
  };
}

async function findTx(fork: EntityManager, user: User, id: string): Promise<UserEvmTx | null> {
  if (!isUuid(id)) return null;
  return fork.findOne(UserEvmTx, { id, user });
}

export type TxResult = { ok: true; tx: TxView } | Failure;

/**
 * Take the signed tx the browser got from Circle's SDK, check it is the tx
 * we built signed by the user's wallet, and broadcast it.
 */
export async function submitSignedTx(
  fork: EntityManager,
  user: User,
  txId: string,
  signedTransaction: unknown,
): Promise<TxResult> {
  const row = await findTx(fork, user, txId);
  if (!row) return failure("TX_NOT_FOUND", "No such transaction.");
  if (typeof signedTransaction !== "string" || !isHex(signedTransaction)) {
    return failure("VALIDATION_ERROR", "signedTransaction must be 0x-prefixed hex.");
  }
  const signed = signedTransaction.toLowerCase() as Hex;

  if (row.status !== "awaiting_signature") {
    // A retry of a post that already went through.
    if (row.txHash && keccak256(signed) === row.txHash) return { ok: true, tx: txView(row) };
    return failure("TX_STATE", `This transaction is ${row.status}.`);
  }

  const verified = await verifySignedTx(signed, row.unsignedTx as Hex, getAddress(row.fromAddress));
  if (!verified.ok) return verified;

  const chain = walletClientFor(row.chainId);
  if (!chain.ok) return chain;
  const client = chain.client;
  // A misconfigured RPC must not turn a good signature into a "failed" row.
  let served: number;
  try {
    served = await client.getChainId();
  } catch (err) {
    return failure("CHAIN_UNAVAILABLE", `Chain RPC failed: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`);
  }
  if (served !== row.chainId) {
    return failure("CHAIN_MISMATCH", `Built for chain ${row.chainId}; its RPC serves ${served}.`);
  }
  const sent = await broadcast(client, signed);
  if (!sent.ok) {
    if (sent.transient) {
      return failure("CHAIN_UNAVAILABLE", `Broadcast failed; post it again: ${sent.message}`);
    }
    row.status = "failed";
    row.error = sent.message;
    await fork.flush();
    return failure("BROADCAST_REJECTED", sent.message);
  }

  row.status = "submitted";
  row.txHash = sent.hash;
  row.submittedAt = new Date();
  await fork.flush();
  return { ok: true, tx: txView(row) };
}

/**
 * The tx, with its receipt checked first on its own chain if it is still in
 * flight. A submitted tx that never mined and whose nonce the wallet has
 * since used is written "dropped": it can never mine, so the caller may
 * prepare it again.
 */
export async function txStatus(fork: EntityManager, user: User, txId: string): Promise<TxResult> {
  const row = await findTx(fork, user, txId);
  if (!row) return failure("TX_NOT_FOUND", "No such transaction.");
  if (row.status !== "submitted" || !row.txHash) return { ok: true, tx: txView(row) };

  const chain = walletClientFor(row.chainId);
  if (!chain.ok) return chain;
  const r = await receiptState(chain.client, row.txHash as Hex, {
    from: getAddress(row.fromAddress),
    nonce: row.nonce,
  });
  if (!r.ok) return r;
  const receipt = r.receipt;
  if (receipt.state === "dropped") {
    row.status = "dropped";
    row.error = `Never mined: nonce ${row.nonce} on chain ${row.chainId} was used by another transaction`
      + ` (the wallet has sent ${receipt.nonceNow}).`;
    await fork.flush();
  } else if (receipt.state !== "pending") {
    row.status = receipt.state;
    row.blockNumber = receipt.blockNumber.toString();
    row.gasUsed = receipt.gasUsed.toString();
    await fork.flush();
  }
  return { ok: true, tx: txView(row) };
}

export type ChallengeResult =
  | { ok: true; tx: TxView; challenge: ChallengeHandoff }
  | Failure;

/**
 * Fresh Circle keys for a tx's signing challenge. Circle's userToken lasts
 * about an hour; the challenge itself stays open longer, so a UI that lost
 * or outlived its token resumes the same challengeId with a new token
 * instead of preparing (and superseding) the tx again. Only the owner's
 * tx, only while it awaits a signature, only for an account that may
 * still transact, and only while Circle says the challenge is open.
 */
export async function reissueChallenge(
  fork: EntityManager,
  user: User,
  txId: string,
): Promise<ChallengeResult> {
  if (!mayTransact(user)) {
    return failure("INELIGIBLE", "Only adult and guardian accounts can send transactions.");
  }
  const row = await findTx(fork, user, txId);
  if (!row) return failure("TX_NOT_FOUND", "No such transaction.");
  const challengeId = row.challengeId;
  if (row.status !== "awaiting_signature" || !challengeId) {
    return failure("TX_STATE", `This transaction is ${row.status}; there is nothing to sign.`);
  }
  const circle = circleApi();
  if (!circle) return notConfigured();

  const auth = await circleCall(() => circle.userToken(circleUserIdFor(user)));
  if (!auth.ok) return auth;
  const status = await circleCall(() => circle.challengeStatus(auth.value.userToken, challengeId));
  if (!status.ok) return status;
  if (status.value !== "PENDING" && status.value !== "IN_PROGRESS") {
    return failure(
      "CHALLENGE_CLOSED",
      `Circle reports the signing challenge as ${status.value || "unknown"}; `
        + (status.value === "COMPLETE"
          ? "post the signed transaction, or prepare it again if it was lost."
          : "prepare the transaction again."),
    );
  }
  return { ok: true, tx: txView(row), challenge: { challengeId, ...auth.value } };
}
