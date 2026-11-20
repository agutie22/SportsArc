/**
 * Settings for Pro markets (Gemini prediction markets on the sport pages).
 *
 * Two separate choices:
 *
 *   data     where market data (events, prices) comes from. Public, read
 *            only, no account. Defaults to production: Gemini's sandbox
 *            lists no sports markets at all (checked 2026-11-16).
 *   trading  what happens when a user buys:
 *              practice  fills at the live Gemini price into a practice
 *                        account kept in our database. No Gemini account,
 *                        no money. The default outside production.
 *              oauth     the user's own Gemini account, connected by OAuth.
 *              demo-key  one shared sandbox API key for everyone. Testing
 *                        only; refused in production.
 *              off       no Pro markets at all.
 *
 * When trading is real (oauth, demo-key), data must come from the same
 * Gemini environment as the orders, or the symbols would not exist there.
 *
 * Pure: everything reads from the `env` argument so tests pass their own.
 */

type Env = Record<string, string | undefined>;

export type GeminiEnv = "sandbox" | "production";
export type TradingMode = "practice" | "oauth" | "demo-key" | "off";

export interface MarketsConfig {
  enabled: boolean;
  trading: TradingMode;
  /** The Gemini environment real orders go to (oauth, demo-key). */
  env: GeminiEnv;
  /** The Gemini environment market data is read from. */
  dataEnv: GeminiEnv;
  dataBase: string;
  restBase: string;
  authBase: string;
  clientId: string | null;
  clientSecret: string | null;
  redirectUri: string | null;
  scopes: string;
  tokenKey: Buffer | null;
  demoKey: string | null;
  demoSecret: string | null;
  /** Dollars a practice account starts with. */
  practiceStart: number;
  /** Why trading is off, when a mode was asked for but could not be used. */
  problem: string | null;
}

const REST: Record<GeminiEnv, string> = {
  sandbox: "https://api.sandbox.gemini.com",
  production: "https://api.gemini.com",
};

const AUTH: Record<GeminiEnv, string> = {
  sandbox: "https://exchange.sandbox.gemini.com",
  production: "https://exchange.gemini.com",
};

/** The site a user opens to add money or see their account. */
export const SITE: Record<GeminiEnv, string> = AUTH;

export const SCOPES = ["orders:read", "orders:create", "balances:read", "account:read"].join(",");

const trimmed = (v: string | undefined): string | null => (v && v.trim() ? v.trim() : null);

const geminiEnv = (v: string | undefined, fallback: GeminiEnv): GeminiEnv =>
  v === "production" ? "production" : v === "sandbox" ? "sandbox" : fallback;

/** A 32-byte AES key from base64, or null. */
export function parseTokenKey(v: string | undefined): Buffer | null {
  const raw = trimmed(v);
  if (!raw) return null;
  const key = Buffer.from(raw, "base64");
  return key.length === 32 ? key : null;
}

export function marketsConfig(env: Env = process.env): MarketsConfig {
  const production = env.NODE_ENV === "production";
  const tradingEnv = geminiEnv(env.GEMINI_ENV, "sandbox");
  const asked = trimmed(env.GEMINI_TRADING);
  let trading: TradingMode =
    asked === "practice" || asked === "oauth" || asked === "demo-key" || asked === "off"
      ? asked
      : production ? "off" : "practice";
  let problem: string | null = null;

  const clientId = trimmed(env.GEMINI_CLIENT_ID);
  const clientSecret = trimmed(env.GEMINI_CLIENT_SECRET);
  const redirectUri = trimmed(env.GEMINI_REDIRECT_URI);
  const tokenKey = parseTokenKey(env.GEMINI_TOKEN_KEY);
  const demoKey = trimmed(env.GEMINI_DEMO_KEY);
  const demoSecret = trimmed(env.GEMINI_DEMO_SECRET);

  if (trading === "oauth" && !(clientId && clientSecret && redirectUri && tokenKey)) {
    problem = trimmed(env.GEMINI_TOKEN_KEY) && !tokenKey
      ? "GEMINI_TOKEN_KEY must be base64 for exactly 32 bytes."
      : "GEMINI_TRADING=oauth needs GEMINI_CLIENT_ID, GEMINI_CLIENT_SECRET, GEMINI_REDIRECT_URI and GEMINI_TOKEN_KEY.";
    trading = "off";
  }
  if (trading === "demo-key") {
    if (production || tradingEnv === "production") {
      problem = "GEMINI_TRADING=demo-key is for the sandbox only and is refused in production.";
      trading = "off";
    } else if (!(demoKey && demoSecret)) {
      problem = "GEMINI_TRADING=demo-key needs GEMINI_DEMO_KEY and GEMINI_DEMO_SECRET.";
      trading = "off";
    }
  }

  const real = trading === "oauth" || trading === "demo-key";
  const dataEnv = real ? tradingEnv : geminiEnv(env.GEMINI_DATA_ENV, "production");
  const start = Number(env.GEMINI_PRACTICE_START);

  return {
    enabled: trading !== "off",
    trading,
    env: tradingEnv,
    dataEnv,
    dataBase: REST[dataEnv],
    restBase: REST[tradingEnv],
    authBase: trimmed(env.GEMINI_AUTH_URL)?.replace(/\/+$/, "") ?? AUTH[tradingEnv],
    clientId,
    clientSecret,
    redirectUri,
    scopes: SCOPES,
    tokenKey,
    demoKey,
    demoSecret,
    practiceStart: Number.isFinite(start) && start > 0 ? Math.floor(start) : 1000,
    problem,
  };
}

let cached: MarketsConfig | null = null;
let warned = false;

/** The process's config, read once. Logs once when a requested mode was refused. */
export function config(): MarketsConfig {
  if (!cached) {
    cached = marketsConfig();
    if (cached.problem && !warned) {
      warned = true;
      console.warn(`[markets] Pro markets are off: ${cached.problem}`);
    }
  }
  return cached;
}
