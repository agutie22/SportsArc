/**
 * Recoverable SportsArc account (OTP or username + PIN, httpOnly session
 * cookie). The PIN sign-in itself runs through Circle in circle-sdk.js.
 * Requests go through api.js, so a refusal is an Error carrying the API's
 * result code (e.g. INVITE_REQUIRED) as `err.code`.
 */

import { api, apiGet, apiSend } from "./api.js";

/** The signed-in user, or null when signed out or the API is unreachable. */
export async function fetchMe() {
  try {
    return (await apiGet("/api/auth/me")).user ?? null;
  } catch {
    return null;
  }
}

export function startOtp({ email, phone }) {
  return apiSend("/api/auth/otp/start", "POST", email ? { email } : { phone });
}

export async function verifyOtp({ email, phone, code }) {
  const body = await apiSend("/api/auth/otp/verify", "POST", email ? { email, code } : { phone, code });
  return withUser(body, "Could not verify code.");
}

/** New account with just a username; the session cookie is set on success. */
export async function signupWithUsername({ username, audience }) {
  const body = await apiSend("/api/auth/username/signup", "POST", { username, audience });
  return withUser(body, "Could not create account.");
}

const LAST_USERNAME_KEY = "sportsarc_last_username";

/** The username last used on this device, to pre-fill sign-in. */
export function lastUsername() {
  try {
    return localStorage.getItem(LAST_USERNAME_KEY) ?? "";
  } catch {
    return "";
  }
}

export function rememberUsername(username) {
  try {
    localStorage.setItem(LAST_USERNAME_KEY, username);
  } catch {
    /* a convenience only */
  }
}

export async function updateProfile({ name, role, audience }) {
  const body = await apiSend("/api/auth/profile", "PATCH", { name, role, audience });
  return withUser(body, "Could not save profile.");
}

export async function logout() {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch {
    /* cookie clear is best-effort */
  }
}

export function identPayload(channel, value) {
  return channel === "phone" ? { phone: value } : { email: value };
}

function withUser(body, message) {
  if (!body.user) throw new Error(message);
  return body.user;
}
