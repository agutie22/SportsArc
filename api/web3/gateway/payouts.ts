/**
 * Paying a player on the chain they chose, from the payout wallet's Circle
 * Gateway balance. States are in GatewayPayout.ts; this is the machine.
 *
 * The payout wallet is its own server key (chains.ts payoutWallet(),
 * PAYOUT_PRIVATE_KEY), not the relayer's. Money reaches
 * it only as a routed event payment (inbox.ts), already owed to one player;
 * this module forwards exactly that amount, less Circle's fee, to the chain
 * and address that player chose when they entered. It holds the money for the
 * seconds that takes.
 *
 *   queued   quote the fee, then deposit `amount` into Gateway
 *   funded   once Gateway shows the balance, sign a burn intent for
 *            amount - fee and hand it to Circle's forwarder
 *   sending  poll until the mint is confirmed on the destination
 *
 * Never stuck: a payout that cannot go out (smaller than the fee, over a
 * cap, Gateway refusing or down for too long, the transfer failed or
 * expired) is paid to the player's SportsArc wallet on the home chain
 * instead, and they are told.
 *
 * Paying once. Only the payout job calls advancePayout, one instance per
 * tick (ops/jobs.ts), and every step is saved before the next begins. Each
 * attempt's burn intent has a salt derived from the payout and attempt
 * number, the state is saved as `sending` before Circle is asked, and the
 * attempt number moves only when Circle refused the request (4xx: nothing
 * moved). A request whose answer was lost is asked again with the same salt.
 *
 * Nothing here is reachable from a route: no request can start or steer a
 * payout. Caps (config.ts payoutCaps) bound a single payout and a day's total.
 */

import type { EntityManager } from "@mikro-orm/postgresql";
import { erc20Abi, formatUnits, getAddress, isAddress, maxUint256, parseAbi, type Address, type Hex } from "viem";
import { User } from "../../entities/User.js";
import { log } from "../../ops/log.js";
import { notify } from "../../social/notifications.js";
import { payoutWallet, publicClient } from "../chains.js";
import { explorerFor } from "../cctp/config.js";
import { usd } from "../usd.js";
import { gatewayApi, type GatewayApi } from "./api.js";
import { GATEWAY_TESTNET, payoutCaps, payoutChainByKey, payoutSource, type GatewayChain } from "./config.js";
import { GatewayPayout, type PayoutState } from "./GatewayPayout.js";
import { payoutSalt, signBurnIntent, transferSpec, type BurnIntent } from "./intent.js";

export const gatewayWalletAbi = parseAbi([
  "function deposit(address token, uint256 value)",
  "function availableBalance(address token, address depositor) view returns (uint256)",
]);

const RECEIPT_TIMEOUT_MS = 60_000;
/** Failed passes before a payout that has not been sent goes to the wallet. */
const MAX_ERRORS = 6;
/** A payout not sent within this long goes to the wallet. */
const GIVE_UP_MS = 15 * 60_000;
const ACTIVE: PayoutState[] = ["queued", "funded", "sending", "fallback_pending"];

// ── dependencies (swappable for checks) ──

type Wallet = NonNullable<ReturnType<typeof payoutWallet>>;
type Client = ReturnType<typeof publicClient>;

export interface PayoutDeps {
  api: GatewayApi;
  wallet(): Pick<Wallet, "account" | "writeContract"> | null;
  client(): Pick<Client, "readContract" | "waitForTransactionReceipt" | "getTransactionReceipt">;
  now(): Date;
}

let overrides: Partial<PayoutDeps> | undefined;

/** Checks only: replace some dependencies; undefined restores the defaults. */
export function setPayoutDeps(deps: Partial<PayoutDeps> | undefined): void {
  overrides = deps;
}

function payoutDeps(): PayoutDeps {
  return {
    api: overrides?.api ?? gatewayApi(),
    wallet: overrides?.wallet ?? payoutWallet,
    client: overrides?.client ?? publicClient,
    now: overrides?.now ?? (() => new Date()),
  };
}

/** Whether this server can pay out on other chains at all. */
export function payoutsConfigured(): boolean {
  return payoutSource() !== null && payoutDeps().wallet() !== null;
}

/** The address routed event payments must arrive at. */
export function payoutWalletAddress(): Address | null {
  return payoutDeps().wallet()?.account.address ?? null;
}

// ── views ──

