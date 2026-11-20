/**
 * The organizations API calls and the small shared pieces of the module:
 * role rules mirrored from api/orgs/roles.ts (the server still decides),
 * kind and role labels, and the verified badge.
 */

import { apiGet, apiSend, esc, titleCase } from "../api.js";
import { ICON } from "../shared.js";

export const getOrg = (ref) => apiGet(`/api/orgs/${encodeURIComponent(ref)}`).then((b) => b.org);
export const getStaff = (id) => apiGet(`/api/orgs/${id}/staff`).then((b) => b.staff);
export const myOrgs = () => apiGet("/api/my/orgs").then((b) => b.orgs);
export const myInvites = () => apiGet("/api/my/org-invites").then((b) => b.invites);
export const myTeams = () => apiGet("/api/my/teams").then((b) => b.teams);

const STALE = ["/api/orgs", "/api/my/", "/api/seasons", "/api/teams", "/api/games"];
export const send = (path, method, body) => apiSend(path, method, body, { stale: STALE });

/** May `actor` give or take away `target`? Mirrors roles.ts mayAssign. */
export function mayAssign(actor, target) {
  if (actor === "owner") return true;
  return actor === "admin" && target === "staff";
}

export const manages = (role) => role === "owner" || role === "admin";

const ROLE_LABEL = { owner: "Owner", admin: "Admin", staff: "Staff" };
export const roleLabel = (r) => ROLE_LABEL[r] ?? titleCase(r ?? "");
export const kindLabel = (k) => titleCase(k ?? "");

export function verifiedBadge(org) {
  return org.verified
    ? `<span class="org-badge org-badge-ok" title="Verified by SportsArc">${ICON.check}<span>Verified</span></span>`
    : `<span class="org-badge" title="A SportsArc admin has not verified this organization yet">Not verified yet</span>`;
}

export const kindChip = (org) => `<span class="org-kind">${esc(kindLabel(org.kind))}</span>`;
