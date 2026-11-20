/**
 * Who may do what for an organization. Every "may this person run this?"
 * question goes through orgRole() and mayOrg(), the way games/roles.ts does
 * for hosts.
 *
 *   owner  everything, including naming admins and other owners
 *   admin  edits the org, invites and removes staff, runs its work
 *   staff  runs its work: leagues, events, results, the scout board, insights
 *
 * Some work also needs the org to be verified by a SportsArc admin
 * (verifiedGate): anything with money, sponsoring, and insights. That is the
 * guard against someone creating "Austin Spurs" who is not the Austin Spurs.
 */

import type { EntityManager } from "@mikro-orm/postgresql";
import { fail, type Failure } from "../failure.js";
import { OrgMember, type OrgRole } from "./OrgMember.js";
import type { Organization } from "./Organization.js";

export type OrgPower = "edit" | "members" | "admins" | "run";
export type VerifiedWork = "money" | "sponsor" | "insights";

export function mayOrg(role: OrgRole | null, power: OrgPower): boolean {
  if (role === "owner") return true;
  if (role === "admin") return power !== "admins";
  if (role === "staff") return power === "run";
  return false;
}

/** May `actor` give someone the role `target` (by invite or by change)? */
export function mayAssign(actor: OrgRole | null, target: OrgRole): boolean {
  if (target === "staff") return mayOrg(actor, "members");
  return mayOrg(actor, "admins");
}

/**
 * May `actor` remove a member who holds `target`? Anyone may leave, except
 * the last owner (checked by the caller, who can count owners).
 */
export function mayRemove(actor: OrgRole | null, target: OrgRole, self: boolean): boolean {
  if (self) return actor !== null;
  return mayAssign(actor, target);
}

export function verifiedGate(org: Pick<Organization, "verifiedAt">, work: VerifiedWork): Failure | null {
  if (org.verifiedAt) return null;
  const what = work === "money" ? "take or pay money" : work === "sponsor" ? "sponsor anything" : "see insights";
  return fail("ORG_NOT_VERIFIED", `This organization is not verified yet, so it cannot ${what}.`);
}

export async function orgRole(em: EntityManager, userId: string | undefined, orgId: string): Promise<OrgRole | null> {
  if (!userId) return null;
  const m = await em.findOne(OrgMember, { org: orgId, user: userId }, { fields: ["role"] });
  return m?.role ?? null;
}

/** orgRole + mayOrg, as a result: null to go ahead, or NOT_ORG_STAFF. */
export async function requireOrg(em: EntityManager, userId: string, orgId: string, power: OrgPower): Promise<Failure | null> {
  const role = await orgRole(em, userId, orgId);
  if (mayOrg(role, power)) return null;
  return fail("NOT_ORG_STAFF", role ? "Your role in this organization cannot do that." : "Only this organization's staff can do that.");
}
