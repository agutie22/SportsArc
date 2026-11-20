/**
 * The CCTP withdrawal state machine (states in CctpTransfer.ts). Starting
 * a withdrawal writes a row and moves nothing. advanceTransfer does whatever
 * the current state allows and records it: it reads chains and Iris freely,
 * and opens a signing request for the user's own wallet only when the
 * caller passes `sign: true` (the withdrawal route). The timer never passes
 * it, so it never competes with other features for the user's pending
 * signature (prepareUserTx supersedes the older one).
 *
 * Every step is idempotent and resumable after a restart. The chain is the
 * source of truth: an allowance already in place skips its approval. A new
 * tx is only prepared when the step has none in flight, so a burn is never
 * prepared twice while one could still land. Each transfer is advanced
 * under a row lock (SKIP LOCKED), so the timer and a request never act on
 * it at once.
 *
 * Withdrawals (startWithdrawal): Arc to any chain in CCTP_TESTNETS, HyperEVM
 * included, to the user's wallet or any address they give. The burn carries
 * the Forwarding Service hook and a max fee covering Circle's forwarding
 * quote, so Circle submits the mint and the user signs only the approval
 * and the burn, both on Arc, through the EVM-TESTNET wallet. The receive
 * step waits for the mint (Iris forwardTxHash, or the nonce used on the
 * destination) and opens no signing request.
 *
 * Eligibility: only a self-declared adult or guardian may start one; minor
 * or unset fails closed. prepareUserTx checks it again on every signing
 * request.
 *
 * Gas: the user pays Arc's native USDC for the approval and the burn. The
 * destination mint is Circle's, so the recipient needs no gas there.
 */

