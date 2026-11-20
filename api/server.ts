/**
 * Process bootstrap: the listener, background jobs, draining and crashes.
 * Dispatch lives in app.ts, routes in routes/ and web3/.
 *
 * Safe to run as several instances against one Postgres: background jobs
 * take a per-job advisory lock (jobs.ts), rate limits and relayer nonces
 * are shared in the database. SIGTERM/SIGINT drain the process (see
 * shutdown() below); GET /health is liveness, GET /health/ready readiness.
 *
 * Logging (log.ts, request-context.ts): every request runs in a context with
 * a reqId (echoed as X-Request-Id), gets one access line, and an exception
 * escaping a handler becomes a logged error and a 500 carrying the reqId.
 * In JSON mode console.* is bridged into the logger. Browser errors arrive
 * at POST /api/client-errors.
 */

import "reflect-metadata";
import { createServer } from "node:http";
import { handleRequest } from "./app.js";
import { initDb, em } from "./db.js";
import { isDraining, startDraining } from "./ops/drain.js";
import { jobsInFlight, stopJobs } from "./ops/jobs.js";
import { installConsoleBridge, log, logContext, logFormat } from "./ops/log.js";
import { consoleCodes, mailConfig, mailConfigError } from "./auth/mailer.js";
import { startRecapTimer } from "./games/recaps.js";
import { runRequest } from "./ops/request-context.js";
import { startResultTimer } from "./games/results.js";
import { readSession, sessionSecretConfigured } from "./auth/session.js";
import { startWeb3Timers } from "./web3/index.js";
import { startMarketsWarmer } from "./markets/warmer.js";
import { startPracticeSettleJob } from "./markets/settle-job.js";

const PORT = parseInt(process.env.PORT ?? "3000", 10);
/** How long a shutdown waits for requests and job ticks in flight. */
const SHUTDOWN_TIMEOUT_MS = (() => {
  const n = Number(process.env.SHUTDOWN_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 20_000;
})();
/**
 * How long, after the signal, the listener keeps accepting while readiness
 * already answers 503, so a load balancer's health check can take this
 * instance out first. Counts toward SHUTDOWN_TIMEOUT_MS. Default 0.
 */
const SHUTDOWN_DRAIN_DELAY_MS = (() => {
  const n = Number(process.env.SHUTDOWN_DRAIN_DELAY_MS);
  return Number.isFinite(n) && n > 0 ? Math.min(n, SHUTDOWN_TIMEOUT_MS) : 0;
})();

const server = createServer((req, res) => {
  // While draining, answer and close: no keep-alive connection outlives it.
  if (isDraining()) res.shouldKeepAlive = false;
  // reqId, access line, and the logged 500 for anything that throws.
  void runRequest(req, res, () => handleRequest(req, res), {
    userIdOf: (r) => readSession(r)?.userId,
  });
});

let orm: Awaited<ReturnType<typeof initDb>> | null = null;
/** Stops the Gemini warmer, which runs on its own timer rather than as a job. */
let stopMarketsWarmer = (): void => {};

/**
 * Drain and exit, for rolling deploys. In order: readiness turns 503 and
 * timers start no new tick (ticks in flight carry on); after
 * SHUTDOWN_DRAIN_DELAY_MS the listener closes (no new connections; idle
 * keep-alive ones close, busy ones close after their response); requests
 * and ticks in flight finish, up to SHUTDOWN_TIMEOUT_MS from the signal
 * (default 20s); anything still open is then cut; the ORM closes; the
 * process exits (0 if everything drained, 1 on the timeout). A second
 * signal exits at once.
 */
async function shutdown(signal: string, exitCode?: number): Promise<void> {
  if (isDraining()) {
    console.warn(`[shutdown] ${signal} again, exiting now`);
    process.exit(1);
  }
  startDraining();
  stopMarketsWarmer();
  const started = Date.now();
  console.log(`[shutdown] ${signal}: draining (timeout ${SHUTDOWN_TIMEOUT_MS}ms, ${jobsInFlight()} job tick(s) in flight)`);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((r) => {
    timer = setTimeout(() => r("timeout"), SHUTDOWN_TIMEOUT_MS);
  });
  const jobsDone = stopJobs(SHUTDOWN_TIMEOUT_MS);

  if (SHUTDOWN_DRAIN_DELAY_MS) await new Promise((r) => setTimeout(r, SHUTDOWN_DRAIN_DELAY_MS));
  const httpClosed = new Promise<void>((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
  });
  server.closeIdleConnections();
  // Connections that finish a request while draining are closed by the
  // handler above; sweep any that went idle in between.
  const idleSweep = setInterval(() => server.closeIdleConnections(), 250);

  const [http, jobs] = await Promise.all([
    Promise.race([httpClosed.then(() => "closed" as const), timedOut]),
    jobsDone,
  ]);
  clearTimeout(timer);
  clearInterval(idleSweep);
  if (http === "timeout") {
    console.warn("[shutdown] requests still open at the timeout; closing them");
    server.closeAllConnections();
  }
  if (!jobs) console.warn("[shutdown] job ticks still running at the timeout");

  try {
    await orm?.close();
  } catch (err) {
    console.warn("[shutdown] closing the database failed:", err instanceof Error ? err.message : err);
  }
  const clean = http === "closed" && jobs;
  console.log(`[shutdown] ${clean ? "drained" : "timed out"} in ${Date.now() - started}ms; exiting`);
  process.exit(exitCode ?? (clean ? 0 : 1));
}

/**
 * After an uncaught exception the process is in an unknown state: log it,
 * drain through shutdown() if possible, and exit non-zero so Docker
 * restarts the container. A hard timer makes sure it exits even if the
 * drain itself hangs or throws.
 */
function crash(): void {
  if (isDraining()) process.exit(1);
  setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS + 2_000);
  // Outside the failing request's log context: the drain is process-wide.
  logContext.exit(() => void shutdown("uncaughtException", 1).catch(() => process.exit(1)));
}

