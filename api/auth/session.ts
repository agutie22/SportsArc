/**
 * HMAC-signed httpOnly app session. Cookie is userId + exp only.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export const SESSION_COOKIE = "sportsarc_session";
const MAX_AGE_SEC = 7 * 24 * 60 * 60;

export interface AppSession {
  userId: string;
  exp: number;
}

export function sessionSecretConfigured(): boolean {
  return Boolean(process.env.SESSION_SECRET?.trim());
}

export function sessionSecret(): string {
  const s = process.env.SESSION_SECRET?.trim();
  if (!s) {
    throw new Error("SESSION_SECRET is not configured.");
  }
  return s;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function signPayload(payload: AppSession): string {
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const mac = createHmac("sha256", sessionSecret()).update(body).digest();
  return `${body}.${b64url(mac)}`;
}

function verifyToken(token: string): AppSession | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const macB64 = token.slice(dot + 1);
  let expected: Buffer;
  let given: Buffer;
  try {
    expected = createHmac("sha256", sessionSecret()).update(body).digest();
    given = Buffer.from(macB64, "base64url");
  } catch {
    return null;
  }
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as AppSession;
    if (!parsed?.userId || typeof parsed.exp !== "number") {
      return null;
    }
    if (parsed.exp * 1000 < Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function parseCookies(req: IncomingMessage): Record<string, string> {
  const header = req.headers.cookie;
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function readSession(req: IncomingMessage): AppSession | null {
  if (!sessionSecretConfigured()) return null;
  const raw = parseCookies(req)[SESSION_COOKIE];
  if (!raw) return null;
  return verifyToken(raw);
}

function cookieFlags(maxAge = MAX_AGE_SEC): string {
  const secure = process.env.COOKIE_SECURE === "1" ? "; Secure" : "";
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export function setSessionCookie(res: ServerResponse, session: { userId: string }): void {
  const payload: AppSession = {
    userId: session.userId,
    exp: Math.floor(Date.now() / 1000) + MAX_AGE_SEC,
  };
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(signPayload(payload))}; ${cookieFlags()}`,
  );
}

export function clearSessionCookie(res: ServerResponse): void {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; ${cookieFlags(0)}`);
}