import { LockMode } from "@mikro-orm/core";
import type { EntityManager } from "@mikro-orm/postgresql";
import {
  BaseError,
  ContractFunctionRevertedError,
  encodeFunctionData,
  formatUnits,
  getAddress,
  isAddress,
  isAddressEqual,
  parseEventLogs,
  parseUnits,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { User } from "../../entities/User.js";
import { mayTransact, type ChallengeHandoff } from "../wallet/service.js";
import { UserEvmWallet } from "../wallet/UserEvmWallet.js";
import { messageTransmitterV2Abi, tokenMessengerV2Abi, usdcAbi } from "./abi.js";
import { CctpTransfer, type CctpState } from "./CctpTransfer.js";
import {
  CCTP_TESTNETS,
  FINALITY_STANDARD,
  FORWARD_HOOK_DATA,
  WITHDRAW_SOURCE,
  cctpChainById,
  cctpChainByKey,
  clientFor,
  explorerFor,
  refuseRoute,
  type CctpChain,
  type CctpRoute,
} from "./config.js";
import { irisClient, type IrisClient } from "./iris.js";
import {
  addressToBytes32,
  attestationSigners,
  burnMismatch,
  decodeBurnMessage,
  messagesSent,
  mintedAmount,
  sameBurn,
  type BurnExpectation,
} from "./message.js";
import { failure, walletSigner, type Failure, type StepSigner, type StepTx } from "./signer.js";

// ── dependencies (swappable for tests) ──

export interface CctpDeps {
  client(chain: CctpChain): PublicClient;
  iris: IrisClient;
  signer: StepSigner;
  now(): Date;
}

let overrides: Partial<CctpDeps> | undefined;

/** Tests only: replace some dependencies; undefined restores the defaults. */
export function setCctpDeps(deps: Partial<CctpDeps> | undefined): void {
  overrides = deps;
}

export function cctpDeps(): CctpDeps {
  return {
    client: overrides?.client ?? clientFor,
    iris: overrides?.iris ?? irisClient(),
    signer: overrides?.signer ?? walletSigner(),
    now: overrides?.now ?? (() => new Date()),
  };
}

// ── amounts and polling ──

const USDC_DECIMALS = 6;
/** TokenMinterV2.burnLimitsPerMessage for USDC on both testnets (1e13). */
const MAX_AMOUNT = 10_000_000_000_000n;
const MAX_STEPS_PER_ADVANCE = 12;

export function parseUsdcAmount(raw: unknown): bigint | null {
  if (typeof raw !== "string" || !/^\d{1,8}(\.\d{1,6})?$/.test(raw.trim())) return null;
  const units = parseUnits(raw.trim(), USDC_DECIMALS);
  return units > 0n && units <= MAX_AMOUNT ? units : null;
}

/** Iris backoff: 5 s doubling to 5 min; a rate limit waits Circle's 5 min block. */
export function irisDelayMs(polls: number, rateLimited = false): number {
  if (rateLimited) return 5 * 60_000;
  return Math.min(5_000 * 2 ** Math.min(polls, 10), 5 * 60_000);
}

// ── views ──

/** "relay": a withdrawal's burn is attested and Circle has yet to mint it. */
export type WaitingOn = "signature" | "confirmation" | "attestation" | "relay" | "retry" | null;

export interface TransferView {
  id: string;
  state: CctpState;
  amount: { units: string; usdc: string };
  mintedAmount: { units: string; usdc: string } | null;
  wallet: string;
  /** Where the USDC is minted: the wallet unless the user named another address. */
  recipient: string;
  forward: boolean;
  source: { chainId: number; domain: number; name: string | null; explorer: string | null };
  destination: { chainId: number; domain: number; name: string | null; explorer: string | null };
  maxFee: string | null;
  minFinalityThreshold: number;
  stepTxId: string | null;
  txs: {
    burnApproval: string | null;
    burn: string | null;
    receive: string | null;
  };
  nonce: string | null;
  attested: boolean;
  irisPolls: number;
  nextCheckAt: Date | null;
  lastError: { code: string; message: string } | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

function usdc(units: string): { units: string; usdc: string } {
  return { units, usdc: formatUnits(BigInt(units), USDC_DECIMALS) };
}

function chainView(chainId: number, domain: number) {
  const chain = cctpChainById(chainId);
  return { chainId, domain, name: chain?.name ?? null, explorer: chain ? explorerFor(chain) : null };
}

export function transferView(t: CctpTransfer): TransferView {
  return {
    id: t.id,
    state: t.state,
    amount: usdc(t.amount),
    mintedAmount: t.mintedAmount ? usdc(t.mintedAmount) : null,
    wallet: t.walletAddress,
    recipient: t.recipientAddress ?? t.walletAddress,
    forward: t.forward,
    source: chainView(t.sourceChainId, t.sourceDomain),
    destination: chainView(t.destinationChainId, t.destinationDomain),
    maxFee: t.maxFee ?? null,
    minFinalityThreshold: t.minFinalityThreshold,
    stepTxId: t.stepTxId ?? null,
    txs: {
      burnApproval: t.burnApprovalTxHash ?? null,
      burn: t.burnTxHash ?? null,
      receive: t.receiveTxHash ?? null,
    },
    nonce: t.nonce ?? null,
    attested: Boolean(t.attestation),
    irisPolls: t.irisPolls,
    nextCheckAt: t.nextCheckAt ?? null,
    lastError: t.lastErrorCode ? { code: t.lastErrorCode, message: t.lastError ?? "" } : null,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    completedAt: t.completedAt ?? null,
  };
}

// ── withdrawals ──

export type TransferResult = { ok: true; transfer: TransferView } | Failure;

const ACTIVE: CctpState[] = ["burn_approval", "burn", "attestation", "receive"];


export interface WithdrawInput {
  amount: unknown;
  /** A CCTP_TESTNETS key other than the source, e.g. "baseSepolia". */
  destination: unknown;
  /** Defaults to the user's own wallet (the same address on every EVM chain). */
  recipient?: unknown;
}

export interface Destination {
  key: string;
  name: string;
  chainId: number;
  domain: number;
  explorer: string | null;
}

/** Where a withdrawal from Arc may go. */
export function withdrawDestinations(): { source: Destination; destinations: Destination[] } {
  const view = (c: CctpChain): Destination =>
    ({ key: c.key, name: c.name, chainId: c.chainId, domain: c.domain, explorer: explorerFor(c) });
  return {
    source: view(WITHDRAW_SOURCE),
    destinations: CCTP_TESTNETS.filter((c) => c.chainId !== WITHDRAW_SOURCE.chainId).map(view),
  };
}

export type WithdrawQuote =
  | { ok: true; amount: string; fee: string; receive: string; destination: Destination }
  | Failure;

/**
 * Max fee for a forwarded burn: Circle's forwarding quote ("med") plus the
 * protocol fee, rounded up.
 */
async function forwardMaxFee(deps: CctpDeps, route: CctpRoute, amount: bigint, finality: number):
  Promise<{ ok: true; maxFee: bigint } | Failure> {
  const r = await deps.iris.fees(route.source.domain, route.destination.domain, true);
  if (!r.ok) return failure(r.error.code, r.error.message);
  const row = r.fees.find((f) => f.finalityThreshold === finality);
  if (!row || row.forwardFee === null) {
    return failure("FORWARDING_UNAVAILABLE", `Circle quotes no forwarding to ${route.destination.name}.`);
  }
  // minimumFee is in bps and may be fractional: work in hundredths of a bp.
  const hundredthsBps = BigInt(Math.ceil(row.minimumFeeBps * 100));
  const protocol = (amount * hundredthsBps + 999_999n) / 1_000_000n;
  return { ok: true, maxFee: row.forwardFee + protocol };
}

function withdrawRoute(destination: unknown): CctpRoute | Failure {
  const dest = cctpChainByKey(destination);
  if (!dest || dest.chainId === WITHDRAW_SOURCE.chainId) {
    const keys = withdrawDestinations().destinations.map((d) => d.key);
    return failure("VALIDATION_ERROR", `destination is one of ${keys.join(", ")}.`);
  }
  return { source: WITHDRAW_SOURCE, destination: dest };
}

/** What a withdrawal of `amount` to `destination` costs right now. */
export async function quoteWithdrawal(input: { amount: unknown; destination: unknown }): Promise<WithdrawQuote> {
  const amount = parseUsdcAmount(input.amount);
  if (amount === null) return failure("VALIDATION_ERROR", "amount is a dollar amount above 0 with at most 6 decimals.");
  const route = withdrawRoute(input.destination);
  if ("ok" in route) return route;
  const fee = await forwardMaxFee(cctpDeps(), route, amount, FINALITY_STANDARD);
  if (!fee.ok) return fee;
  if (fee.maxFee >= amount) {
    return failure("AMOUNT_TOO_SMALL", `The network fee is ${amountText(fee.maxFee)}; send more than that.`);
  }
  return {
    ok: true,
    amount: amountText(amount),
    fee: amountText(fee.maxFee),
    receive: amountText(amount - fee.maxFee),
    destination: withdrawDestinations().destinations.find((d) => d.chainId === route.destination.chainId)!,
  };
}

export async function startWithdrawal(em: EntityManager, user: User, input: WithdrawInput): Promise<TransferResult> {
  if (!mayTransact(user)) {
    return failure("INELIGIBLE", "Only adult and guardian accounts can move USDC.");
  }
  const amount = parseUsdcAmount(input.amount);
  if (amount === null) return failure("VALIDATION_ERROR", "amount is a dollar amount above 0 with at most 6 decimals.");
  const route = withdrawRoute(input.destination);
  if ("ok" in route) return route;
  const refused = refuseRoute(route);
  if (refused) return failure("TESTNET_ONLY", refused);

  let recipient: Address | null = null;
  if (input.recipient !== undefined && input.recipient !== null && input.recipient !== "") {
    if (typeof input.recipient !== "string" || !isAddress(input.recipient.trim(), { strict: false })) {
      return failure("VALIDATION_ERROR", "recipient is an EVM address (0x followed by 40 hex characters).");
    }
    recipient = getAddress(input.recipient.trim());
    if (isAddressEqual(recipient, zeroAddress)) return failure("VALIDATION_ERROR", "recipient cannot be the zero address.");
  }

  const wallet = await em.findOne(UserEvmWallet, { user });
  if (!wallet?.address) {
    return failure("WALLET_NOT_READY", "Set up your wallet first (POST /api/web3/wallet).");
  }
  const busy = await em.count(CctpTransfer, { user, state: { $in: ACTIVE } });
  if (busy > 0) return failure("TRANSFER_IN_PROGRESS", "Finish the transfer in progress first.");

  const t = new CctpTransfer();
  t.user = user;
  t.sourceChainId = route.source.chainId;
  t.sourceDomain = route.source.domain;
  t.destinationChainId = route.destination.chainId;
  t.destinationDomain = route.destination.domain;
  t.walletAddress = getAddress(wallet.address);
  t.recipientAddress = recipient && !isAddressEqual(recipient, t.walletAddress as Address) ? recipient : null;
  t.forward = true;
  t.amount = amount.toString();
  t.minFinalityThreshold = FINALITY_STANDARD; // Arc has no fast transfer
  em.persist(t);
  await em.flush();
  return { ok: true, transfer: transferView(t) };
}

/** The CCTP_TESTNETS chains a stored transfer was started with. */
function routeOf(t: CctpTransfer): CctpRoute | null {
  const source = cctpChainById(t.sourceChainId);
  const destination = cctpChainById(t.destinationChainId);
  if (!source || !destination || source.domain !== t.sourceDomain || destination.domain !== t.destinationDomain) {
    return null;
  }
  return { source, destination };
}

// ── reads ──

export async function getTransfer(em: EntityManager, user: User, id: string): Promise<TransferResult> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return failure("TRANSFER_NOT_FOUND", "No such transfer.");
  }
  const t = await em.findOne(CctpTransfer, { id, user });
  return t ? { ok: true, transfer: transferView(t) } : failure("TRANSFER_NOT_FOUND", "No such transfer.");
}

