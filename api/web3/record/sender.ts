/**
 * Writes records to SportsArcRecord, one transaction each, from the server's
 * relayer key (chains.ts relayer(), with its nonce queue). Safe to re-run:
 * the chain is the truth, so a record already on chain is confirmed whoever
 * wrote it, a transaction still in the mempool is left alone, and one that
 * reverted or was dropped is sent again, at most MAX_ATTEMPTS times. Every
 * send is simulated first, so a key that is not a writer costs no gas.
 *
 *   pending → (simulate, send) → sending → (receipt, writtenAt set) → confirmed
 *                                        ↘ (reverted) → failed → retried later
 *
 * With no TESTNET_PRIVATE_KEY or RECORD_CONTRACT_ADDRESS nothing is sent:
 * records stay "pending" and the result says NOT_CONFIGURED (the app runs
 * without a chain).
 *
 * The first time a check-in is confirmed, its player is told it is now a
 * verified record. Missed games are not announced.
 */

import type { EntityManager } from "@mikro-orm/postgresql";
import { BaseError, ContractFunctionRevertedError, type Address, type Hex } from "viem";
import { log } from "../../ops/log.js";
import { notify } from "../../social/notifications.js";
import { fail, type Failure } from "../../failure.js";
import { publicClient, relayer } from "../chains.js";
import { contractAddress } from "../contracts.js";
import { recordAbi } from "./abi.js";
import { RecordEntry, type RecordStatus } from "./RecordEntry.js";
import { isRecordKind, RECORD_KINDS } from "./hashes.js";

/** A record whose sends reverted this many times waits for a person to look. */
export const MAX_ATTEMPTS = 5;

/**
 * Most record transactions unconfirmed at once (RECORD_MAX_IN_FLIGHT,
 * default 10). The relayer's nonce queue also carries players' payments, so
 * a backlog of records goes out a few at a time instead of all at once.
 */
export function maxInFlight(): number {
  const n = Number(process.env.RECORD_MAX_IN_FLIGHT);
  return Number.isInteger(n) && n > 0 ? n : 10;
}

/** Arbitrary constant naming the "writing this record" lock (the second key is the row). */
const POST_LOCK_KEY = 72_630_002;

/** Blocks one log query may span on Arc's public RPC (10,000 is refused). */
const LOG_SPAN = 1_000n;
/** How far back to look for a record's Written event: 20 windows, a few hours of Arc blocks. */
const LOG_WINDOWS = 20;

export function recordConfigured(): boolean {
  return relayer() !== null && contractAddress("record") !== null;
}

const NOT_CONFIGURED = "Set TESTNET_PRIVATE_KEY and RECORD_CONTRACT_ADDRESS to write records.";

export interface PostOutcome {
  recordId: string;
  status: RecordStatus;
  txHash: string | null;
}

/** Short, with the decoded custom error (e.g. NotWriter) when there is one. */
function errorText(err: unknown): string {
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError && revert.data) {
      const args = (revert.data.args ?? []).map(String).join(", ");
      return `${err.shortMessage} ${revert.data.errorName}(${args})`.slice(0, 500);
    }
    return err.shortMessage.slice(0, 500);
  }
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}

/** The transaction that wrote `hash`, from the contract's own Written event, searched back from `near`. */
async function writingTx(address: Address, hash: Hex, near: bigint) {
  const client = publicClient();
  for (let i = 0; i < LOG_WINDOWS; i++) {
    const to = near - BigInt(i) * LOG_SPAN;
    if (to < 0n) break;
    const from = to >= LOG_SPAN ? to - LOG_SPAN + 1n : 0n;
    const logs = await client.getContractEvents({
      address, abi: recordAbi, eventName: "Written", args: { entry: hash }, fromBlock: from, toBlock: to,
    });
    const found = logs[0];
    if (found?.transactionHash && found.blockNumber != null) {
      return { txHash: found.transactionHash, blockNumber: Number(found.blockNumber) };
    }
  }
  return null;
}

