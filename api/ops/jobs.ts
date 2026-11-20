/**
 * Background jobs that run once per tick across every API instance.
 *
 * Every timer (recaps, the results sweep, and the web3
 * timers) starts through startJob(). A tick runs only while this process
 * holds a Postgres advisory lock named for the job; an instance that finds
 * it taken skips that tick quietly, so N instances behave like one. Ticks of
 * one job never overlap within a process either.
 *
 * The locks are session-level (`pg_try_advisory_lock`) on one dedicated
 * connection per process, opened outside the ORM pool so a long tick never
 * holds a pool slot the tick itself needs. If that connection drops,
 * Postgres releases its locks; the next tick reconnects. A tick still
 * running at that moment finishes, so a lost connection can let one tick
 * overlap another instance's (every job here is idempotent on its own rows;
 * the lock is what keeps them from doing the work twice, not what keeps it
 * correct).
 *
 * stopJobs() is the shutdown half: no new ticks start, and it waits for the
 * ones in flight. Importing this module starts nothing.
 */

import { createHash } from "node:crypto";
import type { EntityManager } from "@mikro-orm/postgresql";
import { log, withLogContext } from "./log.js";

/**
 * A signed 64-bit advisory lock key for a name, as a decimal string (pass
 * it as `cast(? as bigint)`). Names are namespaced so they never meet the
 * small literal keys other modules use (record/writer.ts, record/sender.ts).
 */
export function advisoryKey(name: string): string {
  return createHash("sha256").update(`sportsarc:${name}`).digest().readBigInt64BE(0).toString();
}

/** What pg's Client looks like, for the one dedicated lock connection. */
interface PgClient {
  connect(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
  on(event: "error" | "end", fn: (err?: Error) => void): void;
}

let lockConn: Promise<PgClient> | null = null;
/** Queries on the lock connection run one at a time (pg deprecates overlap). */
let lockQueue: Promise<unknown> = Promise.resolve();

function lockQuery(conn: PgClient, sql: string, params: unknown[]) {
  const run = lockQueue.then(() => conn.query(sql, params));
  lockQueue = run.catch(() => undefined);
  return run;
}

/**
 * The process's lock connection: a pg Client built from the same driver
 * and settings the ORM uses (no new dependency, no pool slot).
 */
function lockConnection(fork: () => EntityManager): Promise<PgClient> {
  if (lockConn) return lockConn;
  const pending = (async () => {
    const knex = fork().getConnection().getKnex() as unknown as {
      client: { driver: { Client: new (settings: unknown) => PgClient }; connectionSettings: unknown };
    };
    const client = new knex.client.driver.Client(knex.client.connectionSettings);
    const drop = () => {
      if (lockConn === pending) lockConn = null;
    };
    client.on("error", (err) => {
      console.warn("[jobs] lock connection lost:", err instanceof Error ? err.message : err);
      drop();
    });
    client.on("end", drop);
    await client.connect();
    return client;
  })();
  lockConn = pending;
  pending.catch(() => {
    if (lockConn === pending) lockConn = null;
  });
  return pending;
}

/**
 * Run `fn` only if this process can take the job's advisory lock right now.
 * Returns `{ ran: false }` when another instance holds it (or the database
 * cannot be reached for the lock). The lock is released in `finally`.
 */
export async function withJobLock<T>(
  name: string,
  fork: () => EntityManager,
  fn: () => Promise<T>,
): Promise<{ ran: true; value: T } | { ran: false }> {
  const key = advisoryKey(`job:${name}`);
  let conn: PgClient;
  let got = false;
  try {
    conn = await lockConnection(fork);
    const r = await lockQuery(conn, "select pg_try_advisory_lock($1::bigint) as got", [key]);
    got = r.rows[0]?.got === true;
  } catch (err) {
    console.warn(`[jobs] ${name}: lock unavailable:`, err instanceof Error ? err.message : err);
    return { ran: false };
  }
  if (!got) return { ran: false };
  try {
    return { ran: true, value: await fn() };
  } finally {
    // If the connection is gone, Postgres has already released the lock.
    await lockQuery(conn, "select pg_advisory_unlock($1::bigint)", [key]).catch(() => undefined);
  }
}

export interface JobOptions {
  /** Lock name; one per job, the same in every instance. */
  name: string;
  fork: () => EntityManager;
  everyMs: number;
  /** Run a tick at start as well as on the interval (default true). */
  runNow?: boolean;
}

interface Job {
  name: string;
  handle: ReturnType<typeof setInterval>;
}

const jobs = new Set<Job>();
const inFlight = new Set<Promise<void>>();
let stopping = false;

/**
 * Start a job: `tick` every `everyMs`, once across all instances, never
 * overlapping itself in this process, and never after stopJobs(). `tick`
 * does its own logging and error handling, as each module's did before.
 * Returns a function that stops this job's interval.
 */
export function startJob(opts: JobOptions, tick: () => Promise<void>): () => void {
  let running = false;
  const run = () => {
    if (running || stopping) return;
    running = true;
    // Everything logged during the tick carries source "job:<name>".
    const p = withLogContext({ source: `job:${opts.name}`, reqId: undefined }, async () => {
      try {
        await withJobLock(opts.name, opts.fork, tick);
      } catch (err) {
        log.error(`${opts.name}: tick failed`, { module: "jobs", job: opts.name, err });
      } finally {
        running = false;
      }
    });
    inFlight.add(p);
    void p.finally(() => inFlight.delete(p));
  };
  const handle = setInterval(run, opts.everyMs);
  handle.unref();
  const job = { name: opts.name, handle };
  jobs.add(job);
  if (opts.runNow !== false) run();
  return () => {
    clearInterval(handle);
    jobs.delete(job);
  };
}

/** Ticks running right now, in this process. */
export function jobsInFlight(): number {
  return inFlight.size;
}

/**
 * Shutdown: stop every interval, start no new tick, and wait for the ticks
 * in flight, up to `timeoutMs`. Resolves true if they all finished. Closes
 * the lock connection afterwards (which releases any lock still held).
 */
export async function stopJobs(timeoutMs: number): Promise<boolean> {
  stopping = true;
  for (const job of jobs) clearInterval(job.handle);
  jobs.clear();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finished = await Promise.race([
    Promise.allSettled([...inFlight]).then(() => true),
    new Promise<boolean>((r) => {
      timer = setTimeout(() => r(false), timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  const conn = lockConn;
  lockConn = null;
  if (conn) await conn.then((c) => c.end()).catch(() => undefined);
  return finished;
}
