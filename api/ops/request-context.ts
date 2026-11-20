/**
 * Per-request logging context, the access log, the last-resort 500, and
 * browser error reports (POST /api/client-errors).
 *
 * runRequest() gives every request a reqId (the incoming X-Request-Id when
 * Caddy or a client sent a sane one, else a fresh uuid), echoes it in the
 * X-Request-Id response header, runs the handler inside log.ts's
 * AsyncLocalStorage so every line logged meanwhile carries it, turns an
 * exception that escapes the handler into a logged error and a 500
 * `{ ok: false, error: { code: "INTERNAL", message, reqId } }`, and writes
 * one access line when the response closes: method, route pattern (never
 * the raw path), status, ms, and the signed-in userId (a uuid only).
 *
 * Health checks, static files and uploads log their access lines at debug.
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { EntityManager } from "@mikro-orm/postgresql";
import { log, logContext, type Level, type LogContext } from "./log.js";
import { advisoryKey } from "./jobs.js";
import { RateLimitHit } from "../entities/RateLimitHit.js";
import { isUuid } from "../validate.js";

/** Route names for requests no route pattern matched. */
export const ROUTE_STATIC = "(static)";
export const ROUTE_UNMATCHED = "(unmatched)";
export const ROUTE_OPTIONS = "(options)";

/** Access lines for these go out at debug: they are frequent and dull. */
const QUIET_ROUTES = new Set(["/health", "/health/ready", ROUTE_STATIC, "/uploads/:name"]);

/**
 * The incoming X-Request-Id if it is safe to log and echo (8–128 of
 * [A-Za-z0-9._:-]), otherwise a new uuid.
 */
export function requestId(header: string | string[] | undefined): string {
  const raw = Array.isArray(header) ? header[0] : header;
  const v = raw?.trim();
  if (v && /^[A-Za-z0-9._:-]{8,128}$/.test(v)) return v;
  return randomUUID();
}

/** Record the matched route pattern on the current request's context. */
export function setRoute(pattern: string): void {
  const store = logContext.getStore();
  if (store) store.route = pattern;
}

export function accessLevel(route: string, status: number): Level {
  if (status >= 500) return "warn";
  if (QUIET_ROUTES.has(route)) return "debug";
  return "info";
}

export interface RunRequestOptions {
  /** The signed-in user's id, if any (read when the response closes). */
  userIdOf?: (req: IncomingMessage) => string | undefined;
}

/**
 * Handle one request inside its logging context. `handle` may throw; the
 * error is logged once, at level error, with its stack and route, and the
 * client gets a 500 carrying the reqId.
 */
export async function runRequest(
  req: IncomingMessage,
  res: ServerResponse,
  handle: () => Promise<void>,
  opts: RunRequestOptions = {},
): Promise<void> {
  const reqId = requestId(req.headers["x-request-id"]);
  res.setHeader("X-Request-Id", reqId);
  const method = req.method ?? "GET";
  const ctx: LogContext = { reqId, source: "server" };
  const started = process.hrtime.bigint();

  res.once("close", () => {
    const route = ctx.route ?? ROUTE_UNMATCHED;
    const status = res.statusCode;
    const ms = Math.round(Number(process.hrtime.bigint() - started) / 1e5) / 10;
    let userId: string | undefined;
    try {
      const id = opts.userIdOf?.(req);
      if (id && isUuid(id)) userId = id;
    } catch {
      /* no user */
    }
    logContext.run(ctx, () => {
      const fields: Record<string, unknown> = { kind: "access", method, route, status, ms };
      if (userId) fields.userId = userId;
      if (!res.writableFinished) fields.aborted = true;
      log[accessLevel(route, status)](`${method} ${route} ${status}`, fields);
    });
  });

  await logContext.run(ctx, async () => {
    try {
      await handle();
    } catch (err) {
      log.error("unhandled error in route handler", { err, route: ctx.route ?? ROUTE_UNMATCHED, method });
      if (res.headersSent) {
        res.end();
        return;
      }
      const payload = JSON.stringify({
        ok: false,
        error: { code: "INTERNAL", message: "An unexpected error occurred.", reqId },
      }, null, 2);
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Length", Buffer.byteLength(payload));
      res.end(payload);
    }
  });
}

// ── browser error reports ─────────────────────────────────────────────

/** Largest accepted report body. */
export const CLIENT_ERROR_MAX_BYTES = 16 * 1024;
/** Reports accepted per user (or IP when signed out) per window. */
export const CLIENT_ERROR_MAX = 10;
export const CLIENT_ERROR_WINDOW_MS = 10 * 60 * 1000;