/** Send, follow or confirm one record. Call inside the row's lock (postPendingRecords). */
export async function postRecord(em: EntityManager, row: RecordEntry): Promise<({ ok: true } & PostOutcome) | Failure> {
  const done = (): { ok: true } & PostOutcome => ({ ok: true, recordId: row.id, status: row.status, txHash: row.txHash ?? null });
  if (row.status === "confirmed") return done();

  const wallet = relayer();
  const address = contractAddress("record");
  if (!wallet || !address) return fail("NOT_CONFIGURED", NOT_CONFIGURED);
  if (!isRecordKind(row.kind)) return fail("UNKNOWN_KIND", `No record kind ${row.kind}.`);

  const client = publicClient();
  const chainId = wallet.chain.id;
  if (row.status === "sending" && row.contract && (row.chainId !== chainId || row.contract.toLowerCase() !== address.toLowerCase())) {
    return fail("CHAIN_MISMATCH", "Record was sent to another chain or contract; switch back to reconcile it.");
  }
  const hash = row.hash as Hex;

  const confirm = async (writtenAt: bigint) => {
    // Our own successful receipt names the transaction. Without one (another
    // writer won, or our receipt was lost) take it from the contract's event.
    const receipt = row.txHash ? await client.getTransactionReceipt({ hash: row.txHash as Hex }).catch(() => null) : null;
    if (receipt?.status === "success") {
      row.blockNumber = Number(receipt.blockNumber);
    } else {
      const found = await writingTx(address, hash, receipt?.blockNumber ?? (await client.getBlockNumber())).catch(() => null);
      row.txHash = found?.txHash ?? null;
      row.blockNumber = found?.blockNumber ?? null;
    }
    const first = row.status !== "confirmed";
    row.status = "confirmed";
    row.chainId = chainId;
    row.contract = address;
    row.writtenAt = new Date(Number(writtenAt) * 1000);
    row.lastError = null;
    await em.flush();
    if (first) await announce(em, row).catch(() => {});
    return done();
  };

  try {
    const onChain = await client.readContract({ address, abi: recordAbi, functionName: "writtenAt", args: [hash] });
    if (onChain > 0n) return confirm(onChain);

    if (row.status === "sending" && row.txHash) {
      const tx = row.txHash as Hex;
      const receipt = await client.getTransactionReceipt({ hash: tx }).catch(() => null);
      if (receipt) {
        // Mined without writing the record: it reverted.
        row.status = "failed";
        row.lastError = "Transaction reverted.";
        await em.flush();
        log.warn("record write reverted", { recordId: row.id, kind: row.kind, txHash: tx });
        return done();
      }
      // Still in the mempool: wait. Unknown to the node: dropped, send again below.
      if (await client.getTransaction({ hash: tx }).then(() => true, () => false)) return done();
    }
    if (row.status === "failed" && row.attempts >= MAX_ATTEMPTS) return done();

    const { request } = await client.simulateContract({
      account: wallet.account, address, abi: recordAbi, functionName: "write", args: [hash, RECORD_KINDS[row.kind].tag],
    });
    const tx = await wallet.writeContract(request);
    row.status = "sending";
    row.txHash = tx;
    row.chainId = chainId;
    row.contract = address;
    row.blockNumber = null;
    row.attempts += 1;
    row.lastError = null;
    await em.flush();
    return done();
  } catch (err) {
    row.lastError = errorText(err);
    await em.flush();
    return fail("CHAIN_ERROR", row.lastError);
  }
}

/** Tell the player their check-in is now a verified record. Once per game: notify() dedupes. */
async function announce(em: EntityManager, row: RecordEntry): Promise<void> {
  if (row.kind !== "checkin" || !row.participant) return;
  await em.populate(row, ["participant", "participant.game"]);
  const seat = row.participant;
  if (seat) await notify(em, { recipient: seat.user.id, kind: "verified", game: seat.game });
}

type Outcome = PostOutcome | (Failure & { recordId: string });

/** Handle one record inside its own lock; null when another process holds it. */
async function underLock(em: EntityManager, id: string): Promise<Outcome | null> {
  const r = await em.fork().transactional(async (tx) => {
    const [lock] = await tx.execute<{ got: boolean }[]>(
      "select pg_try_advisory_xact_lock(?, hashtext(?)) as got", [POST_LOCK_KEY, id],
    );
    if (!lock?.got) return null;
    const row = await tx.findOneOrFail(RecordEntry, { id });
    return postRecord(tx, row);
  }).catch((err: unknown) => fail("CHAIN_ERROR", err instanceof Error ? err.message : String(err)));
  if (r === null) return null;
  return r.ok ? { recordId: r.recordId, status: r.status, txHash: r.txHash } : { ...r, recordId: id };
}

/**
 * Follow every transaction on its way, then send new records (oldest
 * first) while fewer than maxInFlight() are unconfirmed. `limit` caps the
 * new sends.
 */
export async function postPendingRecords(
  em: EntityManager,
  opts: { limit?: number } = {},
): Promise<{ ok: true; results: Outcome[] } | Failure> {
  if (!recordConfigured()) return fail("NOT_CONFIGURED", NOT_CONFIGURED);
  const results: Outcome[] = [];

  const sending = await em.find(RecordEntry, { status: "sending" }, { orderBy: { createdAt: "ASC" }, fields: ["id"] });
  let inFlight = 0;
  for (const { id } of sending) {
    const r = await underLock(em, id);
    if (!r) { inFlight++; continue; }
    results.push(r);
    if (!("ok" in r) && r.status === "sending") inFlight++;
  }

  const room = Math.min(opts.limit ?? 100, maxInFlight() - inFlight);
  if (room <= 0) return { ok: true, results };
  const open = await em.find(
    RecordEntry,
    { $or: [{ status: "pending" }, { status: "failed", attempts: { $lt: MAX_ATTEMPTS } }] },
    { orderBy: { createdAt: "ASC" }, limit: room, fields: ["id"] },
  );
  for (const { id } of open) {
    const r = await underLock(em, id);
    if (r) results.push(r);
  }
  return { ok: true, results };
}
