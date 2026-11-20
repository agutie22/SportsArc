/**
 * Invite-only private beta and the admins who run it.
 *
 *   BETA_INVITE_ONLY=true   only emails on the allowlist (beta_invites) may
 *                           create an account; existing accounts always sign in
 *   ADMIN_EMAILS=a@x,b@y    who may list, add and remove invites; an admin
 *                           email may also sign up without an invite, so the
 *                           first admin can bootstrap the beta
 *
 * otp.ts asks `signupGate` before sending a code and `claimInvite` at the
 * moment it creates a user. Admin routes live in routes/admin.ts; the CLI is
 * scripts/invite.ts. The pure rules are exported for api/auth/invites.test.ts.
 */

import type { EntityManager } from "@mikro-orm/postgresql";
import { BetaInvite } from "../entities/BetaInvite.js";
import type { User } from "../entities/User.js";
import { UserIdentifier, type IdentifierKind } from "../entities/UserIdentifier.js";
import { normalizeEmail } from "./otp.js";

type Env = Record<string, string | undefined>;

export interface InviteError {
  ok: false;
  error: { code: string; message: string };
}

export const INVITE_REQUIRED_MESSAGE = "You need an invite to create an account.";

const NOTE_MAX = 200;

// ── pure rules ────────────────────────────────────────────────────────

export function inviteOnlyEnabled(env: Env = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.BETA_INVITE_ONLY?.trim() ?? "");
}

export function adminEmails(env: Env = process.env): Set<string> {
  const out = new Set<string>();
  for (const part of (env.ADMIN_EMAILS ?? "").split(",")) {
    const email = normalizeEmail(part);
    if (email) out.add(email);
  }
  return out;
}

export function isAdminEmail(email: string | null | undefined, env: Env = process.env): boolean {
  if (!email) return false;
  const normalized = normalizeEmail(email);
  return Boolean(normalized && adminEmails(env).has(normalized));
}

/**
 * May this identifier get a login code? Existing accounts always may. With
 * invite-only off anyone may. Otherwise a new account needs an invite, or an
 * admin email; a phone number can never be invited, so it cannot sign up.
 */
export function signupAllowed(input: {
  inviteOnly: boolean;
  hasAccount: boolean;
  kind: IdentifierKind;
  invited: boolean;
  admin: boolean;
}): boolean {
  if (input.hasAccount || !input.inviteOnly) return true;
  if (input.kind !== "email") return false;
  return input.invited || input.admin;
}

function inviteRequired(): InviteError {
  return { ok: false, error: { code: "INVITE_REQUIRED", message: INVITE_REQUIRED_MESSAGE } };
}

// ── gates used by otp.ts ──────────────────────────────────────────────

/** Before a code is sent: null to go ahead, or INVITE_REQUIRED. */
export async function signupGate(
  em: EntityManager,
  id: { kind: IdentifierKind; value: string },
  env: Env = process.env,
): Promise<InviteError | null> {
  const inviteOnly = inviteOnlyEnabled(env);
  if (!inviteOnly) return null;
  const hasAccount = (await em.count(UserIdentifier, { kind: id.kind, value: id.value })) > 0;
  if (hasAccount) return null;
  const invited = id.kind === "email" && (await em.count(BetaInvite, { email: id.value })) > 0;
  const admin = id.kind === "email" && isAdminEmail(id.value, env);
  return signupAllowed({ inviteOnly, hasAccount, kind: id.kind, invited, admin }) ? null : inviteRequired();
}

/**
 * At account creation: re-check the gate (an invite may have been removed
 * since the code was sent) and mark the invite accepted. The change is
 * flushed with the new user by the caller.
 */
export async function claimInvite(
  em: EntityManager,
  id: { kind: IdentifierKind; value: string },
  env: Env = process.env,
): Promise<InviteError | null> {
  const invite = id.kind === "email" ? await em.findOne(BetaInvite, { email: id.value }) : null;
  const inviteOnly = inviteOnlyEnabled(env);
  const allowed = signupAllowed({
    inviteOnly,
    hasAccount: false,
    kind: id.kind,
    invited: Boolean(invite),
    admin: id.kind === "email" && isAdminEmail(id.value, env),
  });
  if (!allowed) return inviteRequired();
  if (invite && !invite.acceptedAt) invite.acceptedAt = new Date();
  return null;
}

// ── admin ─────────────────────────────────────────────────────────────

export async function userIsAdmin(em: EntityManager, user: User, env: Env = process.env): Promise<boolean> {
  const admins = adminEmails(env);
  if (admins.size === 0) return false;
  const idents = await em.find(UserIdentifier, { user, kind: "email" });
  return idents.some((i) => admins.has(i.value));
}

export interface PublicInvite {
  id: string;
  email: string;
  note: string | null;
  invitedBy: string | null;
  createdAt: string;
  acceptedAt: string | null;
  /** accepted: an account exists for this email (signed up, or already had one). */
  status: "pending" | "accepted";
}

export async function listInvites(em: EntityManager): Promise<PublicInvite[]> {
  const rows = await em.find(BetaInvite, {}, { orderBy: { createdAt: "DESC" }, populate: ["invitedBy"] });
  const emails = rows.map((r) => r.email);
  const accounts = emails.length
    ? await em.find(UserIdentifier, { kind: "email", value: { $in: emails } })
    : [];
  const hasAccount = new Set(accounts.map((a) => a.value));
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    note: r.note ?? null,
    invitedBy: r.invitedBy?.name ?? null,
    createdAt: r.createdAt.toISOString(),
    acceptedAt: r.acceptedAt?.toISOString() ?? null,
    status: r.acceptedAt || hasAccount.has(r.email) ? "accepted" : "pending",
  }));
}

export async function addInvite(
  em: EntityManager,
  body: { email?: unknown; note?: unknown },
  invitedBy: User | null,
): Promise<{ ok: true; created: boolean; invite: PublicInvite } | InviteError> {
  const email = typeof body.email === "string" ? normalizeEmail(body.email) : null;
  if (!email) return { ok: false, error: { code: "VALIDATION_ERROR", message: "Enter a valid email address." } };
  const noteRaw = typeof body.note === "string" ? body.note.trim() : "";
  if (noteRaw.length > NOTE_MAX) {
    return { ok: false, error: { code: "VALIDATION_ERROR", message: `Keep the note under ${NOTE_MAX} characters.` } };
  }
  let invite = await em.findOne(BetaInvite, { email });
  const created = !invite;
  if (!invite) {
    invite = new BetaInvite();
    invite.email = email;
    invite.invitedBy = invitedBy;
    invite.note = noteRaw || null;
    em.persist(invite);
  } else if (noteRaw) {
    invite.note = noteRaw;
  }
  await em.flush();
  const listed = (await listInvites(em)).find((i) => i.id === invite.id)!;
  return { ok: true, created, invite: listed };
}

/** Remove by id or by email. Never touches an account that already exists. */
export async function removeInvite(
  em: EntityManager,
  ref: { id?: string; email?: string },
): Promise<{ ok: true } | InviteError> {
  const email = ref.email ? normalizeEmail(ref.email) : null;
  const where = ref.id ? { id: ref.id } : email ? { email } : null;
  const invite = where && (!ref.id || /^[0-9a-f-]{36}$/i.test(ref.id)) ? await em.findOne(BetaInvite, where) : null;
  if (!invite) return { ok: false, error: { code: "INVITE_NOT_FOUND", message: "No such invite." } };
  await em.removeAndFlush(invite);
  return { ok: true };
}
