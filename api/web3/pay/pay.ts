/**
 * Player-to-player USDC: pay someone, ask someone for money, and split a
 * game's cost (court fee, balls) across everyone who joined it.
 *
 * Money only ever moves from the payer's own wallet, and the payer pays no
 * gas: paying builds an EIP-3009 authorization for exactly that transfer
 * (wallet/authorization.ts) and opens a Circle challenge for it
 * (wallet/signature.ts); the browser signs it with the player's PIN and
 * posts the signature to confirmPayment, which has the relayer submit it
 * (relayer/submit.ts) and marks the row paid once the transfer is mined. The
 * authorization names the payee and the amount, so the relayer can send
 * that transfer and nothing else.
 *
 * Eligibility: a signature is only requested from adults and guardians (a
 * minor's wallet is receive-and-hold). A minor may be paid. Asking for
 * money is limited the same way as paying, so a minor never appears on the
 * asking side of a money flow either.
 */

import { LockMode } from "@mikro-orm/core";
import type { EntityManager } from "@mikro-orm/postgresql";
import { getAddress, isAddress, type Address } from "viem";
import { Game } from "../../entities/Game.js";
import { GameParticipant } from "../../entities/GameParticipant.js";
import { User } from "../../entities/User.js";
import { fail, type Failure } from "../../failure.js";
import { notify } from "../../social/notifications.js";
import { isUuid } from "../../validate.js";
import { parseUsdc, usd } from "../usd.js";
import { RELAY_STATUS, relay, relayOutcome } from "../relayer/submit.js";
import {
  authorizationArgs, authorizationOf, authorizationTypedData, newAuthorization, usdcAuthorizationAbi, usdcDomain,
} from "../wallet/authorization.js";
import { defaultChainId, walletClientFor } from "../wallet/networks.js";
import { mayTransact } from "../wallet/service.js";
import { acceptSignature, requestSignature } from "../wallet/signature.js";
import { Payment } from "./Payment.js";

export const PAY_STATUS: Record<string, number> = {
  USER_NOT_FOUND: 404,
  GAME_NOT_FOUND: 404,
  PAYMENT_NOT_FOUND: 404,
  NOT_ELIGIBLE: 403,
  NOT_IN_GAME: 403,
  NO_WALLET: 409,
  PAYMENT_STATE: 409,
  LOW_BALANCE: 409,
  INELIGIBLE: 403,
  SIGNATURE_NOT_FOUND: 404,
  SIGNATURE_MISMATCH: 422,
  CIRCLE_FAILED: 502,
  ...RELAY_STATUS,
};

/** How long confirmPayment waits for the transfer to be mined before answering "pending". */
const MINED_WAIT_MS = 20_000;

const MIN_AMOUNT = 10_000n; // $0.01
const MAX_AMOUNT = 500_000_000n; // $500
const NOTE_MAX = 80;
const MAX_SPLIT = 30;

function walletOf(user: User): Address | null {
  const raw = user.walletAddress?.trim() ?? "";
  return isAddress(raw) ? getAddress(raw) : null;
}

function parseAmount(raw: unknown): bigint | Failure {
  const amount = parseUsdc(raw);
  if (amount === null || amount < MIN_AMOUNT || amount > MAX_AMOUNT) {
    return fail("VALIDATION_ERROR", `Amount must be between ${usd(MIN_AMOUNT)} and ${usd(MAX_AMOUNT)}.`);
  }
  return amount;
}

function parseNote(raw: unknown): string | null | Failure {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string" || raw.trim().length > NOTE_MAX) {
    return fail("VALIDATION_ERROR", `A note is text of at most ${NOTE_MAX} characters.`);
  }
  return raw.trim() || null;
}

const isFailure = (x: unknown): x is Failure =>
  typeof x === "object" && x !== null && (x as { ok?: unknown }).ok === false;

/** "$3.00 · Court fee": the line a money notification carries. */
const detailOf = (p: Payment) => (p.note ? `${usd(BigInt(p.amount))} · ${p.note}` : usd(BigInt(p.amount)));

function person(u: User) {
  return { id: u.id, name: u.name ?? null, avatarUrl: u.avatarUrl ?? null };
}

