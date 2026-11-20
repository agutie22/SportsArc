/**
 * Request/response helpers shared by every route module (api/routes/*,
 * api/web3/*): JSON answers, body parsing, and the access wrappers.
 *
 * A route's access is declared where it is registered: `authed(...)` needs a
 * session, `adminOnly(...)` (routes/admin.ts) an admin, anything else is
 * public and must be listed in route-access.test.ts.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";
import type { EntityManager } from "@mikro-orm/postgresql";
import { em } from "./db.js";
import { clearSessionCookie, readSession } from "./auth/session.js";
import { findUserById } from "./social/users.js";
import type { RouteContext, RouteHandler } from "./router.js";
import type { User } from "./entities/User.js";

export interface ErrorResponse {
  ok: false;
  error: { code: string; message: string; details?: unknown };
}

/** Bodies smaller than this are sent as they are: gzip would not pay for itself. */
const GZIP_MIN_BYTES = 1024;

/** Does the request that `res` answers accept gzip? */
function acceptsGzip(res: ServerResponse): boolean {
  const header = (res as ServerResponse & { req?: IncomingMessage }).req?.headers["accept-encoding"];
  return typeof header === "string" && /\bgzip\b/.test(header) && !/\bgzip\s*;\s*q=0(\.0*)?\b/.test(header);
}

/**
 * Answer with JSON. Browsers get it compact and gzipped when it is over 1 KB
 * (market lists shrink about tenfold); a client that does not ask for gzip,
 * like a bare curl, gets it indented for reading.
 */
export function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Vary", "Accept-Encoding");
  if (acceptsGzip(res)) {
    const compact = JSON.stringify(body);
    if (Buffer.byteLength(compact) >= GZIP_MIN_BYTES) {
      const zipped = gzipSync(compact, { level: 6 });
      res.setHeader("Content-Encoding", "gzip");
      res.setHeader("Content-Length", zipped.length);
      res.end(zipped);
      return;
    }
    res.setHeader("Content-Length", Buffer.byteLength(compact));
    res.end(compact);
    return;
  }
  const payload = JSON.stringify(body, null, 2);
  res.setHeader("Content-Length", Buffer.byteLength(payload));
  res.end(payload);
}

/** Answer `{ ok: false, error: { code, message } }`. */
export function errorJson(res: ServerResponse, status: number, code: string, message: string): void {
  json(res, status, { ok: false, error: { code, message } } satisfies ErrorResponse);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

export async function parseJsonBody<T>(req: IncomingMessage, res: ServerResponse): Promise<T | null> {
  try {
    const raw = await readBody(req);
    return (raw ? JSON.parse(raw) : {}) as T;
  } catch {
    json(res, 400, {
      ok: false,
      error: { code: "INVALID_JSON", message: "Request body must be valid JSON." },
    } satisfies ErrorResponse);
    return null;
  }
}

function unauthorized(res: ServerResponse): void {
  errorJson(res, 401, "AUTH_REQUIRED", "Not signed in.");
}

export interface Auth {
  user: User;
  fork: EntityManager;
}

/** Resolve the signed-in user, or answer 401 and return null. */
export async function requireUser(ctx: RouteContext): Promise<Auth | null> {
  const session = readSession(ctx.req);
  if (!session) {
    unauthorized(ctx.res);
    return null;
  }
  const fork = em();
  const user = await findUserById(fork, session.userId);
  if (!user) {
    clearSessionCookie(ctx.res);
    unauthorized(ctx.res);
    return null;
  }
  return { user, fork };
}

/** A route that needs a session; anyone else gets the 401. */
export function authed(handler: (ctx: RouteContext, auth: Auth) => Promise<void> | void): RouteHandler {
  return async (ctx) => {
    const auth = await requireUser(ctx);
    if (!auth) return;
    await handler(ctx, auth);
  };
}

/** The signed-in viewer on a public route, if any. */
export async function viewerOf(ctx: RouteContext, fork: EntityManager): Promise<User | undefined> {
  const session = readSession(ctx.req);
  return session ? (await findUserById(fork, session.userId)) ?? undefined : undefined;
}

/**
 * HTTP status for a handler result, from a module-local code table. Each
 * route module keeps its own table.
 */
export function statusFor(
  result: { ok: boolean; error?: { code: string } },
  codes: Record<string, number>,
): number {
  if (result.ok) return 200;
  const code = result.error?.code ?? "";
  if (code === "VALIDATION_ERROR") return 400;
  if (code === "AUTH_REQUIRED") return 401;
  return codes[code] ?? 500;
}
