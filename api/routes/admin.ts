/**
 * Admin: beta invites. Admins are the accounts in ADMIN_EMAILS (invites.ts).
 */

import { authed, errorJson, json, parseJsonBody, requireUser, type Auth } from "../http.js";
import { addInvite, inviteOnlyEnabled, listInvites, removeInvite, userIsAdmin } from "../auth/invites.js";
import { del, get, post, type RouteContext, type RouteHandler } from "../router.js";
import { authStatus } from "./status.js";

/** A route for admins; others get the 401 or 403. */
function adminOnly(handler: (ctx: RouteContext, auth: Auth) => Promise<void>): RouteHandler {
  return async (ctx) => {
    const auth = await requireUser(ctx);
    if (!auth) return;
    if (!(await userIsAdmin(auth.fork, auth.user))) {
      errorJson(ctx.res, 403, "NOT_ADMIN", "Only admins can manage invites.");
      return;
    }
    await handler(ctx, auth);
  };
}

get("/api/admin/status", authed(async ({ res }, { user, fork }) => {
  json(res, 200, {
    ok: true,
    admin: await userIsAdmin(fork, user),
    inviteOnly: inviteOnlyEnabled(),
  });
}));

get("/api/admin/invites", adminOnly(async ({ res }, { fork }) => {
  json(res, 200, { ok: true, invites: await listInvites(fork) });
}));

post("/api/admin/invites", adminOnly(async ({ req, res }, { user, fork }) => {
  const body = await parseJsonBody<{ email?: string; note?: string }>(req, res);
  if (body === null) return;
  const result = await addInvite(fork, body, user);
  json(res, result.ok ? (result.created ? 201 : 200) : authStatus(result), result);
}));

del("/api/admin/invites/:id", adminOnly(async ({ res, params }, { fork }) => {
  const result = await removeInvite(fork, { id: params.id });
  json(res, authStatus(result), result);
}));