export interface ClientErrorReport {
  message: string;
  stack?: string;
  url?: string;
  line?: number;
  col?: number;
  reqId?: string;
}

const EMAIL = /[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[A-Za-z]{2,}/g;

/** Trim, drop query strings and email addresses from browser text. */
function cleanText(s: string, max: number): string {
  return s
    .replace(/\?[^\s)#]*/g, "")
    .replace(EMAIL, "[email]")
    .slice(0, max);
}

/**
 * A report as it may be logged, or null when there is no message. Every
 * field is bounded; url keeps the path only.
 */
export function parseClientError(raw: unknown): ClientErrorReport | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const message = typeof r.message === "string" ? cleanText(r.message.trim(), 500) : "";
  if (!message) return null;
  const out: ClientErrorReport = { message };
  if (typeof r.stack === "string" && r.stack.trim()) {
    out.stack = cleanText(r.stack.split("\n").slice(0, 20).join("\n"), 4_000);
  }
  if (typeof r.url === "string" && r.url) {
    let path = r.url;
    try {
      path = new URL(r.url, "http://x").pathname;
    } catch {
      path = r.url.split(/[?#]/)[0];
    }
    out.url = path.slice(0, 200);
  }
  const int = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 1e7 ? v : undefined);
  out.line = int(r.line);
  out.col = int(r.col);
  if (typeof r.reqId === "string" && /^[A-Za-z0-9._:-]{8,128}$/.test(r.reqId)) out.reqId = r.reqId;
  return out;
}

/**
 * Read at most `max` bytes of body. Resolves null (and stops reading) when
 * the body is larger; the caller answers 413.
 */
export function readCappedBody(req: IncomingMessage, max: number): Promise<string | null> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > max) {
    req.resume();
    return Promise.resolve(null);
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on("data", (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > max) {
        done = true;
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!done) resolve(Buffer.concat(chunks).toString("utf-8"));
    });
    req.on("error", (e) => {
      if (!done) reject(e);
    });
  });
}

const PRIVATE_PEER = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|::ffff:127\.|::ffff:10\.|::ffff:192\.168\.|fc|fd)/i;

/**
 * Who a report counts against: the signed-in user, else the client IP. The
 * IP is the socket peer, or, when the peer is a private or loopback address
 * (Caddy in front), the last hop Caddy appended to X-Forwarded-For.
 */
export function clientKey(req: IncomingMessage, userId: string | undefined): string {
  if (userId) return `user:${userId}`;
  const peer = req.socket.remoteAddress ?? "";
  const fwd = req.headers["x-forwarded-for"];
  const list = (Array.isArray(fwd) ? fwd.join(",") : fwd ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const ip = PRIVATE_PEER.test(peer) && list.length ? list[list.length - 1] : peer;
  return `ip:${ip.slice(0, 64)}`;
}

/**
 * Sliding-window limit on rate_limit_hits (bucket "client_error"), shared by
 * every instance: true when `key` is over the limit, else records the hit.
 */
export async function clientErrorRateLimited(
  em: EntityManager,
  key: string,
  max = CLIENT_ERROR_MAX,
  windowMs = CLIENT_ERROR_WINDOW_MS,
): Promise<boolean> {
  const bucket = "client_error";
  return em.transactional(async (tx) => {
    await tx.execute("select pg_advisory_xact_lock(cast(? as bigint))", [advisoryKey(`ratelimit:${bucket}:${key}`)]);
    const now = new Date();
    const since = new Date(now.getTime() - windowMs);
    await tx.nativeDelete(RateLimitHit, { bucket, hitAt: { $lte: since } });
    const hits = await tx.count(RateLimitHit, { bucket, key, hitAt: { $gt: since } });
    if (hits >= max) return true;
    const hit = new RateLimitHit();
    hit.bucket = bucket;
    hit.key = key;
    hit.hitAt = now;
    await tx.insert(RateLimitHit, hit);
    return false;
  });
}

/** Log an accepted report: level error, source client. */
export function logClientError(report: ClientErrorReport, userId: string | undefined): void {
  logContext.run({ ...logContext.getStore(), source: "client" }, () => {
    log.error(`client: ${report.message}`, {
      err: { name: "ClientError", message: report.message, stack: report.stack },
      url: report.url,
      line: report.line,
      col: report.col,
      failedReqId: report.reqId,
      userId,
    });
  });
}
