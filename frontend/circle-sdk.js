/**
 * Circle W3S: wallet setup, and signing in with the wallet PIN.
 *
 * Call init(config) first (shared.ensureCircleSdk() does, with the public
 * config). setupWallet() requires an existing SportsArc session cookie.
 * signInWithPin() does not: Circle asks for the PIN to sign a one-time
 * login message, and the server checks that signature against the wallet.
 */

import { apiGet, apiSend } from "./api.js";

const W3S_SDK_MODULE_URL = "/vendor/w3s-pw-web-sdk.bundle.mjs";

let _sdk = null;

/** Load the SDK once and point it at the app id in `config` (GET /api/config). */
export async function init(config) {
  if (!config?.circleAppId) {
    throw new Error("CIRCLE_APP_ID is not configured. Set it in .env.");
  }

  if (!_sdk) {
    const mod = await import(/* @vite-ignore */ W3S_SDK_MODULE_URL);
    const pack = mod.default ?? mod;
    const W3SSdk =
      typeof pack?.W3SSdk === "function" ? pack.W3SSdk
      : typeof mod.W3SSdk === "function" ? mod.W3SSdk
      : null;
    if (!W3SSdk) {
      throw new Error("W3SSdk not found — run `pnpm run build:w3s`.");
    }
    _sdk = new W3SSdk();
  }

  _sdk.setAppSettings({ appId: config.circleAppId });
}

export function setSdkAuthentication({ userToken, encryptionKey }) {
  if (!_sdk) throw new Error("Circle SDK not initialized.");
  _sdk.setAuthentication({ userToken, encryptionKey });
}

export function executeChallenge(challengeId, label) {
  return new Promise((resolve, reject) => {
    _sdk.execute(challengeId, (error, result) => {
      if (error) {
        reject(new Error(`[${label}] ${error.message ?? String(error)}`));
      } else {
        resolve(result);
      }
    });
  });
}

export async function setupWallet() {
  const body = await apiSend("/api/auth/init", "POST", {});

  if (!body.challengeId) {
    return { userId: body.userId, walletAddress: body.walletAddress };
  }

  setSdkAuthentication({ userToken: body.userToken, encryptionKey: body.encryptionKey });
  await executeChallenge(body.challengeId, "pin+wallet");

  for (let attempt = 1; attempt <= 8; attempt++) {
    // A failed poll is not fatal; the next one, or /complete, decides.
    const p = await apiGet("/api/auth/challenge", { id: body.challengeId }).catch(() => null);
    if (p?.status === "COMPLETE") break;
    if (p?.status === "FAILED" || p?.status === "EXPIRED") {
      throw new Error(`Challenge ${p.status}`);
    }
    if (attempt < 8) await new Promise((r) => setTimeout(r, 1500));
  }

  const done = await apiSend("/api/auth/complete", "POST", { challengeId: body.challengeId });
  return { userId: done.userId, walletAddress: done.walletAddress };
}

/** Never throws: `{ ok: true, balance, … }` or `{ ok: false, error: { message } }`. */
export async function fetchWalletUsdcBalance(walletAddress) {
  if (!walletAddress) {
    return { ok: false, error: { message: "No wallet address." } };
  }
  try {
    const body = await apiGet("/api/wallet/usdc-balance", { address: walletAddress });
    return { ok: true, balance: body.balance, chain: body.chain, usdcAddress: body.usdcAddress };
  } catch (err) {
    return { ok: false, error: { message: err.message } };
  }
}

/** Username + PIN sign-in. Resolves to the account user; the session cookie is set. */
export async function signInWithPin(username) {
  const body = await apiSend("/api/auth/pin/start", "POST", { username });

  setSdkAuthentication({ userToken: body.userToken, encryptionKey: body.encryptionKey });
  const result = await executeChallenge(body.challengeId, "sign-in");
  const signature = result?.data?.signature ?? result?.signature;
  if (!signature) throw new Error("Circle did not return a signature.");

  const done = await apiSend("/api/auth/pin/finish", "POST", { ticket: body.ticket, signature });
  if (!done.user) throw new Error("Sign-in failed.");
  return done.user;
}
