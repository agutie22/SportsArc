/**
 * The user's Circle EVM-TESTNET wallet on every chain it serves (Arc
 * testnet; see networks.ts): wallet creation,
 * user-signed transactions (Circle signs, we broadcast), balances.
 *
 *   POST /api/web3/wallet                   link or start creating the wallet
 *   POST /api/web3/wallet/tx/:id/signed     { signedTransaction } -> broadcast
 *   POST /api/web3/wallet/tx/:id/challenge  fresh userToken/encryptionKey for the
 *                                           same challenge (the token lasts ~1h)
 *   GET  /api/web3/wallet/tx/:id            status; receipt (or a drop) checked if in flight
 *
 * Transactions are built by the feature that needs one (prepareUserTx in
 * service.ts; a withdrawal's burn in cctp/transfer.ts), never from a
 * client-supplied body.
 *
 * A response carrying `challenge` is for the browser's Circle SDK to
 * execute; for a tx, the SDK's result.data.signedTransaction is posted back.
 */

import { get, post, type RouteContext } from "../../router.js";
import { json, parseJsonBody, requireUser, statusFor } from "../../http.js";
import {
  ensureWallet,
  reissueChallenge,
  submitSignedTx,
  txStatus,
} from "./service.js";

const CODES: Record<string, number> = {
  NOT_CONFIGURED: 503,
  INELIGIBLE: 403,
  NO_ARC_WALLET: 409,
  NO_WALLET: 404,
  WALLET_NOT_READY: 409,
  ADDRESS_MISMATCH: 409,
  TX_NOT_FOUND: 404,
  TX_STATE: 409,
  SIGNATURE_MISMATCH: 422,
  ESTIMATE_FAILED: 422,
  GAS_OVER_BLOCK_LIMIT: 422,
  BROADCAST_REJECTED: 422,
  CIRCLE_FAILED: 502,
  CHAIN_UNAVAILABLE: 502,
  CHAIN_MISMATCH: 502,
  CHAIN_UNSUPPORTED: 502,
  CHAIN_NOT_ALLOWED: 422,
  CHALLENGE_CLOSED: 409,
};

function send(ctx: RouteContext, result: { ok: boolean; error?: { code: string } }): void {
  json(ctx.res, statusFor(result, CODES), result);
}

post("/api/web3/wallet", async (ctx) => {
  const auth = await requireUser(ctx);
  if (!auth) return;
  send(ctx, await ensureWallet(auth.fork, auth.user));
});

post("/api/web3/wallet/tx/:id/signed", async (ctx) => {
  const auth = await requireUser(ctx);
  if (!auth) return;
  const body = await parseJsonBody<{ signedTransaction?: unknown }>(ctx.req, ctx.res);
  if (body === null) return;
  send(ctx, await submitSignedTx(auth.fork, auth.user, ctx.params.id, body.signedTransaction));
});

post("/api/web3/wallet/tx/:id/challenge", async (ctx) => {
  const auth = await requireUser(ctx);
  if (!auth) return;
  send(ctx, await reissueChallenge(auth.fork, auth.user, ctx.params.id));
});

get("/api/web3/wallet/tx/:id", async (ctx) => {
  const auth = await requireUser(ctx);
  if (!auth) return;
  send(ctx, await txStatus(auth.fork, auth.user, ctx.params.id));
});
