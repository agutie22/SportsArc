/**
 * The OAuth `state` for connecting a Gemini account, kept in a short-lived
 * signed cookie between /api/markets/connect and /api/markets/callback.
 *
 * It carries the user it was made for (the callback must be the same
 * signed-in user), a nonce that is also sent to Gemini as `state`, the PKCE
 * verifier, and the sport page to return to. Signed like pin-login.ts's
 * tickets: HMAC with the session secret under its own prefix, so a session
 * cookie or a login ticket can never pass as a state, nor the reverse.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { ServerResponse } from "node:http";
import { sessionSecret } from "../auth/session.js";

export const STATE_COOKIE = "sportsarc_gemini_oauth";
const TTL_MS = 10 * 60_000;
const PREFIX = "gemini-state.";

export interface OAuthState {
  /** The user who started connecting. */
  u: string;
  /** Sent to Gemini as `state` and checked when it comes back. */
  n: string;
  /** PKCE code verifier. */
  v: string;
  /** Sport page to return to. */
  s: string;
  /** Expiry, ms since epoch. */
  exp: number;
}

const mac = (body: string, secret: string): Buffer =>
  createHmac("sha256", secret).update(`${PREFIX}${body}`).digest();

export function newState(userId: string, sport: string, now = Date.now()): OAuthState {
  return {
    u: userId,
    n: randomBytes(16).toString("base64url"),
    v: randomBytes(48).toString("base64url"),
    s: sport,
    exp: now + TTL_MS,
  };
}

export function signState(state: OAuthState, secret = sessionSecret()): string {
  const body = Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
  return `${body}.${mac(body, secret).toString("base64url")}`;
}

/** The state, if the cookie is ours, unexpired and made for `userId`. */
export function openState(raw: unknown, userId: string, secret = sessionSecret(), now = Date.now()): OAuthState | null {
  if (typeof raw !== "string") return null;
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = raw.slice(0, dot);
  const expected = mac(body, secret);
  const given = Buffer.from(raw.slice(dot + 1), "base64url");
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const s = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as OAuthState;
    if (typeof s.u !== "string" || typeof s.n !== "string" || typeof s.v !== "string"
      || typeof s.s !== "string" || typeof s.exp !== "number") return null;
    if (s.exp < now || s.u !== userId) return null;
    return s;
  } catch {
    return null;
  }
}

const flags = (maxAge: number): string => {
  const secure = process.env.COOKIE_SECURE === "1" ? "; Secure" : "";
  return `Path=/api/markets; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
};

export function setStateCookie(res: ServerResponse, state: OAuthState): void {
  res.setHeader("Set-Cookie", `${STATE_COOKIE}=${encodeURIComponent(signState(state))}; ${flags(TTL_MS / 1000)}`);
}

export function clearStateCookie(res: ServerResponse): void {
  res.setHeader("Set-Cookie", `${STATE_COOKIE}=; ${flags(0)}`);
}