export function payoutView(p: GatewayPayout) {
  const chain = payoutChainByKey(p.destChainKey);
  const source = payoutSource();
  const done = p.state === "completed" || p.state === "fallback";
  return {
    id: p.id,
    state: p.state,
    amountUsdc: formatUnits(BigInt(p.amount), 6),
    sentUsdc: p.sentAmount ? formatUnits(BigInt(p.sentAmount), 6) : null,
    feeUsdc: p.fee ? formatUnits(BigInt(p.fee), 6) : null,
    chain: p.destChainKey,
    chainName: chain?.name ?? p.destChainKey,
    address: p.destAddress,
    /** A link to the payment where it landed. */
    receipt: p.state === "completed" && p.destTxHash && chain && explorerFor(chain)
      ? `${explorerFor(chain)!.replace(/\/+$/, "")}/tx/${p.destTxHash}`
      : p.state === "fallback" && p.fallbackTxHash && source && explorerFor(source)
        ? `${explorerFor(source)!.replace(/\/+$/, "")}/tx/${p.fallbackTxHash}`
        : null,
    toWallet: p.state === "fallback" || p.state === "fallback_pending",
    reason: p.fallbackReason ?? null,
    gameId: p.game?.id ?? null,
    createdAt: p.createdAt,
    completedAt: done ? p.completedAt ?? null : null,
  };
}

export async function listPayouts(em: EntityManager, user: User, limit = 20) {
  const rows = await em.find(GatewayPayout, { user }, { orderBy: { createdAt: "DESC" }, limit });
  return { ok: true as const, payouts: rows.map(payoutView) };
}

// ── the machine ──

interface Ctx {
  em: EntityManager;
  p: GatewayPayout;
  deps: PayoutDeps;
  source: GatewayChain;
  wallet: Pick<Wallet, "account" | "writeContract">;
}

function later(c: Ctx, code: string, message: string): void {
  c.p.errors += 1;
  c.p.lastErrorCode = code;
  c.p.lastError = message.slice(0, 500);
  const delay = Math.min(10_000 * 2 ** Math.min(c.p.errors - 1, 5), 5 * 60_000);
  c.p.nextAttemptAt = new Date(c.deps.now().getTime() + delay);
}

function progressed(c: Ctx, state: PayoutState): void {
  c.p.state = state;
  c.p.errors = 0;
  c.p.lastErrorCode = null;
  c.p.lastError = null;
  c.p.nextAttemptAt = null;
}

function toWallet(c: Ctx, reason: string): void {
  progressed(c, "fallback_pending");
  c.p.fallbackReason = reason.slice(0, 200);
  log.warn("payout falls back to the SportsArc wallet", { payoutId: c.p.id, userId: c.p.user.id, reason });
}

/** Give up on the other chain once a payout has failed or waited too long. */
function exhausted(c: Ctx): boolean {
  return c.p.errors >= MAX_ERRORS || c.deps.now().getTime() - c.p.createdAt.getTime() > GIVE_UP_MS;
}

function specFor(c: Ctx, destination: GatewayChain, value: bigint) {
  return transferSpec({
    source: c.source,
    destination,
    depositor: c.wallet.account.address,
    recipient: getAddress(c.p.destAddress),
    value,
    salt: payoutSalt(c.p.id, c.p.attempt),
  });
}

async function sentSince(em: EntityManager, since: Date): Promise<bigint> {
  const rows = await em.find(
    GatewayPayout,
    { state: { $in: ["funded", "sending", "completed"] }, updatedAt: { $gte: since } },
    { fields: ["amount"] },
  );
  return rows.reduce((sum, r) => sum + BigInt(r.amount), 0n);
}

