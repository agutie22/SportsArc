/**
 * Nonces for the server relayer. Several background jobs (record timer,
 * event timer, gateway payouts, claims) send from one key; left alone, viem
 * reads the `pending` transaction count for each send, and two sends in the
 * same moment pick the same nonce.
 *
 * serialWalletClient() returns an ordinary viem wallet client whose sends
 * (sendTransaction, and through it writeContract, deployContract and the
 * *Sync variants) run one at a time per address and chain. Under the lock a
 * send reads the `pending` count fresh, takes the larger of that and one
 * past the last nonce this process broadcast, and only moves that mark once
 * the node has accepted the transaction. A send that fails before or at
 * broadcast (gas estimation reverts, the RPC refuses it, the process throws
 * first) leaves the mark where it was, so the next send reuses the nonce
 * and no gap can form.
 *
 * The local mark covers nodes whose `pending` count lags or ignores their
 * own mempool. It is trusted for LOCAL_TRUST_MS after the last broadcast
 * only: if a broadcast tx is later dropped, sends go back to the chain's
 * count once that window has passed and fill the gap themselves.
 *
 * Why not viem's `nonceManager` (checked in viem 2.48,
 * utils/nonceManager.ts and actions/wallet/prepareTransactionRequest.ts):
 * it consumes a nonce in prepareTransactionRequest, before gas estimation,
 * signing and broadcast, and nothing gives it back when those fail. Its
 * private `nonceMap` keeps the last consumed nonce N, and a later read of
 * `pending` that is <= N returns N + 1, so a single failed send (other than
 * the account's very first) leaves a permanent gap for the life of the
 * process; `reset()` clears only the in-flight delta, not that map.
 *
 * Across processes: once the database is up (db.ts initDb, as the API and
 * the scripts do), a send also holds a Postgres advisory lock for its
 * address and chain from reading `pending` through broadcast, inside a
 * transaction, and the mark is shared in relayer_nonces (RelayerNonce.ts):
 * the nonce is the largest of `pending`, this process's fresh mark and the
 * shared fresh mark. The shared mark moves in the same transaction as the
 * broadcast succeeds, so a refused send rolls it back and leaves no gap, as
 * above. Without a database (a script that never calls initDb) sends are
 * serialized within the process only. The in-process queue stays in front
 * of the lock, so a process has at most one send per lane waiting on it.
 */

import {
  createClient,
  encodeDeployData,
  walletActions,
  type Account,
  type Chain,
  type Client,
  type Hash,
  type Hex,
  type Transport,
  type WalletClient,
} from "viem";
import { getBlock, getTransactionCount, sendTransaction, waitForTransactionReceipt } from "viem/actions";
import type { EntityManager } from "@mikro-orm/postgresql";
import { advisoryKey } from "../../ops/jobs.js";

/**
 * How long a broadcast nonce is trusted over a lower `pending` count. A tx
 * not seen by then is treated as dropped and its nonce is reused.
 */
export const LOCAL_TRUST_MS = 90_000;

interface Lane {
  /** Tail of the queue of sends for this address and chain. */
  tail: Promise<void>;
  /** One past the last nonce the node accepted from this process. */
  next: number | null;
  /** When `next` was last set. */
  at: number;
}

const lanes = new Map<string, Lane>();

function laneFor(address: string, chainId: number): Lane {
  const key = `${address.toLowerCase()}:${chainId}`;
  let lane = lanes.get(key);
  if (!lane) {
    lane = { tail: Promise.resolve(), next: null, at: 0 };
    lanes.set(key, lane);
  }
  return lane;
}

/** Run `fn` after every earlier send on this lane has settled. */
function queued<T>(lane: Lane, fn: () => Promise<T>): Promise<T> {
  const run = lane.tail.then(fn);
  lane.tail = run.then(() => undefined, () => undefined);
  return run;
}

type SendArgs = Parameters<typeof sendTransaction>[1];

/** How long a send waits for another instance's send on the same lane. */
const SHARED_LOCK_TIMEOUT = "60s";

/** The database, if this process has initialized it; else null. */
async function database(): Promise<EntityManager | null> {
  const db = await import("../../db.js");
  try {
    return db.em();
  } catch {
    return null;
  }
}

/** Block 0's hash per chain id, per process (the shared mark's chain identity). */
const genesisHashes = new Map<number, Promise<string>>();

function genesisOf(base: Client<Transport, Chain, Account>, chainId: number): Promise<string> {
  let p = genesisHashes.get(chainId);
  if (!p) {
    p = getBlock(base, { blockNumber: 0n }).then((b) => String(b.hash).toLowerCase());
    genesisHashes.set(chainId, p);
    p.catch(() => genesisHashes.delete(chainId));
  }
  return p;
}

const SHARED_MARK_SQL = `
  select next_nonce, genesis, (now() - updated_at) < make_interval(secs => ?) as fresh
    from relayer_nonces
   where address = ? and chain_id = ?`;