/** The payment as the viewer sees it: who the other side is, and which way it goes. */
export function paymentView(p: Payment, viewer: User) {
  const out = p.payer.id === viewer.id;
  return {
    id: p.id,
    direction: out ? "out" : "in",
    other: person(out ? p.payee : p.payer),
    amountUsdc: usd(BigInt(p.amount)),
    note: p.note ?? null,
    status: p.status,
    game: p.game ? { id: p.game.id, sport: p.game.sport } : null,
    chainId: p.chainId ?? null,
    txHash: p.txHash ?? null,
    createdAt: p.createdAt.toISOString(),
    paidAt: p.paidAt?.toISOString() ?? null,
  };
}

async function loadPayment(em: EntityManager, id: string): Promise<Payment | null> {
  if (!isUuid(id)) return null;
  return em.findOne(Payment, { id }, { populate: ["payer", "payee", "game"] });
}

// ── requests ──────────────────────────────────────────────────────────

/**
 * Ask one person for money ({ userId, amount, note }), or split a cost across
 * a game ({ gameId, total, note }): everyone who joined, the asker included if
 * they joined, owes an equal share, and everyone but the asker gets a request.
 */
export async function requestPayment(em: EntityManager, requester: User, body: Record<string, unknown>) {
  if (!mayTransact(requester)) return fail("NOT_ELIGIBLE", "Payments are open to adults and guardians only.");
  if (!walletOf(requester)) return fail("NO_WALLET", "Set up your wallet first, so there is somewhere to pay you.");
  const note = parseNote(body.note);
  if (isFailure(note)) return note;

  let payers: User[];
  let amount: bigint;
  let game: Game | null = null;

  if (typeof body.gameId === "string") {
    if (!isUuid(body.gameId)) return fail("GAME_NOT_FOUND", "That game does not exist.");
    game = await em.findOne(Game, { id: body.gameId });
    if (!game) return fail("GAME_NOT_FOUND", "That game does not exist.");
    const seats = await em.find(GameParticipant, { game, status: "joined" }, { populate: ["user"] });
    const joined = seats.map((s) => s.user);
    const iJoined = joined.some((u) => u.id === requester.id);
    if (!iJoined && game.host.id !== requester.id) {
      return fail("NOT_IN_GAME", "Only the host and players can split this game's costs.");
    }
    payers = joined.filter((u) => u.id !== requester.id);
    if (!payers.length) return fail("VALIDATION_ERROR", "Nobody else has joined yet.");
    if (payers.length > MAX_SPLIT) return fail("VALIDATION_ERROR", `A split covers at most ${MAX_SPLIT} people.`);
    const total = parseAmount(body.total);
    if (isFailure(total)) return total;
    amount = total / BigInt(joined.length);
    if (amount < MIN_AMOUNT) return fail("VALIDATION_ERROR", "Each share would be under a cent.");
  } else {
    const id = typeof body.userId === "string" ? body.userId : "";
    const payer = isUuid(id) ? await em.findOne(User, { id }) : null;
    if (!payer) return fail("USER_NOT_FOUND", "That person does not exist.");
    if (payer.id === requester.id) return fail("VALIDATION_ERROR", "You can't ask yourself for money.");
    const a = parseAmount(body.amount);
    if (isFailure(a)) return a;
    payers = [payer];
    amount = a;
  }

  const rows = payers.map((payer) => {
    const p = new Payment();
    p.payer = payer;
    p.payee = requester;
    p.amount = amount;
    p.note = note;
    p.game = game;
    p.status = "requested";
    p.wasRequest = true;
    em.persist(p);
    return p;
  });
  await em.flush();
  for (const p of rows) {
    await notify(em, { recipient: p.payer, actor: requester, kind: "pay_request", game, detail: detailOf(p) });
  }
  return { ok: true as const, amountUsdc: usd(amount), requests: rows.map((p) => paymentView(p, requester)) };
}

// ── paying ────────────────────────────────────────────────────────────

/**
 * Start paying: a request ({ requestId }) or a direct send ({ userId,
 * amount, note }). Builds the authorization for the transfer and opens the
 * signing challenge; the browser signs and posts the signature to
 * confirmPayment. Nothing moves, and nothing can, until then.
 */
