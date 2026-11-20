/**
 * Sign-in (OTP, or username + Circle PIN), the session, the account
 * profile, and Circle wallet setup.
 */

import type { ServerResponse } from "node:http";
import { UniqueConstraintViolationException } from "@mikro-orm/core";
import { completeWalletSetup, getChallengeStatus, initWalletSetup } from "../circle/auth-handler.js";
import { em } from "../db.js";
import { authed, errorJson, json, parseJsonBody } from "../http.js";
import { startOtp, verifyOtp } from "../auth/otp.js";
import { finishPinLogin, signupWithUsername, startPinLogin } from "../auth/pin-login.js";
import { get, patch, post } from "../router.js";
import { clearSessionCookie, sessionSecretConfigured, setSessionCookie } from "../auth/session.js";
import { applyProfile, identityTaken, toPublicUser } from "../social/users.js";
import { authStatus } from "./status.js";

function requireSessionSecret(res: ServerResponse): boolean {
  if (sessionSecretConfigured()) return true;
  errorJson(res, 503, "SESSION_NOT_CONFIGURED", "SESSION_SECRET is not configured.");
  return false;
}

post("/api/auth/otp/start", async ({ req, res }) => {
  if (!requireSessionSecret(res)) return;
  const body = await parseJsonBody<{ email?: string; phone?: string }>(req, res);
  if (body === null) return;
  const result = await startOtp(em(), body);
  json(res, authStatus(result), result);
});

post("/api/auth/otp/verify", async ({ req, res }) => {
  if (!requireSessionSecret(res)) return;
  const body = await parseJsonBody<{ email?: string; phone?: string; code?: string }>(req, res);
  if (body === null) return;
  const result = await verifyOtp(em(), body);
  if (result.ok) {
    try {
      setSessionCookie(res, { userId: result.user.id });
    } catch (err) {
      errorJson(res, 503, "SESSION_NOT_CONFIGURED", err instanceof Error ? err.message : "Could not issue session.");
      return;
    }
  }
  json(res, authStatus(result), result);
});

/** Set the session cookie; false (and a 503 sent) if it cannot be issued. */
function issueSession(res: ServerResponse, userId: string): boolean {
  try {
    setSessionCookie(res, { userId });
    return true;
  } catch (err) {
    errorJson(res, 503, "SESSION_NOT_CONFIGURED", err instanceof Error ? err.message : "Could not issue session.");
    return false;
  }
}

// Username + PIN: sign up creates the user and a session, then the browser
// runs the PIN + wallet challenge through /api/auth/init as usual.
post("/api/auth/username/signup", async ({ req, res }) => {
  if (!requireSessionSecret(res)) return;
  const body = await parseJsonBody<{ username?: string; audience?: string }>(req, res);
  if (body === null) return;
  const result = await signupWithUsername(em(), body);
  if (!result.ok) { json(res, authStatus(result), result); return; }
  if (!issueSession(res, result.user.id)) return;
  json(res, 200, { ok: true, user: await toPublicUser(em(), result.user) });
});

post("/api/auth/pin/start", async ({ req, res }) => {
  if (!requireSessionSecret(res)) return;
  const body = await parseJsonBody<{ username?: string }>(req, res);
  if (body === null) return;
  const result = await startPinLogin(em(), body);
  json(res, authStatus(result), result);
});

post("/api/auth/pin/finish", async ({ req, res }) => {
  if (!requireSessionSecret(res)) return;
  const body = await parseJsonBody<{ ticket?: string; signature?: string }>(req, res);
  if (body === null) return;
  const result = await finishPinLogin(em(), body);
  if (!result.ok) { json(res, authStatus(result), result); return; }
  if (!issueSession(res, result.user.id)) return;
  json(res, 200, { ok: true, user: await toPublicUser(em(), result.user) });
});

get("/api/auth/me", authed(async ({ res }, { user, fork }) => {
  json(res, 200, { ok: true, user: await toPublicUser(fork, user) });
}));

patch("/api/auth/profile", authed(async ({ req, res }, { user, fork }) => {
  const body = await parseJsonBody<{ name?: string; role?: string; audience?: string }>(req, res);
  if (body === null) return;
  const applied = applyProfile(user, body);
  if (!applied.ok) {
    errorJson(res, 400, "VALIDATION_ERROR", applied.message);
    return;
  }
  if (user.name && await identityTaken(fork, user.name, user.id)) {
    errorJson(res, 409, "NAME_TAKEN", "That name is taken.");
    return;
  }
  try {
    await fork.flush();
  } catch (err) {
    if (err instanceof UniqueConstraintViolationException) {
      errorJson(res, 409, "NAME_TAKEN", "That name is taken.");
      return;
    }
    throw err;
  }
  json(res, 200, { ok: true, user: await toPublicUser(fork, user) });
}));

post("/api/auth/logout", ({ res }) => {
  clearSessionCookie(res);
  json(res, 200, { ok: true });
});

post("/api/auth/init", authed(async ({ req, res }, { user }) => {
  await parseJsonBody(req, res);
  const result = await initWalletSetup(em(), user.id);
  json(res, authStatus(result), result);
}));

post("/api/auth/complete", authed(async ({ req, res }, { user }) => {
  const body = await parseJsonBody<{ challengeId?: string }>(req, res);
  if (body === null) return;
  const result = await completeWalletSetup(em(), user.id, body.challengeId ?? "");
  json(res, authStatus(result), result);
}));

get("/api/auth/challenge", authed(async ({ res, query }, { user }) => {
  const result = await getChallengeStatus(em(), user.id, query.get("id") ?? "");
  json(res, authStatus(result), result);
}));
