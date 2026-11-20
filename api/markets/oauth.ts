/**
 * Connecting a user's own Gemini account (GEMINI_TRADING=oauth), and the
 * account every trading call runs as.
 *
 *   authorizeUrl   where /api/markets/connect sends the user
 *   exchangeCode   the callback swaps Gemini's code for tokens
 *   accountFor     the auth for one user's next Gemini call, refreshing
 *                  the access token first when it is about to expire
 *   disconnect     revoke at Gemini (best effort) and forget the link
 *
 * Gemini's access tokens last 24 hours; its refresh tokens never expire but
 * work once. accountFor refreshes under a row lock and saves both new tokens
 * before the lock is released, so two requests racing never spend the same
 * refresh token. If Gemini refuses the refresh (revoked, or spent by
 * something else), the link is removed and the user is asked to connect
 * again.
 *
 * In demo-key mode every user trades as the one shared sandbox key, and
 * there is nothing to connect.
 */

import { createHash } from "node:crypto";
import { LockMode } from "@mikro-orm/core";
import type { EntityManager } from "@mikro-orm/postgresql";
import type { User } from "../entities/User.js";
import { fail, type Failure } from "../failure.js";
import { config, type MarketsConfig } from "./config.js";
import type { FetchFn, GeminiAuth } from "./gemini.js";
import { GeminiLink } from "./GeminiLink.js";
import { open, seal } from "./seal.js";

const TIMEOUT_MS = 15_000;
/** Refresh when the access token has less than this left. */
export const REFRESH_EARLY_MS = 5 * 60_000;

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  scopes: string;
}

export interface Account {
  auth: GeminiAuth;
  /** What the account card calls it. */
  label: string;
  /** The shared demo key: everyone sees the same balance. */
  shared: boolean;
  link: GeminiLink | null;
}

type Cfg = Pick<MarketsConfig, "authBase" | "clientId" | "clientSecret" | "redirectUri" | "scopes">;

export const pkceChallenge = (verifier: string): string =>
  createHash("sha256").update(verifier).digest("base64url");

export function authorizeUrl(state: string, verifier: string, cfg: Cfg = config()): string {
  const q = new URLSearchParams({
    client_id: cfg.clientId ?? "",
    response_type: "code",
    redirect_uri: cfg.redirectUri ?? "",
    state,
    scope: cfg.scopes,
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: "S256",
  });
  return `${cfg.authBase}/auth?${q}`;
}

/** Gemini's token answer → Tokens, or why not. */
export function parseTokens(json: unknown, now = Date.now()): Tokens | null {
  const j = (json ?? {}) as Record<string, unknown>;
  if (typeof j.access_token !== "string" || typeof j.refresh_token !== "string") return null;
  const secs = Number(j.expires_in);
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token,
    expiresAt: new Date(now + (Number.isFinite(secs) && secs > 0 ? secs : 86_399) * 1000),
    scopes: typeof j.scope === "string" ? j.scope : "",
  };
}

export interface OAuthClient {
  token(params: Record<string, string>): Promise<{ ok: true; tokens: Tokens } | { ok: false; invalidGrant: boolean; code: string; detail: string }>;
  revoke(token: string): Promise<void>;
}

export function oauthClient(
  fetchFn: FetchFn = fetch as unknown as FetchFn,
  cfg: Cfg = config(),
  env: Record<string, string | undefined> = process.env,
  now: () => number = Date.now,
): OAuthClient {
  const json = env.GEMINI_TOKEN_BODY === "json";
  const post = async (path: string, params: Record<string, string>) => {
    const all = { ...params, client_id: cfg.clientId ?? "", client_secret: cfg.clientSecret ?? "" };
    const res = await fetchFn(`${cfg.authBase}${path}`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": json ? "application/json" : "application/x-www-form-urlencoded",
      },
      body: json ? JSON.stringify(all) : new URLSearchParams(all).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return { status: res.status, text: await res.text() };
  };

  return {
    async token(params) {
      let status: number;
      let text: string;
      try {
        ({ status, text } = await post("/auth/token", params));
      } catch (err) {
        return { ok: false, invalidGrant: false, code: "GEMINI_UNAVAILABLE", detail: err instanceof Error ? err.message : String(err) };
      }
      let body: Record<string, unknown> = {};
      try { body = text ? JSON.parse(text) : {}; } catch { /* handled below */ }
      if (status >= 200 && status < 300) {
        const tokens = parseTokens(body, now());
        if (tokens) return { ok: true, tokens };
        return { ok: false, invalidGrant: false, code: "GEMINI_BAD_RESPONSE", detail: "No tokens in Gemini's answer." };
      }
      const err = String(body.error ?? body.reason ?? `HTTP ${status}`);
      if (status >= 500) return { ok: false, invalidGrant: false, code: "GEMINI_UNAVAILABLE", detail: err };
      return { ok: false, invalidGrant: err === "invalid_grant" || status === 400 || status === 401, code: "GEMINI_AUTH_FAILED", detail: err };
    },
    async revoke(token) {
      try {
        await post("/auth/token/revoke", { token });
      } catch {
        // Best effort: the link is deleted on our side either way.
      }
    },
  };
}

