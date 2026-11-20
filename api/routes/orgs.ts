/**
 * Organizations: the public org page, creating and editing one, its staff
 * and invitations, and verification by SportsArc admins (api/orgs/).
 */

import { em } from "../db.js";
import { authed, errorJson, json, parseJsonBody, requireUser, viewerOf, type Auth } from "../http.js";
import { del, get, patch, post, type RouteContext, type RouteHandler } from "../router.js";
import { userIsAdmin } from "../auth/invites.js";
import {
  answerInvite, cancelInvite, changeRole, createOrg, findOrg, inviteStaff, listAllOrgs, myInvites, myOrgs,
  removeMember, setSigner, setVerified, staffOf, toPublicOrg, updateOrg,
} from "../orgs/orgs.js";
import { orgStatus } from "./status.js";
import { searchPeople } from "../social/social.js";
import { User } from "../entities/User.js";

type Body = Record<string, unknown>;

get("/api/orgs/:slug", async (ctx) => {
  const fork = em();
  const org = await findOrg(fork, ctx.params.slug);
  if (!org) {
    errorJson(ctx.res, 404, "ORG_NOT_FOUND", "That organization does not exist.");
    return;
  }
  const viewer = await viewerOf(ctx, fork);
  json(ctx.res, 200, { ok: true, org: await toPublicOrg(fork, org, viewer?.id) });
});

post("/api/orgs", authed(async ({ req, res }, { user, fork }) => {
  const body = await parseJsonBody<Body>(req, res);
  if (body === null) return;
  const result = await createOrg(fork, user, body);
  json(res, result.ok ? 201 : orgStatus(result), result);
}));

patch("/api/orgs/:id", authed(async ({ req, res, params }, { user, fork }) => {
  const body = await parseJsonBody<Body>(req, res);
  if (body === null) return;
  const result = await updateOrg(fork, user, params.id, body);
  json(res, orgStatus(result), result);
}));

post("/api/orgs/:id/signer", authed(async ({ req, res, params }, { user, fork }) => {
  const body = await parseJsonBody<Body>(req, res);
  if (body === null) return;
  const result = await setSigner(fork, user, params.id, body);
  json(res, orgStatus(result), result);
}));

/**
 * People search for staff pickers (org staff, team players): adults only,
 * since org staff and league players must be. Public profiles do not carry
 * the audience, so this is its own route rather than a flag on /api/people.
 */
get("/api/people/adults", authed(async ({ res, query }, { user, fork }) => {
  const people = await searchPeople(fork, { q: query.get("q") ?? undefined, limit: query.get("limit") ?? undefined }, user.id);
  const ids = people.map((p) => p.id);
  const adults = ids.length
    ? new Set((await fork.find(User, { id: { $in: ids }, audience: { $in: ["adult", "guardian"] } }, { fields: ["id"] })).map((u) => u.id))
    : new Set<string>();
  json(res, 200, { ok: true, people: people.filter((p) => adults.has(p.id)) });
}));

get("/api/my/orgs", authed(async ({ res }, { user, fork }) => {
  json(res, 200, { ok: true, orgs: await myOrgs(fork, user) });
}));

get("/api/orgs/:id/staff", authed(async ({ res, params }, { user, fork }) => {
  const result = await staffOf(fork, user, params.id);
  json(res, orgStatus(result), result);
}));

post("/api/orgs/:id/invites", authed(async ({ req, res, params }, { user, fork }) => {
  const body = await parseJsonBody<Body>(req, res);
  if (body === null) return;
  const result = await inviteStaff(fork, user, params.id, body);
  json(res, result.ok ? 201 : orgStatus(result), result);
}));

del("/api/orgs/:id/invites/:inviteId", authed(async ({ res, params }, { user, fork }) => {
  const result = await cancelInvite(fork, user, params.id, params.inviteId);
  json(res, orgStatus(result), result);
}));

patch("/api/orgs/:id/members/:userId", authed(async ({ req, res, params }, { user, fork }) => {
  const body = await parseJsonBody<Body>(req, res);
  if (body === null) return;
  const result = await changeRole(fork, user, params.id, params.userId, body);
  json(res, orgStatus(result), result);
}));

del("/api/orgs/:id/members/:userId", authed(async ({ res, params }, { user, fork }) => {
  const result = await removeMember(fork, user, params.id, params.userId);
  json(res, orgStatus(result), result);
}));

get("/api/my/org-invites", authed(async ({ res }, { user, fork }) => {
  json(res, 200, { ok: true, invites: await myInvites(fork, user) });
}));

post("/api/org-invites/:id/accept", authed(async ({ res, params }, { user, fork }) => {
  const result = await answerInvite(fork, user, params.id, true);
  json(res, orgStatus(result), result);
}));

post("/api/org-invites/:id/decline", authed(async ({ res, params }, { user, fork }) => {
  const result = await answerInvite(fork, user, params.id, false);
  json(res, orgStatus(result), result);
}));

// ── SportsArc admins ──────────────────────────────────────────────────

function adminOnly(handler: (ctx: RouteContext, auth: Auth) => Promise<void>): RouteHandler {
  return async (ctx) => {
    const auth = await requireUser(ctx);
    if (!auth) return;
    if (!(await userIsAdmin(auth.fork, auth.user))) {
      errorJson(ctx.res, 403, "NOT_ADMIN", "Only SportsArc admins can verify organizations.");
      return;
    }
    await handler(ctx, auth);
  };
}

get("/api/admin/orgs", adminOnly(async ({ res }, { fork }) => {
  json(res, 200, { ok: true, orgs: await listAllOrgs(fork) });
}));

post("/api/admin/orgs/:id/verify", adminOnly(async ({ res, params }, { fork }) => {
  const result = await setVerified(fork, params.id, true);
  json(res, orgStatus(result), result);
}));

del("/api/admin/orgs/:id/verify", adminOnly(async ({ res, params }, { fork }) => {
  const result = await setVerified(fork, params.id, false);
  json(res, orgStatus(result), result);
}));