export async function listTransfers(
  em: EntityManager,
  user: User,
  limit = 20,
): Promise<{ ok: true; transfers: TransferView[] }> {
  const rows = await em.find(CctpTransfer, { user }, { orderBy: { createdAt: "DESC" }, limit });
  return { ok: true, transfers: rows.map(transferView) };
}

// ── advance ──

export interface AdvanceOptions {
  /** Open a signing request if the current step needs one. */
  sign?: boolean;
}

export type AdvanceResult =
  | { ok: true; transfer: TransferView; waitingOn: WaitingOn; challenge: ChallengeHandoff | null }
  | Failure;

type Outcome =
  | { kind: "advanced" }
  | { kind: "wait"; on: Exclude<WaitingOn, null>; challenge?: ChallengeHandoff | null }
  | { kind: "error"; code: string; message: string };

const advanced: Outcome = { kind: "advanced" };
const wait = (on: Exclude<WaitingOn, null>, challenge: ChallengeHandoff | null = null): Outcome =>
  ({ kind: "wait", on, challenge });
const error = (code: string, message: string): Outcome => ({ kind: "error", code, message });

interface Ctx {
  em: EntityManager;
  user: User;
  t: CctpTransfer;
  deps: CctpDeps;
  route: CctpRoute;
  sign: boolean;
}