let sharedClient: OAuthClient | null = null;
const oauth = (): OAuthClient => (sharedClient ??= oauthClient());

export function exchangeCode(code: string, verifier: string, client: OAuthClient = oauth(), cfg: Cfg = config()) {
  return client.token({
    grant_type: "authorization_code",
    code,
    redirect_uri: cfg.redirectUri ?? "",
    code_verifier: verifier,
  });
}

export const needsRefresh = (link: Pick<GeminiLink, "accessExpiresAt">, now = Date.now()): boolean =>
  link.accessExpiresAt.getTime() - now < REFRESH_EARLY_MS;

/** Write fresh tokens into a link, sealed. */
export function storeTokens(link: GeminiLink, tokens: Tokens, key: Buffer, env: string): void {
  link.accessToken = seal(tokens.accessToken, key);
  link.refreshToken = seal(tokens.refreshToken, key);
  link.accessExpiresAt = tokens.expiresAt;
  link.scopes = tokens.scopes || link.scopes || "";
  link.env = env;
}

/**
 * The access token for a locked link, refreshing it first when needed.
 * "gone" means Gemini will not refresh it: the caller deletes the link.
 */
export async function liveToken(
  link: GeminiLink,
  key: Buffer,
  client: OAuthClient,
  env: string,
  now = Date.now(),
): Promise<{ ok: true; token: string; refreshed: boolean } | { ok: false; gone: boolean; code: string }> {
  if (!needsRefresh(link, now)) {
    const token = open(link.accessToken, key);
    if (token) return { ok: true, token, refreshed: false };
  }
  const refresh = open(link.refreshToken, key);
  if (!refresh) return { ok: false, gone: true, code: "GEMINI_NOT_CONNECTED" };
  const res = await client.token({ grant_type: "refresh_token", refresh_token: refresh });
  if (!res.ok) return { ok: false, gone: res.invalidGrant, code: res.invalidGrant ? "GEMINI_NOT_CONNECTED" : res.code };
  storeTokens(link, res.tokens, key, env);
  return { ok: true, token: res.tokens.accessToken, refreshed: true };
}

const NOT_CONNECTED = (): Failure => fail("GEMINI_NOT_CONNECTED", "Connect your Gemini account first.");

/** The Gemini account `user` trades as right now. */
export async function accountFor(
  em: EntityManager,
  user: User,
  cfg: MarketsConfig = config(),
  client: OAuthClient = oauth(),
): Promise<({ ok: true } & Account) | Failure> {
  if (cfg.trading === "demo-key") {
    return {
      ok: true,
      auth: { kind: "hmac", key: cfg.demoKey!, secret: cfg.demoSecret! },
      label: "Shared demo account",
      shared: true,
      link: null,
    };
  }
  if (cfg.trading !== "oauth" || !cfg.tokenKey) return NOT_CONNECTED();
  const key = cfg.tokenKey;

  return em.transactional(async (tx) => {
    const link = await tx.findOne(GeminiLink, { user: user.id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    if (!link) return NOT_CONNECTED();
    if (link.env !== cfg.env) {
      // Tokens from the other Gemini environment are no use here.
      tx.remove(link);
      return NOT_CONNECTED();
    }
    const live = await liveToken(link, key, client, cfg.env);
    if (!live.ok) {
      if (live.gone) tx.remove(link);
      return live.gone ? NOT_CONNECTED() : fail(live.code, "Gemini is not answering. Try again in a moment.");
    }
    return { ok: true as const, auth: { kind: "bearer" as const, token: live.token }, label: "Your Gemini account", shared: false, link };
  });
}

/** Save the tokens from a finished connect, replacing any earlier link. */
export async function saveLink(em: EntityManager, user: User, tokens: Tokens, cfg: MarketsConfig = config()): Promise<void> {
  const key = cfg.tokenKey;
  if (!key) throw new Error("GEMINI_TOKEN_KEY is not set");
  let link = await em.findOne(GeminiLink, { user: user.id });
  if (!link) {
    link = new GeminiLink();
    link.user = user;
  }
  storeTokens(link, tokens, key, cfg.env);
  link.termsVersion = null;
  await em.persistAndFlush(link);
}

export async function disconnect(em: EntityManager, user: User, cfg: MarketsConfig = config(), client: OAuthClient = oauth()): Promise<void> {
  const link = await em.findOne(GeminiLink, { user: user.id });
  if (!link) return;
  const token = cfg.tokenKey ? open(link.refreshToken, cfg.tokenKey) : null;
  if (token) await client.revoke(token);
  await em.removeAndFlush(link);
}
