/**
 * The Gemini REST client for Pro markets.
 *
 *   publicGet    market data: events, prices, terms. No account.
 *   privatePost  a call on behalf of an account: orders, positions,
 *                balances, terms acceptance. Signed one of two ways:
 *                  bearer  an OAuth access token (a user's own account)
 *                  hmac    an API key and secret (the shared demo key)
 *
 * Gemini's private calls carry their parameters base64-encoded in the
 * X-GEMINI-PAYLOAD header, not in the body. Its prediction-market pages also
 * show a JSON body; GEMINI_PM_BODY=json sends both, for whichever the live
 * API turns out to read.
 *
 * Every call returns a result and never throws. `fetch` is injectable so the
 * tests run against recorded answers.
 */

import { createHmac } from "node:crypto";
import { config, type MarketsConfig } from "./config.js";

export type FetchFn = (url: string, init?: {
  method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal;
}) => Promise<{ status: number; text(): Promise<string> }>;

export type GeminiAuth =
  | { kind: "bearer"; token: string }
  | { kind: "hmac"; key: string; secret: string };

export interface GeminiFailure {
  ok: false;
  /** Gemini refused the request (4xx): nothing happened, a new attempt is safe. */
  rejected: boolean;
  error: { code: string; message: string; detail?: string };
}

export type GeminiResult<T> = { ok: true; data: T } | GeminiFailure;

const TIMEOUT_MS = 15_000;

/** Gemini's reason or code → ours. Anything unlisted is GEMINI_REJECTED. */
const REASONS: Record<string, string> = {
  TERMS_NOT_ACCEPTED: "TERMS_NOT_ACCEPTED",
  InsufficientFunds: "INSUFFICIENT_FUNDS",
  INSUFFICIENT_FUNDS: "INSUFFICIENT_FUNDS",
  ACCOUNT_GROUP_BLOCKED: "MARKETS_NOT_AVAILABLE_FOR_ACCOUNT",
  ACCOUNT_RESTRICTED_SELL_ONLY: "ACCOUNT_SELL_ONLY",
  InvalidPrice: "INVALID_ORDER",
  InvalidQuantity: "INVALID_ORDER",
  InvalidSymbol: "MARKET_NOT_FOUND",
  InvalidSignature: "GEMINI_AUTH_FAILED",
  InvalidApiKey: "GEMINI_AUTH_FAILED",
  InvalidNonce: "GEMINI_AUTH_FAILED",
  MissingRole: "GEMINI_SCOPE_MISSING",
  RateLimit: "GEMINI_UNAVAILABLE",
  RateLimited: "GEMINI_UNAVAILABLE",
};

/** What a user may read for each of our codes. Gemini's own text stays in `detail`. */
const MESSAGES: Record<string, string> = {
  TERMS_NOT_ACCEPTED: "Accept Gemini's prediction market terms first.",
  INSUFFICIENT_FUNDS: "Not enough money in your Gemini account for that.",
  MARKETS_NOT_AVAILABLE_FOR_ACCOUNT: "Gemini Predictions is available to US accounts only.",
  ACCOUNT_SELL_ONLY: "Your Gemini account can only sell positions right now.",
  INVALID_ORDER: "Gemini would not take that order. Try another amount.",
  MARKET_NOT_FOUND: "That market is not available.",
  GEMINI_AUTH_FAILED: "Gemini did not accept the connection. Connect your account again.",
  GEMINI_SCOPE_MISSING: "Your Gemini connection is missing a permission. Connect again.",
  GEMINI_REJECTED: "Gemini would not do that right now.",
  GEMINI_UNAVAILABLE: "Gemini is not answering. Try again in a moment.",
  GEMINI_BAD_RESPONSE: "Gemini sent an answer we could not read.",
};

export function failure(code: string, detail = "", rejected = false): GeminiFailure {
  return {
    ok: false,
    rejected,
    error: { code, message: MESSAGES[code] ?? "Something went wrong with Gemini.", detail: detail.slice(0, 300) },
  };
}