function errorText(err: unknown): string {
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      return (revert.reason ?? revert.data?.errorName ?? revert.shortMessage).slice(0, 300);
    }
    return err.shortMessage.slice(0, 300);
  }
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

function isRevert(err: unknown): boolean {
  return err instanceof BaseError && Boolean(err.walk((e) => e instanceof ContractFunctionRevertedError));
}

/**
 * Where the step's wallet tx stands. A dead tx (superseded, rejected,
 * reverted) is dropped here, so the step may prepare a fresh one.
 */
type TxState = { kind: "none" } | { kind: "pending"; tx: StepTx } | { kind: "confirmed"; tx: StepTx };

function isOutcome(s: TxState | Outcome): s is Outcome {
  return s.kind === "advanced" || s.kind === "wait" || s.kind === "error";
}

async function stepTxState(c: Ctx): Promise<TxState | Outcome> {
  const id = c.t.stepTxId;
  if (!id) return { kind: "none" };
  const r = await c.deps.signer.status(c.em, c.user, id);
  if (!r.ok) {
    if (r.error.code === "TX_NOT_FOUND") {
      c.t.stepTxId = null;
      return { kind: "none" };
    }
    return error(r.error.code, r.error.message);
  }
  switch (r.tx.status) {
    case "awaiting_signature":
    case "submitted":
      return { kind: "pending", tx: r.tx };
    case "confirmed":
      if (!r.tx.txHash) return error("TX_STATE", "Confirmed without a hash.");
      return { kind: "confirmed", tx: r.tx };
    default:
      c.t.stepTxId = null;
      c.t.lastErrorCode = "STEP_TX_" + r.tx.status.toUpperCase();
      c.t.lastError = `The ${c.t.state} transaction was ${r.tx.status}; it will be prepared again.`;
      return { kind: "none" };
  }
}

