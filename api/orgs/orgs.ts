/**
 * Organizations: create, read, edit, verify, and their staff (invite by
 * email, accept, change roles, remove). Permission rules are in roles.ts;
 * routes in api/routes/orgs.ts.
 *
 * Onboarding, the real path: an adult creates the org and is its owner; a
 * SportsArc admin verifies it; the owner invites staff by email (which also
 * puts the email on the beta allowlist when the beta is invite-only), or
 * picks them in-app if they are already on SportsArc (a notification), and
 * they accept from #/orgs/invites. Members are always adults.
 */

import type { EntityManager } from "@mikro-orm/postgresql";
import { fail, type Failure } from "../failure.js";
import { isUuid } from "../validate.js";
import { User as UserEntity, type User } from "../entities/User.js";
import { notify } from "../social/notifications.js";
import { UserIdentifier } from "../entities/UserIdentifier.js";
import { addInvite, inviteOnlyEnabled } from "../auth/invites.js";
import { normalizeEmail } from "../auth/otp.js";
import { mayTransact } from "../web3/wallet/service.js";
import { Organization, isOrgKind, type OrgKind } from "./Organization.js";
import { OrgMember, isOrgRole, type OrgRole } from "./OrgMember.js";
import { OrgInvite } from "./OrgInvite.js";
import { mayAssign, mayOrg, mayRemove, orgRole, requireOrg } from "./roles.js";

const NAME_MAX = 120;
const CITY_MAX = 120;
const BIO_MAX = 500;
const RESERVED_SLUGS = new Set(["new", "manage", "admin", "api", "me", "my"]);

// ── pure ──────────────────────────────────────────────────────────────

export function slugify(name: string): string {
  return name
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
}

export function validSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,58}[a-z0-9]$/.test(slug) && !RESERVED_SLUGS.has(slug);
}