const SAVE_MARK_SQL = `
  insert into relayer_nonces (address, chain_id, genesis, next_nonce, updated_at)
  values (?, ?, ?, ?, now())
  on conflict (address, chain_id)
  do update set genesis = excluded.genesis, next_nonce = excluded.next_nonce, updated_at = now()`;

async function serialSend(base: Client<Transport, Chain, Account>, args: SendArgs): Promise<Hash> {
  const raw = (args as { account?: Account | string }).account ?? base.account;
  const account = typeof raw === "string" ? null : raw;
  // Only a local key signs here; anything else is the node's business.
  if (!account || account.type !== "local") return sendTransaction(base, args);
  const chainId = (args as { chain?: Chain | null }).chain?.id ?? base.chain.id;
  const lane = laneFor(account.address, chainId);
  const given = (args as { nonce?: number }).nonce;

  /** Pick a nonce over `shared` (a fresh shared mark, or null) and broadcast. */
  const pickAndSend = async (shared: number | null): Promise<{ hash: Hash; nonce: number }> => {
    let nonce = given;
    if (nonce === undefined) {
      const pending = await getTransactionCount(base, { address: account.address, blockTag: "pending" });
      const trusted = lane.next !== null && Date.now() - lane.at < LOCAL_TRUST_MS;
      nonce = Math.max(pending, trusted ? (lane.next as number) : 0, shared ?? 0);
    }
    // Throws before the mark moves: a refused send leaves no gap.
    const hash = await sendTransaction(base, { ...args, nonce } as SendArgs);
    lane.next = given === undefined ? nonce + 1 : Math.max(lane.next ?? 0, given + 1);
    lane.at = Date.now();
    return { hash, nonce };
  };

  return queued(lane, async () => {
    const db = await database();
    if (!db) return (await pickAndSend(null)).hash;
    const address = account.address.toLowerCase();
    const genesis = await genesisOf(base, chainId);
    let sent: Hash | null = null;
    try {
      return await db.transactional(async (tx) => {
        await tx.execute(`set local lock_timeout = '${SHARED_LOCK_TIMEOUT}'`);
        await tx.execute("select pg_advisory_xact_lock(cast(? as bigint))", [advisoryKey(`relayer:${address}:${chainId}`)]);
        const [row] = await tx.execute<{ next_nonce: string; genesis: string; fresh: boolean }[]>(
          SHARED_MARK_SQL,
          [LOCAL_TRUST_MS / 1000, address, chainId],
        );
        const known = row && row.genesis === genesis ? Number(row.next_nonce) : null;
        const shared = row?.fresh ? known : null;
        const { hash, nonce } = await pickAndSend(shared);
        sent = hash;
        const next = given === undefined ? nonce + 1 : Math.max(known ?? 0, given + 1);
        await tx.execute(SAVE_MARK_SQL, [address, chainId, genesis, String(next)]);
        return hash;
      });
    } catch (err) {
      // Broadcast, but the shared mark did not commit: the send still
      // happened, so report it; this process's mark and `pending` cover the
      // next send.
      if (sent) {
        console.warn("[relayer] shared nonce mark not saved:", err instanceof Error ? err.message : err);
        return sent;
      }
      throw err;
    }
  });
}

/**
 * A wallet client for `account` whose sends are serialized per address and
 * chain (see the file header). Typed as the plain viem wallet client, so
 * callers need not know.
 */
export function serialWalletClient<T extends Transport, C extends Chain, A extends Account>(opts: {
  account: A;
  chain: C;
  transport: T;
}) {
  const inner = createClient({
    account: opts.account,
    chain: opts.chain,
    transport: opts.transport,
    key: "wallet",
    name: "Wallet Client",
    type: "walletClient",
  }) as unknown as Client<Transport, Chain, Account>;
  const send = (args: SendArgs) => serialSend(inner, args);
  // walletActions binds each action to the client it extends, and actions
  // such as writeContract look sendTransaction up on that client: so the
  // override goes in before walletActions (for the actions that look it up)
  // and again after (for the direct methods, which walletActions replaces).
  const overrides = () => ({
    sendTransaction: send,
    sendTransactionSync: async (args: SendArgs & { pollingInterval?: number; timeout?: number }) => {
      const { pollingInterval, timeout, ...rest } = args;
      const hash = await send(rest as SendArgs);
      return waitForTransactionReceipt(inner, { hash, pollingInterval, timeout });
    },
    deployContract: (args: { abi: readonly unknown[]; args?: readonly unknown[]; bytecode: Hex }) => {
      const { abi, args: ctorArgs, bytecode, ...rest } = args;
      return send({ ...rest, data: encodeDeployData({ abi, args: ctorArgs, bytecode } as never) } as unknown as SendArgs);
    },
  });
  // The overrides change no signature, only how nonces are picked; the
  // generic extend() types cannot express a same-shape override.
  type Loose = { extend: (fn: (c: never) => unknown) => Loose };
  const client = (inner as unknown as Loose).extend(overrides).extend(walletActions as never).extend(overrides);
  return client as unknown as WalletClient<T, C, A>;
}