function waitOnTx(tx: StepTx): Outcome {
  return wait(tx.status === "awaiting_signature" ? "signature" : "confirmation");
}

/**
 * Open a signing request for the user's wallet, if this advance may.
 * `nativeSpend` is what the tx takes from the native balance besides gas:
 * on Arc, USDC is the gas token, so a burn spends the same balance twice.
 */
async function openSigning(
  c: Ctx,
  chain: CctpChain,
  to: Address,
  data: Hex,
  kind: string,
  memo: string,
  nativeSpend = 0n,
): Promise<Outcome> {
  if (!c.sign) return wait("signature");
  const r = await c.deps.signer.prepare(c.em, c.user, { chainId: chain.chainId, to, data, kind, memo });
  if (!r.ok) return error(r.error.code, r.error.message);
  c.t.stepTxId = r.tx.id;
  const shortfall = r.gas ? BigInt(r.gas.requiredWei) + nativeSpend - BigInt(r.gas.balanceWei) : 0n;
  if (shortfall > 0n) {
    c.t.lastErrorCode = "INSUFFICIENT_GAS";
    c.t.lastError = `The wallet needs ${shortfall} more wei of native balance on chain ${chain.chainId} to send this`
      + (nativeSpend > 0n ? " (on Arc the burn and its gas both come out of USDC)." : ".");
  } else {
    c.t.lastErrorCode = null;
    c.t.lastError = null;
  }
  return wait("signature", r.challenge);
}

async function simulate(
  client: PublicClient,
  from: Address,
  to: Address,
  data: Hex,
): Promise<{ ok: true } | { ok: false; revert: boolean; reason: string }> {
  try {
    await client.call({ account: from, to, data });
    return { ok: true };
  } catch (err) {
    return { ok: false, revert: isRevert(err) || /revert/i.test(errorText(err)), reason: errorText(err) };
  }
}

function amountText(units: bigint): string {
  return formatUnits(units, USDC_DECIMALS);
}

function burnExpectation(c: Ctx): BurnExpectation {
  const { route } = c;
  const wallet = getAddress(c.t.walletAddress);
  return {
    sourceDomain: route.source.domain,
    destinationDomain: route.destination.domain,
    tokenMessenger: route.source.tokenMessenger,
    burnToken: route.source.usdc,
    mintRecipient: recipientOf(c.t),
    messageSender: wallet,
    amount: BigInt(c.t.amount),
    maxFee: BigInt(c.t.maxFee ?? "0"),
    minFinalityThreshold: c.t.minFinalityThreshold,
    hookData: FORWARD_HOOK_DATA,
  };
}

function recipientOf(t: CctpTransfer): Address {
  return getAddress(t.recipientAddress ?? t.walletAddress);
}

/** Shared by both approvals: allowance first, then the tx if still short. */
async function approvalStep(
  c: Ctx,
  chain: CctpChain,
  spender: Address,
  amount: bigint,
  onDone: (hash: Hex | null) => void,
  kind: string,
  memo: string,
): Promise<Outcome> {
  const s = await stepTxState(c);
  if (isOutcome(s)) return s;
  const wallet = getAddress(c.t.walletAddress);
  const allowance = await c.deps.client(chain).readContract({
    address: chain.usdc, abi: usdcAbi, functionName: "allowance", args: [wallet, spender],
  });
  if (allowance >= amount) {
    onDone(s.kind === "confirmed" ? (s.tx.txHash as Hex) : null);
    c.t.stepTxId = null;
    return advanced;
  }
  if (s.kind === "pending") return waitOnTx(s.tx);
  const data = encodeFunctionData({ abi: usdcAbi, functionName: "approve", args: [spender, amount] });
  return openSigning(c, chain, chain.usdc, data, kind, memo);
}

