/**
 * Player-to-player payments. All need a session. Paying returns a Circle
 * challenge for the browser to sign with the PIN; the signature it gets
 * back is posted to confirm, and the relayer sends the transfer.
 *
 *   GET  /api/web3/pay                      requests to pay, requests waiting, recent payments
 *   POST /api/web3/pay/requests             { userId, amount, note? } or { gameId, total, note? }
 *   POST /api/web3/pay                      { requestId } or { userId, amount, note? } -> challenge
 *   POST /api/web3/pay/:id/confirm          { signature? } send the signed transfer; record its outcome
 *   POST /api/web3/pay/:id/decline          the payer turns a request down
 *   POST /api/web3/pay/:id/cancel           withdraw a request, or abandon an unsigned payment
 */

import { json, parseJsonBody, requireUser, statusFor } from "../../http.js";
import { get, post, type RouteContext } from "../../router.js";
import {
  PAY_STATUS, cancelPayment, confirmPayment, declinePayment, listPayments, requestPayment, startPayment,
} from "./pay.js";

const CODES: Record<string, number> = PAY_STATUS;

function reply(ctx: RouteContext, result: { ok: boolean; error?: { code: string } }): void {
  json(ctx.res, statusFor(result, CODES), result);
}

get("/api/web3/pay", async (ctx) => {
  const auth = await requireUser(ctx);
  if (!auth) return;
  reply(ctx, await listPayments(auth.fork, auth.user));
});

post("/api/web3/pay/requests", async (ctx) => {
  const auth = await requireUser(ctx);
  if (!auth) return;
  const body = await parseJsonBody<Record<string, unknown>>(ctx.req, ctx.res);
  if (!body) return;
  reply(ctx, await requestPayment(auth.fork, auth.user, body));
});

post("/api/web3/pay", async (ctx) => {
  const auth = await requireUser(ctx);
  if (!auth) return;
  const body = await parseJsonBody<Record<string, unknown>>(ctx.req, ctx.res);
  if (!body) return;
  reply(ctx, await startPayment(auth.fork, auth.user, body));
});

post("/api/web3/pay/:id/confirm", async (ctx) => {
  const auth = await requireUser(ctx);
  if (!auth) return;
  const body = await parseJsonBody<Record<string, unknown>>(ctx.req, ctx.res);
  if (!body) return;
  reply(ctx, await confirmPayment(auth.fork, auth.user, ctx.params.id ?? "", body));
});

post("/api/web3/pay/:id/decline", async (ctx) => {
  const auth = await requireUser(ctx);
  if (!auth) return;
  reply(ctx, await declinePayment(auth.fork, auth.user, ctx.params.id ?? ""));
});

post("/api/web3/pay/:id/cancel", async (ctx) => {
  const auth = await requireUser(ctx);
  if (!auth) return;
  reply(ctx, await cancelPayment(auth.fork, auth.user, ctx.params.id ?? ""));
});