export async function startPayment(em: EntityManager, payer: User, body: Record<string, unknown>) {
  if (!mayTransact(payer)) return fail("NOT_ELIGIBLE", "Payments are open to adults and guardians only.");
  let p: Payment;
  if (typeof body.requestId === "string") {
    const found = await loadPayment(em, body.requestId);
    if (!found || found.payer.id !== payer.id) return fail("PAYMENT_NOT_FOUND", "No such request.");
    if (found.status !== "requested" && found.status !== "pending") {
      return fail("PAYMENT_STATE", `This request is already ${found.status}.`);
    }
    if (found.txHash) return fail("PAYMENT_STATE", "This payment is already on its way.");
    p = found;
  } else {
    const id = typeof body.userId === "string" ? body.userId : "";
    const payee = isUuid(id) ? await em.findOne(User, { id }) : null;
    if (!payee) return fail("USER_NOT_FOUND", "That person does not exist.");
    if (payee.id === payer.id) return fail("VALIDATION_ERROR", "You can't pay yourself.");
    const amount = parseAmount(body.amount);
    if (isFailure(amount)) return amount;
    const note = parseNote(body.note);
    if (isFailure(note)) return note;
    p = new Payment();
    p.payer = payer;
    p.payee = payee;
    p.amount = amount;
    p.note = note;
  }

  const from = walletOf(payer);
  if (!from) return fail("NO_WALLET", "Set up your wallet first.");
  const to = walletOf(p.payee);
  if (!to) return fail("NO_WALLET", `${p.payee.name ?? "They"} hasn't set up a wallet yet.`);
  const chainId = defaultChainId();
  const usdc = await usdcDomain(chainId);
  if (!usdc.ok) return usdc;
  const value = BigInt(p.amount);
  const short = await shortfall(chainId, usdc.domain.verifyingContract, from, value);
  if (isFailure(short)) return short;
  if (short > 0n) return fail("LOW_BALANCE", `You need ${usd(short)} more to pay this.`);

  const requested = await requestSignature(em, payer, {
    kind: "payment",
    typedData: authorizationTypedData("transfer", usdc.domain, newAuthorization({ from, to, value })),
    memo: `Pay ${p.payee.name ?? "player"} ${usd(value)}`,
  });
  if (!requested.ok) {
    if (requested.error.code === "INELIGIBLE") return fail("NOT_ELIGIBLE", requested.error.message);
    return requested;
  }
  p.status = "pending";
  p.signatureId = requested.signatureId;
  p.chainId = chainId;
  em.persist(p);
  await em.flush();
  return { ok: true as const, payment: paymentView(p, payer), challenge: requested.challenge };
}

/** How much more USDC `account` needs to send `value`; 0 when it has enough. */
export async function shortfall(chainId: number, usdc: Address, account: Address, value: bigint): Promise<bigint | Failure> {
  const chain = walletClientFor(chainId);
  if (!chain.ok) return fail("NOT_CONFIGURED", "Payments are not configured on this server.");
  try {
    const balance = await chain.client.readContract({
      address: usdc, abi: usdcAuthorizationAbi, functionName: "balanceOf", args: [account],
    });
    return balance >= value ? 0n : value - balance;
  } catch {
    return fail("CHAIN_UNAVAILABLE", "Could not read your balance. Try again.");
  }
}

/** Where a payment goes when its transfer did not happen. */
function revert(p: Payment) {
  p.status = p.wasRequest ? "requested" : "cancelled";
  p.signatureId = null;
  p.txHash = null;
}

/**
 * Finish a payment. With { signature } (what the browser's PIN screen
 * returned) the relayer submits the transfer; then, and on any later call,
 * the transfer's receipt decides: paid once mined (and the payee is told),
 * back to "requested" (or cancelled) if it failed, unchanged while it is
 * still on its way.
 */