async function stepBurnApproval(c: Ctx): Promise<Outcome> {
  const { source } = c.route;
  const amount = BigInt(c.t.amount);
  return approvalStep(c, source, source.tokenMessenger, amount, (hash) => {
    c.t.burnApprovalTxHash = hash ?? c.t.burnApprovalTxHash ?? null;
    c.t.state = "burn";
  }, "cctp_burn_approval", `Allow Circle CCTP to burn ${amountText(amount)} USDC on Arc`);
}

async function stepBurn(c: Ctx): Promise<Outcome> {
  const { source } = c.route;
  const client = c.deps.client(source);
  const wallet = getAddress(c.t.walletAddress);
  const amount = BigInt(c.t.amount);

  const s = await stepTxState(c);
  if (isOutcome(s)) return s;
  if (s.kind === "pending") return waitOnTx(s.tx);
  if (s.kind === "confirmed") {
    const hash = s.tx.txHash as Hex;
    const receipt = await client.getTransactionReceipt({ hash });
    const want = burnExpectation(c);
    const message = messagesSent(receipt.logs, source.messageTransmitter).find((m) => {
      const decoded = decodeBurnMessage(m);
      return decoded !== null && burnMismatch(decoded, want) === null;
    });
    if (!message) {
      c.t.state = "failed";
      return error("BURN_MESSAGE_MISSING", `Burn ${hash} emitted no matching CCTP message.`);
    }
    c.t.burnTxHash = hash;
    c.t.sourceMessage = message;
    c.t.stepTxId = null;
    c.t.state = "attestation";
    c.t.nextCheckAt = null;
    c.t.lastErrorCode = null;
    c.t.lastError = null;
    return advanced;
  }

  // Nothing in flight: preflight, then prepare the one burn.
  const [balance, allowance] = await Promise.all([
    client.readContract({ address: source.usdc, abi: usdcAbi, functionName: "balanceOf", args: [wallet] }),
    client.readContract({ address: source.usdc, abi: usdcAbi, functionName: "allowance", args: [wallet, source.tokenMessenger] }),
  ]);
  if (allowance < amount) {
    c.t.state = "burn_approval";
    return advanced;
  }
  if (balance < amount) {
    return error("INSUFFICIENT_USDC", `The wallet holds ${amountText(balance)} USDC on Arc; the transfer needs ${amountText(amount)}.`);
  }
  if (!c.sign) return wait("signature");

  const quoted = await forwardMaxFee(c.deps, c.route, amount, c.t.minFinalityThreshold);
  if (!quoted.ok) return error(quoted.error.code, quoted.error.message);
  const maxFee = quoted.maxFee;
  if (maxFee >= amount) return error("AMOUNT_TOO_SMALL", `The CCTP fee (${amountText(maxFee)} USDC) is not below the amount.`);
  c.t.maxFee = maxFee.toString();
  const data = encodeFunctionData({
    abi: tokenMessengerV2Abi,
    functionName: "depositForBurnWithHook",
    args: [
      amount,
      c.route.destination.domain,
      addressToBytes32(recipientOf(c.t)),
      source.usdc,
      zeroHash, // Circle's forwarder submits the mint
      maxFee,
      c.t.minFinalityThreshold,
      FORWARD_HOOK_DATA,
    ],
  });
  const sim = await simulate(client, wallet, source.tokenMessenger, data);
  if (!sim.ok) return error(sim.revert ? "SIMULATION_REVERTED" : "CHAIN_UNAVAILABLE", `depositForBurnWithHook: ${sim.reason}`);
  // Arc's USDC is its native gas token: 6 dp as ERC-20, 18 dp natively.
  const nativeSpend = source.key === "arcTestnet" ? amount * 10n ** 12n : 0n;
  return openSigning(c, source, source.tokenMessenger, data, "cctp_burn",
    `Send ${amountText(amount)} USDC from ${source.name} to ${c.route.destination.name} (Circle CCTP)`, nativeSpend);
}