async function stepQueued(c: Ctx): Promise<void> {
  const amount = BigInt(c.p.amount);
  const destination = payoutChainByKey(c.p.destChainKey);
  if (!destination || !isAddress(c.p.destAddress)) return toWallet(c, "That network is no longer available.");
  const caps = payoutCaps();
  if (amount > caps.perPayout) return toWallet(c, "The amount is over the limit for a single payout.");
  const dayAgo = new Date(c.deps.now().getTime() - 24 * 3_600_000);
  if ((await sentSince(c.em, dayAgo)) + amount > caps.daily) return toWallet(c, "Today's payout limit was reached.");

  const quote = await c.deps.api.estimate(specFor(c, destination, amount));
  if (!quote.ok) {
    if (quote.rejected || exhausted(c)) return toWallet(c, "The payout network refused the transfer.");
    return later(c, quote.error.code, quote.error.message);
  }
  if (quote.maxFee >= amount) return toWallet(c, `The amount is smaller than the ${usd(quote.maxFee)} network fee.`);

  const client = c.deps.client();
  const me = c.wallet.account.address;
  const held = await client.readContract({ address: c.source.usdc, abi: erc20Abi, functionName: "balanceOf", args: [me] });
  if (held < amount) return later(c, "PAYOUT_WALLET_SHORT", `The payout wallet holds ${formatUnits(held, 6)} USDC; this payout needs ${formatUnits(amount, 6)}.`);

  const allowance = await client.readContract({
    address: c.source.usdc, abi: erc20Abi, functionName: "allowance", args: [me, GATEWAY_TESTNET.wallet],
  });
  if (allowance < amount) {
    const approve = await c.wallet.writeContract({
      address: c.source.usdc, abi: erc20Abi, functionName: "approve", args: [GATEWAY_TESTNET.wallet, maxUint256],
    } as never);
    const r = await client.waitForTransactionReceipt({ hash: approve, timeout: RECEIPT_TIMEOUT_MS });
    if (r.status !== "success") return later(c, "APPROVE_REVERTED", `Gateway approval reverted: ${approve}`);
  }
  // deposit(), never a plain transfer: USDC sent straight to the contract is lost.
  const hash = await c.wallet.writeContract({
    address: GATEWAY_TESTNET.wallet, abi: gatewayWalletAbi, functionName: "deposit", args: [c.source.usdc, amount],
  } as never);
  c.p.depositTxHash = hash;
  await c.em.flush();
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
  if (receipt.status !== "success") {
    c.p.depositTxHash = null;
    return later(c, "DEPOSIT_REVERTED", `Gateway deposit reverted: ${hash}`);
  }
  progressed(c, "funded");
}

async function stepFunded(c: Ctx): Promise<void> {
  const amount = BigInt(c.p.amount);
  const destination = payoutChainByKey(c.p.destChainKey);
  if (!destination) return toWallet(c, "That network is no longer available.");

  const balance = await c.deps.api.balance(c.source.domain, c.wallet.account.address);
  if (!balance.ok) return exhausted(c) ? toWallet(c, "The payout network is not answering.") : later(c, balance.error.code, balance.error.message);
  if (balance.balance < amount) {
    // The deposit is confirmed but not credited yet (about a block on Arc).
    c.p.nextAttemptAt = new Date(c.deps.now().getTime() + 2_000);
    return;
  }
  const quote = await c.deps.api.estimate(specFor(c, destination, amount));
  if (!quote.ok) {
    if (quote.rejected || exhausted(c)) return toWallet(c, "The payout network refused the transfer.");
    return later(c, quote.error.code, quote.error.message);
  }
  if (quote.maxFee >= amount) return toWallet(c, `The amount is smaller than the ${usd(quote.maxFee)} network fee.`);

  // Saved as sending before Circle is asked: see "Paying once" above.
  c.p.fee = quote.maxFee.toString();
  c.p.sentAmount = (amount - quote.maxFee).toString();
  c.p.transferId = null;
  progressed(c, "sending");
  await c.em.flush();
  await submit(c, destination, quote.maxBlockHeight);
}

/** Ask Circle to run this attempt's burn intent. Same attempt, same salt. */
async function submit(c: Ctx, destination: GatewayChain, maxBlockHeight: bigint): Promise<void> {
  const intent: BurnIntent = {
    maxBlockHeight,
    maxFee: BigInt(c.p.fee as string),
    spec: specFor(c, destination, BigInt(c.p.sentAmount as string)),
  };
  let signature: Hex;
  try {
    signature = await signBurnIntent(c.wallet.account as never, intent);
  } catch (err) {
    return later(c, "SIGNING_FAILED", err instanceof Error ? err.message : String(err));
  }
  const sent = await c.deps.api.transfer(intent, signature);
  if (sent.ok) {
    c.p.transferId = sent.transferId;
    c.p.errors = 0;
    c.p.lastErrorCode = null;
    c.p.lastError = null;
    c.p.nextAttemptAt = new Date(c.deps.now().getTime() + 2_000);
    return;
  }
  if (sent.rejected) {
    // Refused: nothing moved. A new attempt gets a new salt.
    c.p.attempt += 1;
    c.p.state = "funded";
    later(c, sent.error.code, sent.error.message);
    if (exhausted(c)) toWallet(c, "The payout network refused the transfer.");
    return;
  }
  // Unknown: it may have been accepted. Ask again, same salt.
  later(c, sent.error.code, sent.error.message);
}