/** Our code for a 4xx answer from Gemini. */
export function mapRejection(status: number, json: unknown): string {
  const j = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
  for (const k of ["reason", "code", "error"]) {
    const v = j[k];
    if (typeof v === "string" && REASONS[v]) return REASONS[v];
  }
  if (status === 401) return "GEMINI_AUTH_FAILED";
  if (status === 404) return "MARKET_NOT_FOUND";
  if (status === 429) return "GEMINI_UNAVAILABLE";
  return "GEMINI_REJECTED";
}

let lastNonce = 0;

/** Strictly increasing, so two calls in the same millisecond never collide. */
export function nextNonce(now = Date.now()): number {
  lastNonce = Math.max(lastNonce + 1, now);
  return lastNonce;
}

/** The base64 payload and the headers for one private call. */
export function signedRequest(
  auth: GeminiAuth,
  path: string,
  params: Record<string, unknown>,
  jsonBody: boolean,
  nonce = nextNonce(),
): { headers: Record<string, string>; body?: string } {
  const payload: Record<string, unknown> = { request: path, ...params };
  if (auth.kind === "hmac") payload.nonce = nonce;
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  const headers: Record<string, string> = {
    accept: "application/json",
    "x-gemini-payload": encoded,
    "cache-control": "no-cache",
  };
  if (auth.kind === "bearer") {
    headers.authorization = `Bearer ${auth.token}`;
  } else {
    headers["x-gemini-apikey"] = auth.key;
    headers["x-gemini-signature"] = createHmac("sha384", auth.secret).update(encoded).digest("hex");
  }
  if (jsonBody) {
    headers["content-type"] = "application/json";
    return { headers, body: JSON.stringify(params) };
  }
  headers["content-type"] = "text/plain";
  headers["content-length"] = "0";
  return { headers };
}

export interface GeminiClient {
  publicGet<T = unknown>(path: string, query?: Record<string, string | number | undefined>): Promise<GeminiResult<T>>;
  privatePost<T = unknown>(auth: GeminiAuth, path: string, params?: Record<string, unknown>,
    query?: Record<string, string | number | undefined>): Promise<GeminiResult<T>>;
}

const queryString = (q?: Record<string, string | number | undefined>): string => {
  if (!q) return "";
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== "") s.set(k, String(v));
  const out = s.toString();
  return out ? `?${out}` : "";
};

export function geminiClient(
  fetchFn: FetchFn = fetch as unknown as FetchFn,
  cfg: Pick<MarketsConfig, "dataBase" | "restBase"> = config(),
  env: Record<string, string | undefined> = process.env,
): GeminiClient {
  const jsonBody = env.GEMINI_PM_BODY === "json";

  const call = async <T>(url: string, init: Parameters<FetchFn>[1]): Promise<GeminiResult<T>> => {
    let status: number;
    let text: string;
    try {
      const res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
      status = res.status;
      text = await res.text();
    } catch (err) {
      return failure("GEMINI_UNAVAILABLE", err instanceof Error ? err.message : String(err));
    }
    if (status >= 500) return failure("GEMINI_UNAVAILABLE", `Gemini answered ${status}.`);
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      return failure("GEMINI_BAD_RESPONSE", `Gemini answered ${status} with invalid JSON.`, status >= 400);
    }
    if (status >= 400) {
      const j = (json ?? {}) as Record<string, unknown>;
      const detail = String(j.message ?? j.reason ?? j.error ?? `HTTP ${status}`);
      return failure(mapRejection(status, json), detail, true);
    }
    return { ok: true, data: json as T };
  };

  return {
    publicGet: (path, query) =>
      call(`${cfg.dataBase}${path}${queryString(query)}`, { method: "GET", headers: { accept: "application/json" } }),
    privatePost: (auth, path, params = {}, query) => {
      const signed = signedRequest(auth, path, params, jsonBody && path.startsWith("/v1/prediction-markets/"));
      return call(`${cfg.restBase}${path}${queryString(query)}`, { method: "POST", ...signed });
    },
  };
}

let shared: GeminiClient | null = null;

/** The process's client. */
export function gemini(): GeminiClient {
  shared ??= geminiClient();
  return shared;
}
