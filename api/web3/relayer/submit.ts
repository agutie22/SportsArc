/**
 * The one path for a contract call the platform sends, and pays gas for, on
 * a player's behalf: paying someone, entering an event, claiming a payout.
 * The player signed typed data with their PIN (wallet/signature.ts); the
 * relayer key submits the call that carries it, through relayer() and its
 * nonce queue (nonce.ts).
 *
 *   relay()         simulate, then send. A call that would revert is refused
 *                   before it costs anything.
 *   relayOutcome()  the receipt, and one log line with the gas it spent.
 *   relayerStatus() the relayer's balance for the health check, with a
 *                   warning in the logs when it runs low: an empty relayer
 *                   stops every payment.
 *
 * Calls made for a signed-in user are limited per user (rate_limit_hits,
 * bucket "relay"), since each one spends the platform's money.
 */

import type { EntityManager } from "@mikro-orm/postgresql";
import {
  BaseError,
  ContractFunctionRevertedError,
  TransactionReceiptNotFoundError,
  WaitForTransactionReceiptTimeoutError,
  formatUnits,
  parseUnits,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { RateLimitHit } from "../../entities/RateLimitHit.js";
import type { User } from "../../entities/User.js";
import { fail, type Failure } from "../../failure.js";
import { advisoryKey } from "../../ops/jobs.js";
import { log } from "../../ops/log.js";
import { publicClient, relayer } from "../chains.js";

export const RELAY_STATUS: Record<string, number> = {
  NOT_CONFIGURED: 503,
  RATE_LIMITED: 429,
  RELAY_REVERTED: 422,
  CHAIN_UNAVAILABLE: 502,
};

const WINDOW_MS = 60 * 60 * 1000;

function maxPerHour(): number {
  const n = Number(process.env.RELAY_MAX_PER_HOUR);
  return Number.isInteger(n) && n > 0 ? n : 60;
}

/** True when `userId` is over the limit; otherwise records the call. */
async function rateLimited(em: EntityManager, userId: string): Promise<boolean> {
  const bucket = "relay";
  return em.transactional(async (tx) => {
    await tx.execute("select pg_advisory_xact_lock(cast(? as bigint))", [advisoryKey(`ratelimit:${bucket}:${userId}`)]);
    const now = new Date();
    const since = new Date(now.getTime() - WINDOW_MS);
    await tx.nativeDelete(RateLimitHit, { bucket, hitAt: { $lte: since } });
    const hits = await tx.count(RateLimitHit, { bucket, key: userId, hitAt: { $gt: since } });
    if (hits >= maxPerHour()) return true;
    const hit = new RateLimitHit();
    hit.bucket = bucket;
    hit.key = userId;
    hit.hitAt = now;
    await tx.insert(RateLimitHit, hit);
    return false;
  });
}

export interface RelayCall {
  /** What the call is for, in logs: "payment", "event_entry", ... */
  kind: string;
  address: Address;
  abi: Abi | readonly unknown[];
  functionName: string;
  args: readonly unknown[];
}

export type RelayResult = { ok: true; hash: Hex } | Failure;

function revertReason(err: unknown): string | null {
  if (!(err instanceof BaseError)) return null;
  const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
  if (!(revert instanceof ContractFunctionRevertedError)) return null;
  return revert.data?.errorName ?? revert.reason ?? revert.shortMessage;
}

const short = (err: unknown) => (err instanceof BaseError ? err.shortMessage : err instanceof Error ? err.message : String(err)).slice(0, 200);

/**
 * Send `call` from the relayer. `user` is who it is for (null for the
 * server's own jobs, which are not limited). Returns once the node has
 * accepted the transaction; relayOutcome() says how it ended.
 */
export async function relay(em: EntityManager, user: User | null, call: RelayCall): Promise<RelayResult> {
  const sender = relayer();
  if (!sender) return fail("NOT_CONFIGURED", "Payments are not configured on this server.");
  if (user && (await rateLimited(em, user.id))) {
    return fail("RATE_LIMITED", "Too many payments in the last hour. Try again later.");
  }
  const request = {
    address: call.address,
    abi: call.abi as Abi,
    functionName: call.functionName,
    args: call.args,
    account: sender.account,
  };
  try {
    await publicClient().simulateContract(request);
  } catch (err) {
    const reason = revertReason(err);
    if (reason) {
      log.warn("relayed call would revert; not sent", { kind: call.kind, userId: user?.id, reason });
      return fail("RELAY_REVERTED", `The network refused it: ${reason}`);
    }
    return fail("CHAIN_UNAVAILABLE", `The network did not answer: ${short(err)}`);
  }
  let hash: Hex;
  try {
    hash = await sender.writeContract({ ...request, chain: sender.chain });
  } catch (err) {
    log.error("relayed call was not accepted", { kind: call.kind, userId: user?.id, err });
    return fail("CHAIN_UNAVAILABLE", `The network did not accept it: ${short(err)}`);
  }
  log.info("relayed call sent", { kind: call.kind, userId: user?.id, txHash: hash });
  void refreshStatus();
  return { ok: true, hash };
}

export type RelayOutcome =
  | { state: "pending" }
  | { state: "confirmed" | "reverted"; gasUsed: bigint; gasCost: bigint; blockNumber: bigint };

/** Hashes whose gas line is already in the log (a receipt is read more than once). */
const logged = new Set<string>();

/**
 * The receipt of a relayed call, waiting up to `waitMs` for it. Logs what
 * the call cost the first time its receipt is seen. `gasCost` is in the
 * chain's native units (USDC at 18 decimals on Arc).
 */
export async function relayOutcome(hash: Hex, opts: { kind: string; waitMs?: number }): Promise<{ ok: true; outcome: RelayOutcome } | Failure> {
  const client = publicClient();
  let receipt;
  try {
    receipt = opts.waitMs
      ? await client.waitForTransactionReceipt({ hash, timeout: opts.waitMs, pollingInterval: 500 })
      : await client.getTransactionReceipt({ hash });
  } catch (err) {
    if (err instanceof WaitForTransactionReceiptTimeoutError || err instanceof TransactionReceiptNotFoundError) {
      return { ok: true, outcome: { state: "pending" } };
    }
    return fail("CHAIN_UNAVAILABLE", `The network did not answer: ${short(err)}`);
  }
  const outcome = {
    state: receipt.status === "success" ? ("confirmed" as const) : ("reverted" as const),
    gasUsed: receipt.gasUsed,
    gasCost: receipt.gasUsed * receipt.effectiveGasPrice,
    blockNumber: receipt.blockNumber,
  };
  if (!logged.has(hash)) {
    if (logged.size > 5_000) logged.clear();
    logged.add(hash);
    const native = client.chain.nativeCurrency;
    log.info("relayed call mined", {
      kind: opts.kind,
      txHash: hash,
      state: outcome.state,
      gasUsed: outcome.gasUsed.toString(),
      gasCost: `${formatUnits(outcome.gasCost, native.decimals)} ${native.symbol}`,
    });
  }
  return { ok: true, outcome };
}

// ── the relayer's balance ─────────────────────────────────────────────

export interface RelayerStatus {
  address: Address;
  /** Native balance, which is what gas is paid in (USDC on Arc). */
  balance: string;
  symbol: string;
  low: boolean;
  checkedAt: string;
}

const STATUS_TTL_MS = 60_000;
let status: RelayerStatus | null = null;
let checkedAt = 0;
let checking = false;

/** Below this many native units the relayer is "low" (RELAYER_MIN_BALANCE, default 1). */
function minBalance(decimals: number): bigint {
  const raw = process.env.RELAYER_MIN_BALANCE?.trim() ?? "";
  return parseUnits(/^\d+(\.\d+)?$/.test(raw) ? raw : "1", decimals);
}

async function refreshStatus(): Promise<void> {
  if (checking || Date.now() - checkedAt < STATUS_TTL_MS) return;
  const sender = relayer();
  if (!sender) return;
  checking = true;
  try {
    const client = publicClient();
    const native = client.chain.nativeCurrency;
    const wei = await client.getBalance({ address: sender.account.address });
    checkedAt = Date.now();
    status = {
      address: sender.account.address,
      balance: formatUnits(wei, native.decimals),
      symbol: native.symbol,
      low: wei < minBalance(native.decimals),
      checkedAt: new Date(checkedAt).toISOString(),
    };
    if (status.low) {
      log.warn("relayer balance is low; payments stop when it runs out", {
        address: status.address,
        balance: `${status.balance} ${status.symbol}`,
      });
    }
  } catch (err) {
    log.warn("relayer balance check failed", { err });
  } finally {
    checking = false;
  }
}

/**
 * The relayer's balance as last read, or null before the first read or with
 * no relayer key. Never waits on the chain: a stale value starts a refresh
 * for the next caller.
 */
export function relayerStatus(): RelayerStatus | null {
  void refreshStatus();
  return status;
}
