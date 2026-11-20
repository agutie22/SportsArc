/**
 * Payouts to other chains (Circle Gateway). A signed-in player reads their
 * own payouts and manages the addresses they can be paid at. No route starts
 * or steers a payout: those come only from on-chain event payments
 * (inbox.ts), driven by the payout job.
 *
 *   GET    /api/web3/gateway/options            chains a payout can go to, my saved addresses
 *   DELETE /api/web3/gateway/destinations/:id   forget one
 *   GET    /api/web3/gateway/payouts            my payouts, newest first
 */

import { json, requireUser, statusFor } from "../../http.js";
import { del, get, type RouteContext } from "../../router.js";
import { mayTransact } from "../wallet/service.js";
import { payoutOptions, removeDestination } from "./destinations.js";
import { listPayouts, payoutsConfigured } from "./payouts.js";

const CODES: Record<string, number> = {
  DESTINATION_NOT_FOUND: 404,
  TOO_MANY_DESTINATIONS: 409,
  NOT_ELIGIBLE: 403,
};

function send(ctx: RouteContext, result: { ok: boolean; error?: { code: string } }): void {
  json(ctx.res, statusFor(result, CODES), result);
}

get("/api/web3/gateway/options", async (ctx) => {
  const auth = await requireUser(ctx);
  if (!auth) return;
  const options = await payoutOptions(auth.fork, auth.user);
  options.available = options.available && payoutsConfigured() && mayTransact(auth.user);
  send(ctx, options);
});

del("/api/web3/gateway/destinations/:id", async (ctx) => {
  const auth = await requireUser(ctx);
  if (!auth) return;
  send(ctx, await removeDestination(auth.fork, auth.user, ctx.params.id ?? ""));
});

get("/api/web3/gateway/payouts", async (ctx) => {
  const auth = await requireUser(ctx);
  if (!auth) return;
  send(ctx, await listPayouts(auth.fork, auth.user));
});