export async function confirmPayment(em: EntityManager, payer: User, id: string, body: Record<string, unknown> = {}) {
  const p = await loadPayment(em, id);
  if (!p || p.payer.id !== payer.id) return fail("PAYMENT_NOT_FOUND", "No such payment.");
  if (p.status !== "pending") return { ok: true as const, payment: paymentView(p, payer) };

  if (!p.txHash && body.signature !== undefined) {
    const signed = await acceptSignature(em, payer, { signatureId: p.signatureId, kind: "payment", signature: body.signature });
    if (!signed.ok) return signed;
    const usdc = signed.signed.typedData.domain.verifyingContract;
    // The row lock makes two confirms of one payment send one transfer.
    const sent = await em.transactional(async (tx) => {
      const row = await tx.findOneOrFail(Payment, { id: p.id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
      // Locking a row this request already loaded does not reread it.
      await tx.refresh(row);
      if (row.status !== "pending" || row.txHash) return null;
      const r = await relay(tx, payer, {
        kind: "payment",
        address: usdc,
        abi: usdcAuthorizationAbi,
        functionName: "transferWithAuthorization",
        args: authorizationArgs(authorizationOf(signed.signed.typedData), signed.signed.signature),
      });
      if (r.ok) row.txHash = r.hash;
      else if (r.error.code === "RELAY_REVERTED") revert(row);
      return r;
    });
    await em.refresh(p);
    if (sent && !sent.ok) {
      if (sent.error.code === "RELAY_REVERTED") return fail("PAYMENT_STATE", "The payment didn't go through. Check your balance and try again.");
      return sent;
    }
  }
  const recorded = await recordOutcome(em, p, MINED_WAIT_MS);
  if (recorded) return recorded;
  return { ok: true as const, payment: paymentView(p, payer) };
}

/**
 * Read the receipt of a payment's transfer, waiting up to `waitMs`, and
 * write what it says. Returns a failure only when the chain cannot be read.
 */
async function recordOutcome(em: EntityManager, p: Payment, waitMs: number): Promise<Failure | null> {
  if (p.status !== "pending" || !p.txHash) return null;
  const mined = await relayOutcome(p.txHash as `0x${string}`, { kind: "payment", waitMs });
  if (!mined.ok) return mined;
  if (mined.outcome.state === "confirmed") {
    p.status = "paid";
    p.paidAt = new Date();
    await em.flush();
    await notify(em, { recipient: p.payee, actor: p.payer, kind: "paid", game: p.game ?? null, detail: detailOf(p) });
  } else if (mined.outcome.state === "reverted") {
    revert(p);
    await em.flush();
  }
  return null;
}

/** The payer turns a request down. */
export async function declinePayment(em: EntityManager, payer: User, id: string) {
  const p = await loadPayment(em, id);
  if (!p || p.payer.id !== payer.id) return fail("PAYMENT_NOT_FOUND", "No such request.");
  if (p.status !== "requested") return fail("PAYMENT_STATE", `This request is ${p.status}.`);
  p.status = "declined";
  await em.flush();
  return { ok: true as const, payment: paymentView(p, payer) };
}

/**
 * Back out: the payee withdraws a request, or the payer abandons a payment
 * they never signed (the PIN screen was closed). A transfer the relayer has
 * already sent cannot be called back; confirmPayment will record it.
 */
export async function cancelPayment(em: EntityManager, user: User, id: string) {
  const p = await loadPayment(em, id);
  if (!p || (p.payer.id !== user.id && p.payee.id !== user.id)) {
    return fail("PAYMENT_NOT_FOUND", "No such payment.");
  }
  if (p.payee.id === user.id && p.status === "requested") {
    p.status = "cancelled";
  } else if (p.payer.id === user.id && p.status === "pending") {
    if (p.txHash) return fail("PAYMENT_STATE", "This payment was already sent.");
    revert(p);
  } else {
    return fail("PAYMENT_STATE", `This payment is ${p.status}.`);
  }
  await em.flush();
  return { ok: true as const, payment: paymentView(p, user) };
}

/**
 * Requests waiting on the viewer, requests they're waiting on, and recent
 * money in and out (after recording any transfer of theirs still in flight). `eligible` says whether this account may move money at
 * all, so the page can leave out actions the server would refuse.
 */
export async function listPayments(em: EntityManager, user: User) {
  const populate = ["payer", "payee", "game"] as const;
  // A transfer sent while its browser went away is recorded here.
  const inFlight = await em.find(Payment, { payer: user, status: "pending", txHash: { $ne: null } }, { populate, limit: 10 });
  for (const p of inFlight) await recordOutcome(em, p, 0);
  const [toPay, waiting, recent] = await Promise.all([
    em.find(Payment, { payer: user, status: { $in: ["requested", "pending"] } }, { populate, orderBy: { createdAt: "DESC" }, limit: 50 }),
    em.find(Payment, { payee: user, status: "requested" }, { populate, orderBy: { createdAt: "DESC" }, limit: 50 }),
    em.find(
      Payment,
      { status: "paid", $or: [{ payer: user }, { payee: user }] },
      { populate, orderBy: { paidAt: "DESC" }, limit: 20 },
    ),
  ]);
  return {
    ok: true as const,
    eligible: mayTransact(user),
    toPay: toPay.map((p) => paymentView(p, user)),
    waiting: waiting.map((p) => paymentView(p, user)),
    recent: recent.map((p) => paymentView(p, user)),
  };
}