async function main(): Promise<void> {
  // JSON logs (production default): console.* becomes JSON lines too.
  if (logFormat() === "json") installConsoleBridge();
  process.on("unhandledRejection", (reason) => {
    log.error("unhandled promise rejection", { err: reason });
  });
  process.on("uncaughtException", (err) => {
    log.error("uncaught exception", { err });
    crash();
  });
  if (!sessionSecretConfigured()) {
    console.error("SESSION_SECRET is not configured.");
    process.exit(1);
  }
  // Login codes must go somewhere real in production, never to the log.
  const mailProblem = mailConfigError();
  if (mailProblem && process.env.NODE_ENV === "production") {
    console.error(`[mail] refusing to start: ${mailProblem}`);
    process.exit(1);
  }
  if (mailProblem) console.warn(`[mail] email login is off: ${mailProblem}`);
  try {
    orm = await initDb();
  } catch (err) {
    console.error("Postgres is unreachable or DATABASE_URL is missing.");
    console.error(err instanceof Error ? err.message : err);
    console.error("Start it with: docker compose up -d postgres && pnpm migration:up");
    process.exit(1);
  }

  // Recap posts for games that have just ended; see recaps.ts.
  startRecapTimer(em);
  // Sides lock at check-in close. A recorded result stays correctable for an hour; see results.ts.
  startResultTimer(em);
  // Web3 jobs (writing the record on chain); each is idle until configured.
  startWeb3Timers(em);
  // Pro markets: keep the sports people are viewing fresh from Gemini; see markets/warmer.ts.
  stopMarketsWarmer = startMarketsWarmer();
  // Practice picks settle and notify without anyone opening the markets card; see markets/settle-job.ts.
  startPracticeSettleJob(em);

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`Port ${PORT} is already in use. Stop the other process or set PORT=.`);
      process.exit(1);
    }
    console.error(err);
    process.exit(1);
  });

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  server.listen(PORT, () => {
    console.log(`\n  SportsArc API listening on http://localhost:${PORT}`);
    console.log(`  Frontend:     http://localhost:${PORT}/`);
    console.log(`  Games:        GET/POST http://localhost:${PORT}/api/games`);
    console.log(`  Join game:    POST http://localhost:${PORT}/api/games/:id/join`);
    console.log(`  Venues:       GET/POST http://localhost:${PORT}/api/venues`);
    console.log(`  Auth me:      GET  http://localhost:${PORT}/api/auth/me`);
    console.log(`  Health:       GET  http://localhost:${PORT}/health (ready: /health/ready)`);
    console.log(consoleCodes()
      ? `  OTP codes:    printed as [otp] in this terminal\n`
      : `  OTP codes:    sent by email (${mailConfig().provider})\n`);
  });
}

void main();