async function stepAttestation(c: Ctx): Promise<Outcome> {
  const now = c.deps.now();
  if (c.t.nextCheckAt && c.t.nextCheckAt > now) return wait("attestation");
  const later = (rateLimited = false) => {
    c.t.irisPolls += 1;
    c.t.nextCheckAt = new Date(now.getTime() + irisDelayMs(c.t.irisPolls, rateLimited));
  };

  const r = await c.deps.iris.messagesForTx(c.t.sourceDomain, c.t.burnTxHash as Hex);
  if (!r.ok) {
    later(r.error.code === "IRIS_RATE_LIMITED");
    return error(r.error.code, r.error.message);
  }
  const source = c.t.sourceMessage as Hex;
  const ours = r.found ? r.messages.filter((m) => m.message === null || sameBurn(source, m.message)) : [];
  const done = ours.find((m) => m.complete);
  if (!done) {
    later();
    // Only ever submit our own message; anything else is reported and polled again.
    if (r.found && ours.length === 0) {
      return error("ATTESTATION_MISMATCH", "Iris lists messages for this tx, none of them the burn's.");
    }
    c.t.lastErrorCode = null;
    c.t.lastError = null;
    return wait("attestation");
  }

  const message = done.message as Hex;
  const attestation = done.attestation as Hex;
  const decoded = decodeBurnMessage(message);
  const want = burnExpectation(c);
  const mismatch = decoded ? burnMismatch(decoded, want) : "undecodable";
  const invalid = !decoded || mismatch ? `differs from the burn: ${mismatch}`
    : decoded.nonce === zeroHash ? "has no nonce"
    : decoded.body.feeExecuted > want.maxFee ? "executes a fee above the max fee"
    : !(await attestationSigners(message, attestation)) ? "has a malformed attestation"
    : null;
  if (invalid || !decoded) {
    later();
    return error("ATTESTATION_INVALID", `The attested message ${invalid}.`);
  }
  c.t.attestedMessage = message;
  c.t.attestation = attestation;
  c.t.nonce = decoded.nonce;
  c.t.nextCheckAt = null;
  c.t.irisPolls = 0;
  c.t.state = "receive";
  c.t.lastErrorCode = null;
  c.t.lastError = null;
  return advanced;
}

/** After the mint, whoever submitted it. */
async function received(c: Ctx, hash: Hex | null): Promise<Outcome> {
  const { destination } = c.route;
  const decoded = decodeBurnMessage(c.t.attestedMessage as Hex);
  let minted = decoded ? mintedAmount(decoded) : BigInt(c.t.amount);
  if (hash) {
    try {
      const receipt = await c.deps.client(destination).getTransactionReceipt({ hash });
      const recipient = recipientOf(c.t);
      const mint = parseEventLogs({ abi: usdcAbi, eventName: "Transfer", logs: receipt.logs }).find((l) =>
        isAddressEqual(l.address, destination.usdc) && isAddressEqual(l.args.from, zeroAddress)
        && isAddressEqual(l.args.to, recipient));
      if (mint) minted = mint.args.value;
    } catch {
      // The mint is on a chain whose RPC may be down; the attested amount stands.
    }
  }
  c.t.receiveTxHash = hash;
  c.t.mintedAmount = minted.toString();
  c.t.stepTxId = null;
  c.t.state = "completed";
  c.t.completedAt = c.deps.now();
  c.t.lastErrorCode = null;
  c.t.lastError = null;
  return advanced;
}

/**
 * A withdrawal's receive: Circle's forwarder submits the mint. Done when
 * Iris reports the forwarded mint, or the destination shows the nonce used
 * (whoever submitted it). Polled on the Iris backoff; never signs.
 */
async function stepForwardedReceive(c: Ctx): Promise<Outcome> {
  const { destination } = c.route;
  const now = c.deps.now();
  if (c.t.nextCheckAt && c.t.nextCheckAt > now) return wait("relay");
  const later = (rateLimited = false) => {
    c.t.irisPolls += 1;
    c.t.nextCheckAt = new Date(now.getTime() + irisDelayMs(c.t.irisPolls, rateLimited));
  };

  let used = false;
  try {
    used = (await c.deps.client(destination).readContract({
      address: destination.messageTransmitter, abi: messageTransmitterV2Abi, functionName: "usedNonces", args: [c.t.nonce as Hex],
    })) !== 0n;
  } catch {
    // Destination RPC unreachable: Iris alone decides this pass.
  }

  const r = await c.deps.iris.messagesForTx(c.t.sourceDomain, c.t.burnTxHash as Hex);
  if (!r.ok && !used) {
    later(r.error.code === "IRIS_RATE_LIMITED");
    return error(r.error.code, r.error.message);
  }
  const ours = r.ok && r.found
    ? r.messages.find((m) => m.message !== null && sameBurn(c.t.sourceMessage as Hex, m.message))
    : undefined;
  const hash = ours?.forwardTxHash ?? null;
  const forwarded = hash !== null && /complete/i.test(ours?.forwardState ?? "");
  if (used || forwarded) return received(c, hash);
  later();
  if (ours?.forwardState && /fail/i.test(ours.forwardState)) {
    return error("FORWARD_FAILED", `Circle's forwarder reports ${ours.forwardState}; anyone may still submit the mint.`);
  }
  c.t.lastErrorCode = null;
  c.t.lastError = null;
  return wait("relay");
}