function cleanWebsite(raw: unknown): string | null | Failure {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") return fail("VALIDATION_ERROR", "Website must be a link.");
  const v = raw.trim();
  try {
    const u = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`);
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("scheme");
    return u.toString().slice(0, 255);
  } catch {
    return fail("VALIDATION_ERROR", "Website must be a link, like https://example.org.");
  }
}

function text(raw: unknown, max: number, label: string): string | null | Failure {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") return fail("VALIDATION_ERROR", `${label} must be text.`);
  const v = raw.trim();
  if (v.length > max) return fail("VALIDATION_ERROR", `Keep ${label.toLowerCase()} under ${max} characters.`);
  return v || null;
}

const isFailure = (v: unknown): v is Failure => typeof v === "object" && v !== null && (v as Failure).ok === false;

// ── shapes ────────────────────────────────────────────────────────────

export interface OrgPerson {
  id: string;
  name: string | null;
  avatarUrl: string | null;
  role: string | null;
  headline: string | null;
}

export interface PublicOrg {
  id: string;
  slug: string;
  name: string;
  kind: OrgKind;
  city: string | null;
  website: string | null;
  bio: string | null;
  verified: boolean;
  verifiedAt: string | null;
  createdAt: string;
  staff: { person: OrgPerson; role: OrgRole }[];
  /** The viewer's role here, or null. */
  viewerRole: OrgRole | null;
  /** Whether the org has a wallet to sign with (its signer has one). */
  hasWallet: boolean;
}

export function personOf(u: User): OrgPerson {
  return { id: u.id, name: u.name ?? null, avatarUrl: u.avatarUrl ?? null, role: u.role ?? null, headline: u.headline ?? null };
}

const ROLE_ORDER: Record<OrgRole, number> = { owner: 0, admin: 1, staff: 2 };

export async function toPublicOrg(em: EntityManager, org: Organization, viewerId?: string): Promise<PublicOrg> {
  const members = await em.find(OrgMember, { org }, { populate: ["user"], orderBy: { createdAt: "ASC" } });
  members.sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role]);
  if (org.signer) await em.populate(org, ["signer"]);
  return {
    id: org.id,
    slug: org.slug,
    name: org.name,
    kind: org.kind,
    city: org.city ?? null,
    website: org.website ?? null,
    bio: org.bio ?? null,
    verified: Boolean(org.verifiedAt),
    verifiedAt: org.verifiedAt?.toISOString() ?? null,
    createdAt: org.createdAt.toISOString(),
    staff: members.map((m) => ({ person: personOf(m.user), role: m.role })),
    viewerRole: viewerId ? members.find((m) => m.user.id === viewerId)?.role ?? null : null,
    hasWallet: Boolean(org.signer?.walletAddress),
  };
}

// ── lookups ───────────────────────────────────────────────────────────

/** By id or slug. */
export async function findOrg(em: EntityManager, ref: string): Promise<Organization | null> {
  if (isUuid(ref)) return em.findOne(Organization, { id: ref });
  const slug = ref.toLowerCase();
  return validSlug(slug) ? em.findOne(Organization, { slug }) : null;
}

const notFound = (): Failure => fail("ORG_NOT_FOUND", "That organization does not exist.");

export async function myOrgs(em: EntityManager, user: User) {
  const rows = await em.find(OrgMember, { user }, { populate: ["org"], orderBy: { createdAt: "ASC" } });
  return rows.map((m) => ({
    id: m.org.id, slug: m.org.slug, name: m.org.name, kind: m.org.kind,
    verified: Boolean(m.org.verifiedAt), role: m.role,
  }));
}

// ── create and edit ───────────────────────────────────────────────────

export async function createOrg(em: EntityManager, user: User, body: Record<string, unknown>): Promise<{ ok: true; org: PublicOrg } | Failure> {
  if (!mayTransact(user)) return fail("ADULTS_ONLY", "Organizations are run by adults. Set your profile to adult first.");
  const name = text(body.name, NAME_MAX, "Name");
  if (isFailure(name)) return name;
  if (!name || name.length < 2) return fail("VALIDATION_ERROR", "Give the organization a name.");
  if (!isOrgKind(body.kind)) return fail("VALIDATION_ERROR", "Pick what kind of organization this is.");
  const city = text(body.city, CITY_MAX, "City");
  if (isFailure(city)) return city;
  const bio = text(body.bio, BIO_MAX, "About");
  if (isFailure(bio)) return bio;
  const website = cleanWebsite(body.website);
  if (isFailure(website)) return website;

  let slug: string;
  if (typeof body.slug === "string" && body.slug.trim()) {
    slug = body.slug.trim().toLowerCase();
    if (!validSlug(slug)) return fail("VALIDATION_ERROR", "The address can use lowercase letters, numbers and dashes.");
    if (await em.count(Organization, { slug })) return fail("SLUG_TAKEN", "That address is taken.");
  } else {
    const base = slugify(name);
    if (!validSlug(base)) return fail("VALIDATION_ERROR", "Pick an address for the organization.");
    slug = base;
    for (let n = 2; await em.count(Organization, { slug }); n++) slug = `${base.slice(0, 56)}-${n}`;
  }

  const org = new Organization();
  org.slug = slug;
  org.name = name;
  org.kind = body.kind;
  org.city = city;
  org.bio = bio;
  org.website = website;
  org.createdBy = user;
  org.signer = user;
  const owner = new OrgMember();
  owner.org = org;
  owner.user = user;
  owner.role = "owner";
  owner.addedBy = user;
  em.persist([org, owner]);
  await em.flush();
  return { ok: true, org: await toPublicOrg(em, org, user.id) };
}

export async function updateOrg(em: EntityManager, user: User, ref: string, body: Record<string, unknown>): Promise<{ ok: true; org: PublicOrg } | Failure> {
  const org = await findOrg(em, ref);
  if (!org) return notFound();
  const denied = await requireOrg(em, user.id, org.id, "edit");
  if (denied) return denied;
  if (body.name !== undefined) {
    const name = text(body.name, NAME_MAX, "Name");
    if (isFailure(name)) return name;
    if (!name || name.length < 2) return fail("VALIDATION_ERROR", "Give the organization a name.");
    // A verified org's name was what the admin checked.
    if (name !== org.name && org.verifiedAt) return fail("ORG_VERIFIED_NAME", "A verified organization's name is fixed. Ask an admin to change it.");
    org.name = name;
  }
  for (const [key, max, label] of [["city", CITY_MAX, "City"], ["bio", BIO_MAX, "About"]] as const) {
    if (body[key] === undefined) continue;
    const v = text(body[key], max, label);
    if (isFailure(v)) return v;
    org[key] = v;
  }
  if (body.website !== undefined) {
    const w = cleanWebsite(body.website);
    if (isFailure(w)) return w;
    org.website = w;
  }
  await em.flush();
  return { ok: true, org: await toPublicOrg(em, org, user.id) };
}

/** The owner names which member's wallet signs for the org. */
export async function setSigner(em: EntityManager, user: User, ref: string, body: { userId?: unknown }): Promise<{ ok: true; org: PublicOrg } | Failure> {
  const org = await findOrg(em, ref);
  if (!org) return notFound();
  const denied = await requireOrg(em, user.id, org.id, "admins");
  if (denied) return denied;
  const id = typeof body.userId === "string" ? body.userId : "";
  const member = isUuid(id) ? await em.findOne(OrgMember, { org, user: id }, { populate: ["user"] }) : null;
  if (!member || member.role === "staff") return fail("VALIDATION_ERROR", "The signer must be an owner or admin of this organization.");
  if (!member.user.walletAddress) return fail("NO_WALLET", "That person has not set up a wallet yet.");
  org.signer = member.user;
  await em.flush();
  return { ok: true, org: await toPublicOrg(em, org, user.id) };
}

// ── verification (SportsArc admins; routes/orgs.ts checks userIsAdmin) ──

export async function setVerified(em: EntityManager, ref: string, verified: boolean): Promise<{ ok: true; org: PublicOrg } | Failure> {
  const org = await findOrg(em, ref);
  if (!org) return notFound();
  org.verifiedAt = verified ? org.verifiedAt ?? new Date() : null;
  await em.flush();
  return { ok: true, org: await toPublicOrg(em, org) };
}

export async function listAllOrgs(em: EntityManager) {
  const orgs = await em.find(Organization, {}, { orderBy: { createdAt: "DESC" }, limit: 200 });
  return orgs.map((o) => ({
    id: o.id, slug: o.slug, name: o.name, kind: o.kind, city: o.city ?? null,
    verified: Boolean(o.verifiedAt), createdAt: o.createdAt.toISOString(),
  }));
}

// ── staff ─────────────────────────────────────────────────────────────

export interface StaffView {
  members: { person: OrgPerson; role: OrgRole; since: string }[];
  /**
   * Only owners and admins see pending invites. An in-app invite names the
   * person; an email invite shows the email.
   */
  invites: { id: string; person: OrgPerson | null; email: string | null; role: OrgRole; createdAt: string }[] | null;
}

export async function staffOf(em: EntityManager, user: User, ref: string): Promise<{ ok: true; staff: StaffView } | Failure> {
  const org = await findOrg(em, ref);
  if (!org) return notFound();
  const role = await orgRole(em, user.id, org.id);
  if (!role) return fail("NOT_ORG_STAFF", "Only this organization's staff can see this.");
  const members = await em.find(OrgMember, { org }, { populate: ["user"], orderBy: { createdAt: "ASC" } });
  members.sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role]);
  const invites = mayOrg(role, "members")
    ? (await em.find(OrgInvite, { org }, { populate: ["user"], orderBy: { createdAt: "DESC" } })).map((i) => ({
      id: i.id,
      person: i.user ? personOf(i.user) : null,
      email: i.user ? null : i.email ?? null,
      role: i.role,
      createdAt: i.createdAt.toISOString(),
    }))
    : null;
  return {
    ok: true,
    staff: {
      members: members.map((m) => ({ person: personOf(m.user), role: m.role, since: m.createdAt.toISOString() })),
      invites,
    },
  };
}

export interface SentInvite { id: string; person: OrgPerson | null; email: string | null; role: OrgRole }

/**
 * Invite someone to the staff: `userId` picks a person already on
 * SportsArc (in-app, with a notification); `email` reaches someone who may
 * not be. An email that already has an account becomes an in-app invite.
 */
export async function inviteStaff(
  em: EntityManager,
  user: User,
  ref: string,
  body: { userId?: unknown; email?: unknown; role?: unknown },
): Promise<{ ok: true; invite: SentInvite } | Failure> {
  const org = await findOrg(em, ref);
  if (!org) return notFound();
  const role = body.role === undefined ? "staff" : body.role;
  if (!isOrgRole(role) || role === "owner") return fail("VALIDATION_ERROR", "Invite as admin or staff.");
  const actor = await orgRole(em, user.id, org.id);
  if (!mayAssign(actor, role)) return fail("NOT_ORG_STAFF", "Your role in this organization cannot invite that role.");

  let invitee: User | null = null;
  let email: string | null = null;
  if (typeof body.userId === "string" && body.userId) {
    invitee = isUuid(body.userId) ? await em.findOne(UserEntity, { id: body.userId }) : null;
    if (!invitee) return fail("USER_NOT_FOUND", "That person is not on SportsArc.");
  } else {
    email = typeof body.email === "string" ? normalizeEmail(body.email) : null;
    if (!email) return fail("VALIDATION_ERROR", "Pick a person or enter a valid email address.");
    const ident = await em.findOne(UserIdentifier, { kind: "email", value: email }, { populate: ["user"] });
    if (ident) invitee = ident.user;
  }
  if (invitee) {
    if (!mayTransact(invitee)) return fail("ADULTS_ONLY", "Organization staff are adults.");
    if (await em.count(OrgMember, { org, user: invitee })) return fail("ALREADY_MEMBER", "That person is already on the staff.");
  }

  let invite = invitee
    ? await em.findOne(OrgInvite, { org, user: invitee })
    : await em.findOne(OrgInvite, { org, email });
  const fresh = !invite;
  if (!invite) {
    invite = new OrgInvite();
    invite.org = org;
    em.persist(invite);
  }
  if (invitee) {
    invite.user = invitee;
    invite.email = null;
  } else {
    invite.email = email;
  }
  invite.role = role;
  invite.invitedBy = user;
  await em.flush();

  if (invitee && fresh) {
    await notify(em, { recipient: invitee, actor: user, kind: "org_invite", detail: `${org.name} · ${role}`.slice(0, 120) });
  }
  // In an invite-only beta they could not sign up to accept without this.
  if (!invitee && email && inviteOnlyEnabled()) {
    const allowed = await addInvite(em, { email, note: `Staff at ${org.name}`.slice(0, 200) }, user);
    if (!allowed.ok) return allowed;
  }
  return {
    ok: true,
    invite: { id: invite.id, person: invitee ? personOf(invitee) : null, email: invitee ? null : email, role: invite.role },
  };
}

export async function cancelInvite(em: EntityManager, user: User, ref: string, inviteId: string): Promise<{ ok: true } | Failure> {
  const org = await findOrg(em, ref);
  if (!org) return notFound();
  const denied = await requireOrg(em, user.id, org.id, "members");
  if (denied) return denied;
  const invite = isUuid(inviteId) ? await em.findOne(OrgInvite, { id: inviteId, org }) : null;
  if (!invite) return fail("ORG_INVITE_NOT_FOUND", "No such invitation.");
  await em.removeAndFlush(invite);
  return { ok: true };
}

async function emailsOf(em: EntityManager, user: User): Promise<string[]> {
  return (await em.find(UserIdentifier, { user, kind: "email" })).map((i) => i.value.toLowerCase());
}

/** Invitations waiting for the signed-in user: picked in-app, or sent to one of their emails. */
export async function myInvites(em: EntityManager, user: User) {
  const emails = await emailsOf(em, user);
  const where = emails.length ? { $or: [{ user }, { email: { $in: emails } }] } : { user };
  const rows = await em.find(OrgInvite, where, { populate: ["org", "invitedBy"], orderBy: { createdAt: "DESC" } });
  return rows.map((i) => ({
    id: i.id,
    role: i.role,
    org: { id: i.org.id, slug: i.org.slug, name: i.org.name, kind: i.org.kind, verified: Boolean(i.org.verifiedAt) },
    invitedBy: i.invitedBy ? personOf(i.invitedBy) : null,
    createdAt: i.createdAt.toISOString(),
  }));
}

export async function answerInvite(em: EntityManager, user: User, inviteId: string, accept: boolean): Promise<{ ok: true; org?: PublicOrg } | Failure> {
  const invite = isUuid(inviteId) ? await em.findOne(OrgInvite, { id: inviteId }, { populate: ["org"] }) : null;
  const mine = invite && (invite.user?.id === user.id || (invite.email && (await emailsOf(em, user)).includes(invite.email)));
  if (!invite || !mine) return fail("ORG_INVITE_NOT_FOUND", "No such invitation.");
  const org = invite.org;
  if (!accept) {
    await em.removeAndFlush(invite);
    return { ok: true };
  }
  if (!mayTransact(user)) return fail("ADULTS_ONLY", "Organization staff are adults. Set your profile to adult first.");
  if (!(await em.count(OrgMember, { org, user }))) {
    const m = new OrgMember();
    m.org = org;
    m.user = user;
    m.role = invite.role;
    m.addedBy = invite.invitedBy ?? null;
    em.persist(m);
  }
  em.remove(invite);
  await em.flush();
  return { ok: true, org: await toPublicOrg(em, org, user.id) };
}

async function ownerCount(em: EntityManager, org: Organization): Promise<number> {
  return em.count(OrgMember, { org, role: "owner" });
}

export async function changeRole(em: EntityManager, user: User, ref: string, memberUserId: string, body: { role?: unknown }): Promise<{ ok: true } | Failure> {
  const org = await findOrg(em, ref);
  if (!org) return notFound();
  if (!isOrgRole(body.role)) return fail("VALIDATION_ERROR", "Pick owner, admin or staff.");
  const member = isUuid(memberUserId) ? await em.findOne(OrgMember, { org, user: memberUserId }) : null;
  if (!member) return fail("ORG_MEMBER_NOT_FOUND", "That person is not on the staff.");
  const actor = await orgRole(em, user.id, org.id);
  // Both the role they hold and the one they get must be the actor's to give.
  if (!mayAssign(actor, member.role) || !mayAssign(actor, body.role)) {
    return fail("NOT_ORG_STAFF", "Your role in this organization cannot make that change.");
  }
  if (member.role === "owner" && body.role !== "owner" && (await ownerCount(em, org)) <= 1) {
    return fail("LAST_OWNER", "Name another owner first: an organization always has one.");
  }
  member.role = body.role;
  if (body.role === "staff" && org.signer?.id === memberUserId) org.signer = null;
  await em.flush();
  return { ok: true };
}

export async function removeMember(em: EntityManager, user: User, ref: string, memberUserId: string): Promise<{ ok: true } | Failure> {
  const org = await findOrg(em, ref);
  if (!org) return notFound();
  const member = isUuid(memberUserId) ? await em.findOne(OrgMember, { org, user: memberUserId }) : null;
  if (!member) return fail("ORG_MEMBER_NOT_FOUND", "That person is not on the staff.");
  const actor = await orgRole(em, user.id, org.id);
  if (!mayRemove(actor, member.role, memberUserId === user.id)) {
    return fail("NOT_ORG_STAFF", "Your role in this organization cannot remove them.");
  }
  if (member.role === "owner" && (await ownerCount(em, org)) <= 1) {
    return fail("LAST_OWNER", "Name another owner first: an organization always has one.");
  }
  if (org.signer?.id === memberUserId) org.signer = null;
  em.remove(member);
  await em.flush();
  return { ok: true };
}
