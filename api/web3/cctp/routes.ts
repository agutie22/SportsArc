/**
 * CCTP routes. A signed-in user sees and drives only their own transfers.
 *
 *   GET  /api/web3/cctp/transfers              the user's transfers, newest first
 *   GET  /api/web3/cctp/transfers/:id          one of them (404 if not theirs)
 *   GET  /api/web3/cctp/destinations           where a withdrawal from Arc may go
 *   GET  /api/web3/cctp/quote?destination=&amount=   the fee and what arrives
 *   POST /api/web3/cctp/withdrawals            { amount, destination, recipient? }
 *   POST /api/web3/cctp/transfers/:id/advance  run it as far as it goes; when a
 *        step needs the user's PIN the answer carries a Circle challenge, and
 *        the browser posts the signed tx to /api/web3/wallet/tx/:stepTxId/signed
 *
 *   GET  /api/web3/cctp/sources                chains money can be added from
 *   POST /api/web3/cctp/fund/steps             { source, amount, from }: the calls an
 *        outside wallet sends to add money to the caller's SportsArc wallet
 *   POST /api/web3/cctp/fund                   { source, txHash }: follow that burn
 *   GET  /api/web3/cctp/fundings               money the caller has added
 *
 * No route moves money by itself: every tx is signed by the user's own wallet,
 * and a withdrawal's mint is submitted by Circle's Forwarding Service.
 */

import { get, post, type RouteContext } from "../../router.js";
import { json, parseJsonBody, requireUser, statusFor } from "../../http.js";
import { fundingSources, fundingSteps, listFundings, recordFunding } from "./funding.js";
import {
  advanceTransfer,
  getTransfer,
  listTransfers,
  quoteWithdrawal,
  startWithdrawal,
  withdrawDestinations,
} from "./transfer.js";

const CODES: Record<string, number> = {
  TRANSFER_NOT_FOUND: 404,
  INELIGIBLE: 403,
  WALLET_NOT_READY: 409,
  TRANSFER_IN_PROGRESS: 409,
  TRANSFER_BUSY: 409,
  CHAIN_MISMATCH: 409,
  AMOUNT_TOO_SMALL: 400,
  FORWARDING_UNAVAILABLE: 503,
  IRIS_UNAVAILABLE: 503,
  IRIS_RATE_LIMITED: 503,
  IRIS_BAD_RESPONSE: 502,
  NOT_CONFIGURED: 503,
  TESTNET_ONLY: 403,
  INSUFFICIENT_USDC: 409,
  FUNDING_NOT_FOUND: 404,
};

function send(ctx: RouteContext, result: { ok: boolean; error?: { code: string } }): void {
  json(ctx.res, statusFor(result, CODES), result);
}

get("/api/web3/cctp/transfers", async (ctx) => {
  const auth = await requireUser(ctx);
  if (!auth) return;
  send(ctx, await listTransfers(auth.fork, auth.user));
});

get("/api/web3/cctp/transfers/:id", async (ctx) => {
  const auth = await requireUser(ctx);
  if (!auth) return;
  send(ctx, await getTransfer(auth.fork, auth.user, ctx.params.id));
});

get("/api/web3/cctp/destinations", async (ctx) => {
  const auth = await requireUser(ctx);
  if (!auth) return;
  send(ctx, { ok: true, ...withdrawDestinations() });
});

get("/api/web3/cctp/quote", async (ctx) => {
  const auth = await requireUser(ctx);
  if (!auth) return;
  send(ctx, await quoteWithdrawal({
    amount: ctx.query.get("amount") ?? undefined,
    destination: ctx.query.get("destination") ?? undefined,
  }));
});

post("/api/web3/cctp/withdrawals", async (ctx) => {
  const auth = await requireUser(ctx);
  if (!auth) return;
  const body = await parseJsonBody<Record<string, unknown>>(ctx.req, ctx.res);
  if (!body) return;
  send(ctx, await startWithdrawal(auth.fork, auth.user, {
    amount: body.amount, destination: body.destination, recipient: body.recipient,
  }));
});

post("/api/web3/cctp/transfers/:id/advance", async (ctx) => {
  const auth = await requireUser(ctx);
  if (!auth) return;
  const mine = await getTransfer(auth.fork, auth.user, ctx.params.id ?? "");
  if (!mine.ok) return send(ctx, mine);
  send(ctx, await advanceTransfer(auth.fork, mine.transfer.id, { sign: true }));
});

get("/api/web3/cctp/sources", async (ctx) => {
  const auth = await requireUser(ctx);
  if (!auth) return;
  send(ctx, fundingSources());
});

post("/api/web3/cctp/fund/steps", async (ctx) => {
  const auth = await requireUser(ctx);
  if (!auth) return;
  const body = await parseJsonBody<Record<string, unknown>>(ctx.req, ctx.res);
  if (!body) return;
  send(ctx, await fundingSteps(auth.user, { source: body.source, amount: body.amount, from: body.from }));
});

post("/api/web3/cctp/fund", async (ctx) => {
  const auth = await requireUser(ctx);
  if (!auth) return;
  const body = await parseJsonBody<Record<string, unknown>>(ctx.req, ctx.res);
  if (!body) return;
  send(ctx, await recordFunding(auth.fork, auth.user, { source: body.source, txHash: body.txHash }));
});

get("/api/web3/cctp/fundings", async (ctx) => {
  const auth = await requireUser(ctx);
  if (!auth) return;
  send(ctx, await listFundings(auth.fork, auth.user));
});