async function stepSending(c: Ctx): Promise<void> {
  const destination = payoutChainByKey(c.p.destChainKey);
  if (!c.p.transferId) {
    if (!destination) return later(c, "DESTINATION_GONE", "The destination chain is no longer configured.");
    const quote = await c.deps.api.estimate(specFor(c, destination, BigInt(c.p.sentAmount as string)));
    if (!quote.ok) return later(c, quote.error.code, quote.error.message);
    return submit(c, destination, quote.maxBlockHeight);
  }
  const st = await c.deps.api.status(c.p.transferId);
  if (!st.ok) return later(c, st.error.code, st.error.message);
  if (st.status === "confirmed" || st.status === "finalized") {
    c.p.destTxHash = st.txHash;
    progressed(c, "completed");
    c.p.completedAt = c.deps.now();
    await notify(c.em, {
      recipient: c.p.user, kind: "payout_sent", game: c.p.game ?? null,
      detail: `${usd(BigInt(c.p.sentAmount as string))} sent to ${destination?.name ?? c.p.destChainKey}`,
    });
    log.info("payout completed", { payoutId: c.p.id, userId: c.p.user.id, chain: c.p.destChainKey });
    return;
  }
  if (st.status === "failed" || st.status === "expired") {
    return toWallet(c, st.status === "expired" ? "The transfer expired before it was delivered." : "The transfer failed on the other network.");
  }
  c.p.nextAttemptAt = new Date(c.deps.now().getTime() + 3_000);
}

async function stepFallback(c: Ctx): Promise<void> {
  const client = c.deps.client();
  const amount = BigInt(c.p.amount);
  if (c.p.fallbackTxHash) {
    const receipt = await client.getTransactionReceipt({ hash: c.p.fallbackTxHash as Hex }).catch(() => null);
    if (!receipt) {
      c.p.nextAttemptAt = new Date(c.deps.now().getTime() + 5_000);
      return;
    }
    if (receipt.status !== "success") {
      c.p.fallbackTxHash = null;
      return later(c, "FALLBACK_REVERTED", "The transfer to the SportsArc wallet reverted; it will be sent again.");
    }
    progressed(c, "fallback");
    c.p.completedAt = c.deps.now();
    await notify(c.em, {
      recipient: c.p.user, kind: "payout_wallet", game: c.p.game ?? null,
      detail: `${usd(amount)} is in your SportsArc wallet instead`,
    });
    return;
  }
  const user = await c.em.findOneOrFail(User, { id: c.p.user.id });
  const to = user.walletAddress?.trim() ?? "";
  if (!isAddress(to)) return later(c, "NO_WALLET", "The player has no SportsArc wallet to pay.");
  const me = c.wallet.account.address;
  const held = await client.readContract({ address: c.source.usdc, abi: erc20Abi, functionName: "balanceOf", args: [me] });
  if (held < amount) {
    log.error("payout wallet cannot cover a fallback", { payoutId: c.p.id, userId: user.id });
    return later(c, "PAYOUT_WALLET_SHORT", `The payout wallet holds ${formatUnits(held, 6)} USDC; this fallback needs ${formatUnits(amount, 6)}.`);
  }
  c.p.fallbackTxHash = await c.wallet.writeContract({
    address: c.source.usdc, abi: erc20Abi, functionName: "transfer", args: [getAddress(to), amount],
  } as never);
  c.p.nextAttemptAt = new Date(c.deps.now().getTime() + 2_000);
}

const STEPS: Record<PayoutState, ((c: Ctx) => Promise<void>) | null> = {
  queued: stepQueued,
  funded: stepFunded,
  sending: stepSending,
  fallback_pending: stepFallback,
  completed: null,
  fallback: null,
};

/** Run one payout as far as it goes now. Called by the payout job only. */
export async function advancePayout(em: EntityManager, id: string): Promise<GatewayPayout | null> {
  const p = await em.findOne(GatewayPayout, { id }, { populate: ["user", "game"] });
  if (!p) return null;
  const deps = payoutDeps();
  const source = payoutSource();
  const wallet = deps.wallet();
  if (!source || !wallet) return p;
  const c: Ctx = { em, p, deps, source, wallet };
  for (let i = 0; i < 6; i++) {
    const step = STEPS[p.state];
    if (!step) break;
    if (p.nextAttemptAt && p.nextAttemptAt > deps.now()) break;
    const before = p.state;
    try {
      await step(c);
    } catch (err) {
      later(c, "CHAIN_UNAVAILABLE", err instanceof Error ? err.message : String(err));
      if ((p.state === "queued" || p.state === "funded") && exhausted(c)) toWallet(c, "The payout could not be sent.");
    }
    await em.flush();
    if (p.state === before) break;
  }
  return p;
}

/** Advance every payout in flight, stalest first. */
export async function advancePayouts(fork: () => EntityManager, limit = 25): Promise<number> {
  const rows = await fork().find(
    GatewayPayout,
    { state: { $in: ACTIVE } },
    { orderBy: { updatedAt: "ASC" }, limit, fields: ["id"] },
  );
  for (const row of rows) await advancePayout(fork(), row.id);
  return rows.length;
}
