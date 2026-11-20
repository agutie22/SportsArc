/**
 * Phone/email OTP. Codes are hashed at rest and delivered by mailer.ts
 * (printed to the API log in development; phone has no sender yet).
 *
 * Rate limits live in Postgres (rate_limit_hits), so they hold across every
 * API instance and survive restarts.
 */

import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import type { EntityManager } from "@mikro-orm/postgresql";
import { OtpChallenge } from "../entities/OtpChallenge.js";
import { RateLimitHit } from "../entities/RateLimitHit.js";
import { advisoryKey } from "../ops/jobs.js";
import { User } from "../entities/User.js";
import { UserIdentifier, type IdentifierKind } from "../entities/UserIdentifier.js";
import { sessionSecret } from "./session.js";
import { toPublicUser, type PublicUser } from "../social/users.js";
import { sendLoginCode, sendLoginCodeSms } from "./mailer.js";
import { claimInvite, signupGate } from "./invites.js";

const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const START_MAX = 5;
const START_WINDOW_MS = 15 * 60 * 1000;
const VERIFY_MAX = 8;
const VERIFY_WINDOW_MS = 15 * 60 * 1000;

export interface Identifier {
  kind: IdentifierKind;
  value: string;
}

export interface OtpError {
  ok: false;
  error: { code: string; message: string };
}

export interface OtpStartSuccess {
  ok: true;
}

export interface OtpVerifySuccess {
  ok: true;
  user: PublicUser;
}

/**
 * Sliding-window limit: true when `key` already has `max` hits in the last
 * `windowMs`; otherwise records this hit. A refused attempt is not counted.
 * Check and insert run under a transaction-scoped advisory lock on
 * (bucket, key), so concurrent attempts on any instance count one at a time.
 */
async function rateLimited(
  em: EntityManager,
  bucket: "otp_start" | "otp_verify",
  key: string,
  max: number,
  windowMs: number,
): Promise<boolean> {
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

export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  const trimmed = raw.trim();
  if (/^\+[1-9]\d{7,14}$/.test(trimmed)) return trimmed;
  if (digits.length >= 8 && digits.length <= 15) {
    return trimmed.startsWith("+") ? trimmed : `+${digits}`;
  }
  return null;
}

export function normalizeEmail(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) || value.length > 254) return null;
  return value;
}

export function parseIdentifier(body: { email?: unknown; phone?: unknown }): Identifier | OtpError {
  const emailRaw = typeof body.email === "string" ? body.email : "";
  const phoneRaw = typeof body.phone === "string" ? body.phone : "";
  const hasEmail = Boolean(emailRaw.trim());
  const hasPhone = Boolean(phoneRaw.trim());
  if (hasEmail === hasPhone) {
    return {
      ok: false,
      error: { code: "VALIDATION_ERROR", message: "Provide either email or phone." },
    };
  }
  if (hasEmail) {
    const value = normalizeEmail(emailRaw);
    if (!value) {
      return { ok: false, error: { code: "VALIDATION_ERROR", message: "Enter a valid email address." } };
    }
    return { kind: "email", value };
  }
  const value = normalizePhone(phoneRaw);
  if (!value) {
    return { ok: false, error: { code: "VALIDATION_ERROR", message: "Enter a valid phone number." } };
  }
  return { kind: "phone", value };
}

function identKey(id: Identifier): string {
  return `${id.kind}:${id.value}`;
}

function hashCode(id: Identifier, code: string): string {
  return createHash("sha256")
    .update(`${sessionSecret()}:${id.kind}:${id.value}:${code}`)
    .digest("hex");
}

function hashesEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function genericStartOk(): OtpStartSuccess {
  return { ok: true };
}

export async function startOtp(
  em: EntityManager,
  body: { email?: unknown; phone?: unknown },
): Promise<OtpStartSuccess | OtpError> {
  const parsed = parseIdentifier(body);
  if ("ok" in parsed && parsed.ok === false) return parsed;
  const id = parsed as Identifier;
  const key = identKey(id);

  if (await rateLimited(em, "otp_start", key, START_MAX, START_WINDOW_MS)) {
    return {
      ok: false,
      error: { code: "RATE_LIMITED", message: "Too many attempts. Try again in a few minutes." },
    };
  }

  // Invite-only beta (invites.ts): no code for a new account without an invite.
  const gate = await signupGate(em, id);
  if (gate) return gate;
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await em.nativeDelete(OtpChallenge, { kind: id.kind, value: id.value });
  const challengeRow = new OtpChallenge();
  challengeRow.kind = id.kind;
  challengeRow.value = id.value;
  challengeRow.codeHash = hashCode(id, code);
  challengeRow.expiresAt = new Date(Date.now() + OTP_TTL_MS);
  em.persist(challengeRow);
  await em.flush();

  // Delivery (mailer.ts): email through EMAIL_PROVIDER; phone has no sender yet.
  const delivered = id.kind === "email"
    ? await sendLoginCode({ to: id.value, code, expiresInMinutes: OTP_TTL_MS / 60_000 })
    : await sendLoginCodeSms({ to: id.value, code });
  if (!delivered.ok) {
    await em.nativeDelete(OtpChallenge, { kind: id.kind, value: id.value });
    return delivered;
  }

  return genericStartOk();
}

export async function verifyOtp(
  em: EntityManager,
  body: { email?: unknown; phone?: unknown; code?: unknown },
): Promise<OtpVerifySuccess | OtpError> {
  const parsed = parseIdentifier(body);
  if ("ok" in parsed && parsed.ok === false) return parsed;
  const id = parsed as Identifier;
  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (!/^\d{6}$/.test(code)) {
    return { ok: false, error: { code: "VALIDATION_ERROR", message: "Enter the 6-digit code." } };
  }

  const key = identKey(id);
  if (await rateLimited(em, "otp_verify", key, VERIFY_MAX, VERIFY_WINDOW_MS)) {
    return {
      ok: false,
      error: { code: "RATE_LIMITED", message: "Too many attempts. Try again in a few minutes." },
    };
  }

  const challenge = await em.findOne(
    OtpChallenge,
    { kind: id.kind, value: id.value },
    { orderBy: { createdAt: "DESC" } },
  );
  if (!challenge || challenge.expiresAt.getTime() < Date.now()) {
    if (challenge) await em.removeAndFlush(challenge);
    return {
      ok: false,
      error: { code: "OTP_INVALID", message: "That code is invalid or expired." },
    };
  }
  if (challenge.attempts >= OTP_MAX_ATTEMPTS) {
    await em.removeAndFlush(challenge);
    return {
      ok: false,
      error: { code: "OTP_INVALID", message: "That code is invalid or expired." },
    };
  }

  const expected = hashCode(id, code);
  if (!hashesEqual(expected, challenge.codeHash)) {
    challenge.attempts += 1;
    await em.flush();
    return {
      ok: false,
      error: { code: "OTP_INVALID", message: "That code is invalid or expired." },
    };
  }

  await em.removeAndFlush(challenge);

  let ident = await em.findOne(UserIdentifier, { kind: id.kind, value: id.value }, { populate: ["user"] });
  let user: User;
  if (!ident) {
    const refused = await claimInvite(em, id);
    if (refused) return refused;
    user = new User();
    ident = new UserIdentifier();
    ident.user = user;
    ident.kind = id.kind;
    ident.value = id.value;
    user.identifiers.add(ident);
    em.persist(user);
    em.persist(ident);
    await em.flush();
  } else {
    user = ident.user;
  }

  return { ok: true, user: await toPublicUser(em, user) };
}