const STEPS: Record<CctpState, ((c: Ctx) => Promise<Outcome>) | null> = {
  burn_approval: stepBurnApproval,
  burn: stepBurn,
  attestation: stepAttestation,
  receive: stepForwardedReceive,
  completed: null,
  failed: null,
};

/** Run one transfer as far as it can go now; see the file header. */
export async function advanceTransfer(
  em: EntityManager,
  id: string,
  opts: AdvanceOptions = {},
): Promise<AdvanceResult> {
  const deps = cctpDeps();

  return em.transactional(async (tx) => {
    const t = await tx.findOne(CctpTransfer, { id }, { lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE });
    if (!t) {
      const exists = await tx.count(CctpTransfer, { id });
      return exists ? failure("TRANSFER_BUSY", "Another worker is advancing this transfer.")
        : failure("TRANSFER_NOT_FOUND", "No such transfer.");
    }
    const user = await tx.findOneOrFail(User, { id: t.user.id });
    if (!mayTransact(user)) {
      // Audience changed since the start: stop before any further step.
      return failure("INELIGIBLE", "Only adult and guardian accounts can move USDC.");
    }
    if (!t.forward) {
      t.state = "failed";
      t.lastErrorCode = "ROUTE_RETIRED";
      t.lastError = "This transfer used a path that is no longer served.";
      t.updatedAt = new Date();
      await tx.flush();
      return { ok: true as const, transfer: transferView(t), waitingOn: null, challenge: null };
    }
    const route = routeOf(t);
    if (!route) return failure("CHAIN_MISMATCH", "This transfer was started on a route this server no longer serves.");
    const routeRefused = refuseRoute(route);
    if (routeRefused) return failure("TESTNET_ONLY", routeRefused);

    const c: Ctx = { em: tx, user, t, deps, route, sign: Boolean(opts.sign) };
    let waitingOn: WaitingOn = null;
    let challenge: ChallengeHandoff | null = null;
    for (let i = 0; i < MAX_STEPS_PER_ADVANCE; i++) {
      const step = STEPS[t.state];
      if (!step) break;
      let out: Outcome;
      try {
        out = await step(c);
      } catch (err) {
        out = error("CHAIN_UNAVAILABLE", errorText(err));
      }
      if (out.kind === "advanced") continue;
      if (out.kind === "error") {
        t.lastErrorCode = out.code;
        t.lastError = out.message;
        waitingOn = t.state === "failed" ? null : "retry";
        break;
      }
      waitingOn = out.on;
      challenge = out.challenge ?? null;
      break;
    }
    // updatedAt is "last advanced": the sweep takes the stalest first, so a
    // transfer stuck on a signature never starves the others.
    t.updatedAt = new Date();
    await tx.flush();
    return { ok: true as const, transfer: transferView(t), waitingOn, challenge };
  });
}

/** Advance every transfer still in flight, oldest first. Never signs. */
export async function advanceActive(
  em: EntityManager,
  limit = 50,
): Promise<{ id: string; result: AdvanceResult }[]> {
  const rows = await em.fork().find(
    CctpTransfer,
    { state: { $in: ACTIVE } },
    { orderBy: { updatedAt: "ASC" }, limit, fields: ["id"] },
  );
  const out: { id: string; result: AdvanceResult }[] = [];
  for (const row of rows) {
    out.push({ id: row.id, result: await advanceTransfer(em.fork(), row.id, { sign: false }) });
  }
  return out;
}
