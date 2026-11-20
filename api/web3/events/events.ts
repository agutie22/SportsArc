/**
 * Paid events on EventVault: the host's terms, players' entries, the
 * host's prize money, the result and a cancel. An event is a Game of kind
 * "event"; its seats are taken here, by entering, not by joining.
 *
 * Nobody but the relayer sends a transaction. Every step a person takes is
 * the same two calls: start* builds what they must sign and opens the PIN
 * challenge (wallet/signature.ts); confirm* takes the signature the browser
 * got back, has the relayer submit the vault call that carries it
 * (relayer/submit.ts), and records how it ended. confirm* with no signature
 * only reads the outcome of a call already sent; timer.ts does the same for
 * calls whose browser went away.
 *
 *   host       setEventTerms, postEventResult, cancelEvent -> confirmAction,
 *              and startPrize -> confirmPrize
 *   player     startEntry -> confirmEntry, startLeave -> confirmLeave
 *
 * EventVault calls the host the `organizer` and whoever funds a prize its
 * `sponsor`; those names stay where the contract's own fields are meant.
 * Sponsors as their own accounts (brands, organizations) do not exist yet:
 * only the host funds a prize.
 *
 * What the server decides, and signs for the vault: who may enter (adults
 * and guardians, while there is room: the EntryPermit), which prize split an
 * event uses (the host's choice at creation: the PrizePermit), and how
 * many players checked in (GameParticipant.checkedInAt inside the check-in
 * window: the count in the Result). Permits never leave the server.
 *
 * A seat in the game exists exactly while an entry is on chain: taken when
 * the register call is sent (so the last seat cannot be signed for twice),
 * given back if that call fails or the player leaves. There is no waitlist.
 *
 * With no chain configured (no EVENT_VAULT_ADDRESS, USDC address or
 * TESTNET_PRIVATE_KEY) every path answers NOT_CONFIGURED instead of throwing.
 */

import { randomBytes } from "node:crypto";
import { LockMode, UniqueConstraintViolationException } from "@mikro-orm/core";
import type { EntityManager } from "@mikro-orm/postgresql";
import { getAddress, isAddress, toHex, type Address, type Hex, type LocalAccount } from "viem";
import { Game } from "../../entities/Game.js";
import { GameParticipant } from "../../entities/GameParticipant.js";
import { User } from "../../entities/User.js";
import { fail, type Failure } from "../../failure.js";
import { checkInWindow } from "../../games/checkin.js";
import { MAX_CAPACITY } from "../../games/lifecycle.js";
import { notify } from "../../social/notifications.js";
import { isUuid, num } from "../../validate.js";
import { publicClient, relayer, web3ChainKey, WEB3_CHAINS } from "../chains.js";
import { contractAddress } from "../contracts.js";
import type { PayoutChoice } from "../gateway/destinations.js";
import { payoutsConfigured, payoutWalletAddress } from "../gateway/payouts.js";
import { gameKey } from "../ids.js";
import { shortfall } from "../pay/pay.js";
import { RELAY_STATUS, relay, relayOutcome, type RelayCall } from "../relayer/submit.js";
import { parseUsdc, usd } from "../usd.js";
import { authorizationOf, authorizationTypedData, newAuthorization, usdcDomain } from "../wallet/authorization.js";
import { mayTransact } from "../wallet/service.js";
import { sponsorFor } from "../../orgs/sponsors.js";
import { acceptSignature, requestSignature, type SignedTypedData, type TypedData } from "../wallet/signature.js";
import { EventEntry } from "./EventEntry.js";
import { EventPrize } from "./EventPrize.js";
import { EventTerms, type EventAction, type EventStatus } from "./EventTerms.js";
import {
  MAX_ENTRY_FEE, MAX_LOCK_SECONDS, MAX_PLACES, MAX_PRIZE, MIN_ENTRY_FEE, MIN_PRIZE, SEAT_ENTERED, SPLIT_PRESETS,
  cancelTypedData, chainStatus, entryDigest, entryTypedData, eventVaultAbi, feeOn, leaveTypedData, prizeDigest,
  prizeShare, resultDeadlineFor, resultTypedData, signEntryPermit, signPrizePermit, signResult, soloTeamKey,
  termsTypedData, validSplit,
  type ChainStatus, type Deployment, type EntryMessage, type EventTermsMessage, type PrizeMessage, type ResultMessage,
} from "./protocol.js";

/** HTTP status per error code, for statusFor() in routes.ts. */
export const EVENT_STATUS: Record<string, number> = {
  GAME_NOT_FOUND: 404,
  ENTRY_NOT_FOUND: 404,
  PRIZE_NOT_FOUND: 404,
  NOT_EVENT: 409,
  NOT_HOST: 403,
  NOT_ELIGIBLE: 403,
  INELIGIBLE: 403,
  NO_WALLET: 409,
  LOW_BALANCE: 409,
  GAME_CLOSED: 409,
  TERMS_LOCKED: 409,
  EVENT_STATE: 409,
  EVENT_BUSY: 409,
  EVENT_FULL: 409,
  REGISTRATION_CLOSED: 409,
  ALREADY_ENTERED: 409,
  NOT_ENTERED: 409,
  NO_PRIZE: 409,
  CHECKIN_OPEN: 409,
  ENTRY_FAILED: 409,
  PAYOUT_UNAVAILABLE: 409,
  DESTINATION_NOT_FOUND: 404,
  TOO_MANY_DESTINATIONS: 409,
  SIGNATURE_NOT_FOUND: 404,
  SIGNATURE_MISMATCH: 422,
  CIRCLE_FAILED: 502,
  ...RELAY_STATUS,
  NOT_CONFIGURED: 503,
};

/** How long a confirm waits for its call to be mined before answering with it still in flight. */
const MINED_WAIT_MS = 20_000;

/**
 * An event needs this long before its start when its terms are set, and a
 * player this long before registration closes when they enter or leave: the
 * PIN screen and a block have to fit in before the vault's own clock says no.
 */
const OPEN_MARGIN_S = 120;
const CLOSE_MARGIN_S = 30;

const notConfigured = () =>
  fail("NOT_CONFIGURED", "Paid events are not available: EventVault is not configured on this server.");

const nowSeconds = () => Math.floor(Date.now() / 1000);
const seconds = (d: Date) => BigInt(Math.floor(d.getTime() / 1000));

const isFailure = (x: unknown): x is Failure =>
  typeof x === "object" && x !== null && (x as { ok?: unknown }).ok === false;

// ── configuration ─────────────────────────────────────────────────────

export function eventDeployment(): Deployment | null {
  const vault = contractAddress("eventVault");
  if (!vault) return null;
  return { chainId: WEB3_CHAINS[web3ChainKey()].id, vault: getAddress(vault) };
}

export interface EventConfig {
  deployment: Deployment;
  /** The server key: signs permits and results, and is the relayer. */
  signer: LocalAccount;
}

/** Everything needed to act: the deployment and the server key. */
export function eventConfig(): EventConfig | null {
  const d = eventDeployment();
  const client = relayer();
  if (!d || !client || !contractAddress("usdc")) return null;
  return { deployment: d, signer: client.account };
}

export interface VaultSettings {
  feeBps: number;
  gasFee: bigint;
  /** Seconds a posted result can still be corrected. */
  correctionWindow: number;
  payoutRouter: Address;
}

const settingsOf = new Map<string, VaultSettings>();

/** The vault's deploy-time settings, read once per process; null while the chain cannot be read. */
export async function vaultSettings(d: Deployment): Promise<VaultSettings | null> {
  const key = `${d.chainId}:${d.vault}`;
  const known = settingsOf.get(key);
  if (known) return known;
  try {
    const client = publicClient();
    const read = { address: d.vault, abi: eventVaultAbi } as const;
    const [feeBps, gasFee, correctionWindow, payoutRouter] = await Promise.all([
      client.readContract({ ...read, functionName: "FEE_BPS" }),
      client.readContract({ ...read, functionName: "GAS_FEE" }),
      client.readContract({ ...read, functionName: "CORRECTION_WINDOW" }),
      client.readContract({ ...read, functionName: "payoutRouter" }),
    ]);
    const settings = { feeBps, gasFee, correctionWindow: Number(correctionWindow), payoutRouter: getAddress(payoutRouter) };
    settingsOf.set(key, settings);
    return settings;
  } catch {
    return null;
  }
}

/**
 * Whether a seat's money can be routed to another chain: payouts are
 * configured, and the vault's payout router is this server's payout wallet
 * (otherwise routed money would land somewhere nothing forwards it from).
 */
async function routingReady(d: Deployment): Promise<boolean> {
  const wallet = payoutWalletAddress();
  if (!payoutsConfigured() || !wallet) return false;
  const settings = await vaultSettings(d);
  return Boolean(settings && settings.payoutRouter.toLowerCase() === wallet.toLowerCase());
}

// ── the vault's view of an event ──────────────────────────────────────

const vault = (d: Deployment) => ({ address: d.vault, abi: eventVaultAbi }) as const;

export async function readStatus(d: Deployment, eventKey: Hex): Promise<ChainStatus> {
  return chainStatus(await publicClient().readContract({ ...vault(d), functionName: "status", args: [eventKey] }));
}

export function readEvent(d: Deployment, eventKey: Hex) {
  return publicClient().readContract({ ...vault(d), functionName: "eventOf", args: [eventKey] });
}

async function readSeat(d: Deployment, eventKey: Hex, player: Address) {
  const [state, , , attempt] = await publicClient().readContract({
    ...vault(d), functionName: "seats", args: [eventKey, player],
  });
  return { state, attempt };
}

/** A chain read that may fail, as a result object. */
async function chain<T>(read: () => Promise<T>): Promise<{ ok: true; value: T } | Failure> {
  try {
    return { ok: true, value: await read() };
  } catch {
    return fail("CHAIN_UNAVAILABLE", "The network did not answer. Try again.");
  }
}

// ── people and rows ───────────────────────────────────────────────────

function walletOf(user: User): Address | null {
  const raw = user.walletAddress?.trim() ?? "";
  return isAddress(raw) ? getAddress(raw) : null;
}

function person(u: User) {
  return { id: u.id, name: u.name ?? null, avatarUrl: u.avatarUrl ?? null };
}

export async function findTerms(em: EntityManager, game: Game, d: Deployment): Promise<EventTerms | null> {
  return em.findOne(EventTerms, { game, chainId: d.chainId, vaultAddress: d.vault }, { populate: ["organizer"] });
}

/**
 * Insert a row that has a unique key; if a concurrent request won the race,
 * return that request's row instead. em.insert bypasses the unit of work, so
 * a conflict leaves this fork usable.
 */
async function insertOrFind<T extends object>(em: EntityManager, row: T, find: () => Promise<T | null>): Promise<T | null> {
  try {
    await em.insert(row);
  } catch (err) {
    if (!(err instanceof UniqueConstraintViolationException)) throw err;
  }
  return find();
}

/** The terms as the organizer signs them and createEvent takes them. */
export function termsMessage(terms: EventTerms): EventTermsMessage {
  return {
    eventId: terms.eventKey as Hex,
    organizer: getAddress(terms.organizerAddress),
    entryFee: BigInt(terms.entryFee),
    minEntrants: terms.minEntrants,
    minAttendees: terms.minAttendees,
    startsAt: seconds(terms.startsAt),
    registrationClosesAt: seconds(terms.registrationClosesAt),
    resultDeadline: seconds(terms.resultDeadline),
  };
}

export function entryMessage(terms: EventTerms, entry: EventEntry): EntryMessage {
  return {
    eventId: terms.eventKey as Hex,
    player: getAddress(entry.playerAddress),
    teamKey: entry.teamKey as Hex,
    routed: entry.routed,
    attempt: entry.attempt,
  };
}

function prizeMessage(terms: EventTerms, prize: EventPrize): PrizeMessage {
  return {
    eventId: terms.eventKey as Hex,
    sponsor: getAddress(prize.funderAddress),
    amount: BigInt(prize.amount),
    split: [...(terms.split ?? [])],
    salt: prize.salt as Hex,
  };
}

/** Whether new terms can still be set for this game, and if not, why. */
function closedReason(game: Game): string | null {
  if (game.status === "cancelled") return "This event was cancelled.";
  if (game.status === "played") return "This event already happened.";
  if (game.startsAt.getTime() / 1000 - nowSeconds() < OPEN_MARGIN_S) return "This event starts too soon to open registration.";
  return null;
}

const registrationOpen = (terms: EventTerms) =>
  terms.status === "open" && nowSeconds() < Number(seconds(terms.registrationClosesAt)) - CLOSE_MARGIN_S;

/** Entries that hold a seat. */
const SEATED = ["pending", "entered", "leaving"] as const;

/** Why a request for a signature was refused, in this module's codes. */
function signatureRefused(r: Failure): Failure {
  return r.error.code === "INELIGIBLE" ? fail("NOT_ELIGIBLE", r.error.message) : r;
}

// ── terms ─────────────────────────────────────────────────────────────

function parseSplit(raw: unknown): number[] | null | Failure {
  if (raw === undefined || raw === null || raw === false || raw === "" || raw === "none") return null;
  if (typeof raw === "string" && raw in SPLIT_PRESETS) return [...SPLIT_PRESETS[raw as keyof typeof SPLIT_PRESETS]];
  if (validSplit(raw)) return [...raw];
  return fail(
    "VALIDATION_ERROR",
    `prize is one of ${Object.keys(SPLIT_PRESETS).join(", ")}, or up to ${MAX_PLACES} shares in basis points that sum to 10000.`,
  );
}

/** A whole number in [min, max], or `fallback` when absent. */
function parseCount(raw: unknown, fallback: number, min: number, max: number, name: string): number | Failure {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = num(raw);
  if (n === null || !Number.isInteger(n) || n < min || n > max) {
    return fail("VALIDATION_ERROR", `${name} must be a whole number from ${min} to ${max}.`);
  }
  return n;
}

export interface EventTermsInput {
  /** USDC, e.g. "10" or "2.50"; absent or 0 for an event that is free to enter. */
  entryFee?: unknown;
  /** Fewer registered than this at the start and everyone is refunded. Default 2. */
  minPlayers?: unknown;
  /** Fewer checked in than this and everyone is refunded. Default: more than half of minPlayers. */
  minAttendees?: unknown;
  /** How a prize is split: "winner", "top2", "top3", or basis points per place. Absent: the event takes no prize. */
  prize?: unknown;
}

/**
 * The organizer chooses the event's terms and is asked to sign them. Until
 * that signature is relayed the terms are a draft and can be set again; from
 * then on they are fixed, as the vault fixes them.
 */
export async function setEventTerms(em: EntityManager, user: User, game: Game, body: EventTermsInput) {
  if (game.kind !== "event") return fail("NOT_EVENT", "This game is not a paid event.");
  if (game.host.id !== user.id) return fail("NOT_HOST", "Only the host sets an event's terms.");
  if (!mayTransact(user)) return fail("NOT_ELIGIBLE", "Paid events are open to adults and guardians only.");
  const closed = closedReason(game);
  if (closed) return fail("GAME_CLOSED", closed);
  const cfg = eventConfig();
  if (!cfg) return notConfigured();
  const d = cfg.deployment;
  const wallet = walletOf(user);
  if (!wallet) return fail("NO_WALLET", "Set up your wallet first, so there is somewhere to pay you.");

  const existing = await findTerms(em, game, d);
  if (existing && existing.status !== "draft") return fail("TERMS_LOCKED", "This event's terms are already set.");
  if (existing?.actionTxHash) return fail("EVENT_BUSY", "This event is being created. Give it a moment.");

  const free = body.entryFee === undefined || body.entryFee === null || body.entryFee === "" || Number(body.entryFee) === 0;
  const entryFee = free ? 0n : parseUsdc(body.entryFee);
  if (entryFee === null || (entryFee !== 0n && (entryFee < MIN_ENTRY_FEE || entryFee > MAX_ENTRY_FEE))) {
    return fail("VALIDATION_ERROR", `An entry fee is between ${usd(MIN_ENTRY_FEE)} and ${usd(MAX_ENTRY_FEE)}, or nothing.`);
  }
  const split = parseSplit(body.prize);
  if (isFailure(split)) return split;
  if (entryFee === 0n && !split) {
    return fail("VALIDATION_ERROR", "An event has an entry fee, a prize, or both. With neither it is a pickup game.");
  }
  const capacity = Math.min(game.capacity, MAX_CAPACITY);
  const minEntrants = parseCount(body.minPlayers, Math.min(2, capacity), 1, capacity, "minPlayers");
  if (isFailure(minEntrants)) return minEntrants;
  const minAttendees = parseCount(body.minAttendees, Math.max(1, Math.ceil(minEntrants / 2)), 1, minEntrants, "minAttendees");
  if (isFailure(minAttendees)) return minAttendees;

  const resultDeadline = resultDeadlineFor(game.startsAt, game.durationMinutes);
  if (resultDeadline > BigInt(nowSeconds()) + MAX_LOCK_SECONDS) {
    return fail("VALIDATION_ERROR", "Paid events are only available for games within the next year.");
  }

  let terms = existing;
  if (!terms) {
    const row = new EventTerms();
    row.game = game;
    row.chainId = d.chainId;
    row.vaultAddress = d.vault;
    row.eventKey = gameKey(game.id);
    row.organizer = user;
    row.organizerAddress = wallet;
    row.entryFee = entryFee;
    row.minEntrants = minEntrants;
    row.minAttendees = minAttendees;
    row.startsAt = game.startsAt;
    row.registrationClosesAt = game.startsAt;
    row.resultDeadline = new Date(Number(resultDeadline) * 1000);
    row.split = split;
    terms = await insertOrFind(em, row, () => findTerms(em, game, d));
    if (!terms) throw new Error("events: terms row missing after insert");
    if (terms.status !== "draft" || terms.actionTxHash) return fail("TERMS_LOCKED", "This event's terms are already set.");
  }
  terms.organizer = user;
  terms.organizerAddress = wallet;
  terms.entryFee = entryFee;
  terms.minEntrants = minEntrants;
  terms.minAttendees = minAttendees;
  // Whole seconds, as the vault keeps them.
  terms.startsAt = new Date(Number(seconds(game.startsAt)) * 1000);
  terms.registrationClosesAt = terms.startsAt;
  terms.resultDeadline = new Date(Number(resultDeadline) * 1000);
  terms.split = split;

  const requested = await requestSignature(em, user, {
    kind: SIGNATURE_KIND.create,
    typedData: termsTypedData(d, termsMessage(terms)),
    memo: entryFee ? `Host an event · ${usd(entryFee)} entry` : "Host an event · free entry",
  });
  if (!requested.ok) return signatureRefused(requested);
  setAction(terms, "create", requested.signatureId);
  await em.flush();
  return { ...(await eventStatus(em, game, user)), challenge: requested.challenge };
}

// ── the organizer's actions ───────────────────────────────────────────

const SIGNATURE_KIND: Record<EventAction, string> = {
  create: "event_terms",
  result: "event_result",
  cancel: "event_cancel",
};

function setAction(terms: EventTerms, action: EventAction, signatureId: string, payload: EventTerms["actionPayload"] = null) {
  terms.action = action;
  terms.actionSignatureId = signatureId;
  terms.actionTxHash = null;
  terms.actionPayload = payload;
}

function clearAction(terms: EventTerms) {
  terms.action = null;
  terms.actionSignatureId = null;
  terms.actionTxHash = null;
  terms.actionPayload = null;
}

/** Entries on chain for this event, with each player's seat in the game. */
async function enteredSeats(em: EntityManager, terms: EventTerms, game: Game) {
  const entries = await em.find(EventEntry, { terms, state: { $in: ["entered", "leaving"] } }, { populate: ["user"] });
  const seats = entries.length
    ? await em.find(GameParticipant, { game, user: { $in: entries.map((e) => e.user.id) }, status: "joined" })
    : [];
  const seatOf = new Map(seats.map((s) => [s.user.id, s]));
  return entries.map((entry) => {
    const checkedInAt = seatOf.get(entry.user.id)?.checkedInAt ?? null;
    // checkInToGame only writes it while the window is open; this re-checks.
    return { entry, checkedIn: checkedInAt !== null && checkInWindow(game, checkedInAt.getTime()) === "open" };
  });
}

/**
 * The organizer posts the result, or corrects it while the vault still
 * allows: the placed players in order ({ placements: [userId, ...] }), or
 * nobody for an event with no prize ("it ran"). The server adds how many
 * players checked in; with fewer than the event's minimum nobody can be
 * placed and the event will refund. Only once check-in has closed, so the
 * count cannot change afterwards.
 */
export async function postEventResult(em: EntityManager, user: User, game: Game, body: { placements?: unknown }) {
  const cfg = eventConfig();
  if (!cfg) return notConfigured();
  const d = cfg.deployment;
  const terms = await findTerms(em, game, d);
  if (!terms || terms.organizer.id !== user.id) return fail("NOT_HOST", "Only the host posts an event's result.");
  if (terms.status !== "open" && terms.status !== "posted") return fail("EVENT_STATE", `This event is ${terms.status}.`);
  if (terms.actionTxHash) return fail("EVENT_BUSY", "Something for this event is still on its way. Give it a moment.");
  if (checkInWindow(game) !== "closed") {
    return fail("CHECKIN_OPEN", "A result can be posted once check-in has closed, 15 minutes after the start.");
  }

  const read = await chain(async () => ({ status: await readStatus(d, terms.eventKey as Hex), event: await readEvent(d, terms.eventKey as Hex) }));
  if (!read.ok) return read;
  if (read.value.status !== "open" && read.value.status !== "posted") {
    return fail("EVENT_STATE", `This event is ${read.value.status}; its result can no longer change.`);
  }
  const { prizeTotal, split, revision } = read.value.event;

  const raw = body.placements === undefined || body.placements === null ? [] : body.placements;
  if (!Array.isArray(raw) || raw.some((id) => typeof id !== "string" || !isUuid(id)) || new Set(raw).size !== raw.length) {
    return fail("VALIDATION_ERROR", "placements is a list of different players, first place first.");
  }
  const userIds = raw as string[];
  const seats = await enteredSeats(em, terms, game);
  const attendees = seats.filter((s) => s.checkedIn).length;
  const byUser = new Map(seats.map((s) => [s.entry.user.id, s]));
  const placements: Hex[] = [];
  for (const id of userIds) {
    const seat = byUser.get(id);
    if (!seat) return fail("VALIDATION_ERROR", "Only players who entered can be placed.");
    if (!seat.checkedIn) return fail("VALIDATION_ERROR", `${seat.entry.user.name ?? "A placed player"} did not check in, so cannot be placed.`);
    placements.push(seat.entry.teamKey as Hex);
  }
  if (attendees < terms.minAttendees) {
    if (placements.length) {
      return fail(
        "VALIDATION_ERROR",
        `Only ${attendees} of the ${terms.minAttendees} players this event needs checked in, so it will be refunded and nobody is placed.`,
      );
    }
  } else if (prizeTotal > 0n) {
    if (!placements.length || placements.length > split.length) {
      return fail("VALIDATION_ERROR", `This event's prize pays ${split.length} place${split.length === 1 ? "" : "s"}: place 1 to ${split.length} players.`);
    }
  } else if (placements.length > MAX_PLACES) {
    return fail("VALIDATION_ERROR", `A result lists at most ${MAX_PLACES} places.`);
  }

  const message: ResultMessage = { eventId: terms.eventKey as Hex, placements, attendees, revision };
  const requested = await requestSignature(em, user, {
    kind: SIGNATURE_KIND.result,
    typedData: resultTypedData(d, message),
    memo: placements.length ? "Post the event's result" : "Confirm the event ran",
  });
  if (!requested.ok) return signatureRefused(requested);
  setAction(terms, "result", requested.signatureId, { userIds, attendees });
  await em.flush();
  return {
    ...(await eventStatus(em, game, user)),
    challenge: requested.challenge,
    /** What is being signed: the server's count, and whether the event runs on it. */
    attendees,
    runs: attendees >= terms.minAttendees,
  };
}

/**
 * The organizer cancels. An event that never reached the chain is simply
 * cancelled; one that is open needs the organizer's signature, and then
 * every entry and prize is refundable. Once a result is posted it is too late.
 */
export async function cancelEvent(em: EntityManager, user: User, game: Game) {
  if (game.kind !== "event") return fail("NOT_EVENT", "This game is not a paid event.");
  const d = eventDeployment();
  const terms = d ? await findTerms(em, game, d) : null;
  const signer = terms && terms.status !== "draft" ? terms.organizer : game.host;
  if (signer.id !== user.id) return fail("NOT_HOST", "Only the host cancels an event.");
  if (terms?.actionTxHash) return fail("EVENT_BUSY", "Something for this event is still on its way. Give it a moment.");

  if (!terms || terms.status === "draft") {
    if (game.status === "played") return fail("GAME_CLOSED", "This event already happened.");
    game.status = "cancelled";
    if (terms) clearAction(terms);
    await em.flush();
    return eventStatus(em, game, user);
  }
  if (terms.status !== "open") return fail("EVENT_STATE", `This event is ${terms.status}; it can no longer be cancelled.`);
  if (!d || !eventConfig()) return notConfigured();

  const requested = await requestSignature(em, user, {
    kind: SIGNATURE_KIND.cancel,
    typedData: cancelTypedData(d, terms.eventKey as Hex),
    memo: "Cancel the event and refund everyone",
  });
  if (!requested.ok) return signatureRefused(requested);
  setAction(terms, "cancel", requested.signatureId);
  await em.flush();
  return { ...(await eventStatus(em, game, user)), challenge: requested.challenge };
}

/** The vault call an organizer's signature authorizes. */
async function actionCall(cfg: EventConfig, terms: EventTerms, signed: SignedTypedData): Promise<RelayCall> {
  const d = cfg.deployment;
  const base = { address: d.vault, abi: eventVaultAbi } as const;
  if (terms.action === "create") {
    return { ...base, kind: "event_create", functionName: "createEvent", args: [termsMessage(terms), signed.signature] };
  }
  if (terms.action === "cancel") {
    return { ...base, kind: "event_cancel", functionName: "cancel", args: [terms.eventKey, signed.signature] };
  }
  // The result exactly as the organizer signed it, signed by the server as well.
  const m = signed.typedData.message as { eventId: Hex; placements: Hex[]; attendees: bigint; revision: bigint };
  const message: ResultMessage = {
    eventId: m.eventId, placements: [...m.placements], attendees: Number(m.attendees), revision: Number(m.revision),
  };
  const serverSig = await signResult(cfg.signer, d, message);
  return {
    ...base,
    kind: "event_result",
    functionName: "postResult",
    args: [message.eventId, message.placements, message.attendees, serverSig, signed.signature],
  };
}

/**
 * Finish whatever the organizer was asked to sign. With { signature } the
 * relayer submits it; then, and on any later call, its receipt decides.
 */
export async function confirmAction(em: EntityManager, user: User, game: Game, body: { signature?: unknown } = {}) {
  const cfg = eventConfig();
  if (!cfg) return notConfigured();
  const terms = await findTerms(em, game, cfg.deployment);
  if (!terms || terms.organizer.id !== user.id) return fail("NOT_HOST", "Only the host does that.");

  if (terms.action && !terms.actionTxHash && body.signature !== undefined) {
    const signed = await acceptSignature(em, user, {
      signatureId: terms.actionSignatureId, kind: SIGNATURE_KIND[terms.action], signature: body.signature,
    });
    if (!signed.ok) return signed;
    const call = await actionCall(cfg, terms, signed.signed);
    // The row lock makes two confirms of one action send one call.
    const sent = await em.transactional(async (tx) => {
      const row = await tx.findOneOrFail(EventTerms, { id: terms.id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
      // Locking a row this request already loaded does not reread it.
      await tx.refresh(row);
      if (!row.action || row.actionTxHash) return null;
      const r = await relay(tx, user, call);
      if (r.ok) row.actionTxHash = r.hash;
      else if (r.error.code === "RELAY_REVERTED") clearAction(row);
      return r;
    });
    await em.refresh(terms);
    if (sent && !sent.ok) return sent;
  }
  const recorded = await recordAction(em, cfg.deployment, terms, MINED_WAIT_MS);
  if (recorded) return recorded;
  return eventStatus(em, game, user);
}

/** Tell everyone holding an entry something about the event. */
async function tellEntrants(
  em: EntityManager,
  terms: EventTerms,
  n: { kind: "event_result" | "event_off"; detail?: (entry: EventEntry) => string; actor?: User | null },
) {
  const entries = await em.find(EventEntry, { terms, state: { $in: ["entered", "leaving"] } }, { populate: ["user"] });
  for (const entry of entries) {
    await notify(em, { recipient: entry.user, actor: n.actor ?? null, kind: n.kind, game: terms.game, detail: n.detail?.(entry) ?? null });
  }
}

/** "Your $10.00 is on its way back.", or nothing for an event that was free to enter. */
export function refundLine(terms: EventTerms): string {
  return BigInt(terms.entryFee) > 0n ? ` Your ${usd(BigInt(terms.entryFee))} is on its way back.` : "";
}

/**
 * Read the receipt of the organizer's call in flight, waiting up to
 * `waitMs`, and write what it says. Returns a failure only when the chain
 * cannot be read. `terms.game` must be loaded.
 */
export async function recordAction(em: EntityManager, d: Deployment, terms: EventTerms, waitMs: number): Promise<Failure | null> {
  if (!terms.action || !terms.actionTxHash) return null;
  const action = terms.action;
  const hash = terms.actionTxHash as Hex;
  const mined = await relayOutcome(hash, { kind: `event_${action}`, waitMs });
  if (!mined.ok) return mined;
  if (mined.outcome.state === "pending") return null;
  const payload = terms.actionPayload ?? null;
  clearAction(terms);
  if (mined.outcome.state === "reverted") {
    await em.flush();
    return null;
  }

  if (action === "create") {
    terms.status = "open";
    terms.createTxHash = hash;
    await em.flush();
  } else if (action === "result") {
    const first = terms.status !== "posted";
    terms.status = "posted";
    terms.placements = payload?.userIds ?? [];
    terms.attendees = payload?.attendees ?? 0;
    terms.resultTxHash = hash;
    const finalAt = await chain(() => publicClient().readContract({ ...vault(d), functionName: "finalAt", args: [terms.eventKey as Hex] }));
    if (finalAt.ok && finalAt.value > 0n) terms.finalAt = new Date(Number(finalAt.value) * 1000);
    await em.flush();
    if (first) await tellEntrants(em, terms, { kind: "event_result", actor: terms.organizer });
  } else {
    terms.status = "cancelled";
    terms.cancelTxHash = hash;
    const game = terms.game;
    if (game.status !== "played") game.status = "cancelled";
    await em.flush();
    await tellEntrants(em, terms, { kind: "event_off", detail: () => `The host cancelled.${refundLine(terms)}` });
  }
  return null;
}

// ── entries ───────────────────────────────────────────────────────────

/** Give `user` a seat in the game, inside the transaction that holds its row lock. */
async function holdSeat(tx: EntityManager, game: Game, user: User, joined: number): Promise<void> {
  const seat = await tx.findOne(GameParticipant, { game, user });
  if (seat) {
    seat.status = "joined";
    seat.joinedAt = new Date();
    seat.checkedInAt = null;
    seat.removedAt = null;
  } else {
    const row = new GameParticipant();
    row.game = game;
    row.user = user;
    row.status = "joined";
    tx.persist(row);
  }
  if (joined + 1 >= game.capacity && game.status === "open") game.status = "full";
}

/** Give the seat back: the entry failed, or the player left. */
async function releaseSeat(em: EntityManager, game: Game, user: User): Promise<void> {
  const seat = await em.findOne(GameParticipant, { game, user });
  if (seat && seat.status === "joined") {
    seat.status = "cancelled";
    seat.cohost = false;
  }
  if (game.status === "full") game.status = "open";
  await em.flush();
}

/**
 * Start entering: checks that this player may, builds the Entry and what
 * pays for it, and opens the PIN challenge. With an entry fee the player
 * signs a USDC authorization for exactly the fee, payable only to the vault,
 * whose nonce is the Entry's digest; with none they sign the Entry itself.
 *
 * `payout` is where the seat's money should go back: null for the player's
 * wallet, a PayoutChoice for another chain.
 */
export async function startEntry(em: EntityManager, user: User, game: Game, payout: PayoutChoice | null = null) {
  if (game.kind !== "event") return fail("NOT_EVENT", "This game is not a paid event.");
  const cfg = eventConfig();
  if (!cfg) return notConfigured();
  const d = cfg.deployment;
  const terms = await findTerms(em, game, d);
  if (!terms || terms.status === "draft") return fail("EVENT_STATE", "Registration for this event has not opened yet.");
  if (terms.status !== "open" || game.status === "cancelled" || game.status === "played") {
    return fail("GAME_CLOSED", "This event is no longer taking entries.");
  }
  if (!registrationOpen(terms)) return fail("REGISTRATION_CLOSED", "Registration for this event has closed.");
  if (!mayTransact(user)) return fail("NOT_ELIGIBLE", "Paid events are open to adults and guardians only.");
  const wallet = walletOf(user);
  if (!wallet) return fail("NO_WALLET", "Set up your wallet before entering.");

  const existing = await em.findOne(EventEntry, { terms, user });
  if (existing && (SEATED as readonly string[]).includes(existing.state)) {
    return fail("ALREADY_ENTERED", "You are already in this event.");
  }
  const joined = await em.count(GameParticipant, { game, status: "joined" });
  if (joined >= game.capacity) return fail("EVENT_FULL", "This event is full. A seat opens if someone leaves.");
  if (payout && !(await routingReady(d))) {
    return fail("PAYOUT_UNAVAILABLE", "Payouts to other networks are not available right now. Choose your SportsArc wallet.");
  }

  const seat = await chain(() => readSeat(d, terms.eventKey as Hex, wallet));
  if (!seat.ok) return seat;
  if (seat.value.state === SEAT_ENTERED) return fail("ALREADY_ENTERED", "That wallet is already in this event.");
  const message: EntryMessage = {
    eventId: terms.eventKey as Hex,
    player: wallet,
    teamKey: soloTeamKey(wallet),
    routed: payout !== null,
    attempt: seat.value.attempt,
  };

  const fee = BigInt(terms.entryFee);
  let typedData: TypedData;
  if (fee > 0n) {
    const usdc = await usdcDomain(d.chainId);
    if (!usdc.ok) return usdc;
    const short = await shortfall(d.chainId, usdc.domain.verifyingContract, wallet, fee);
    if (isFailure(short)) return short;
    if (short > 0n) return fail("LOW_BALANCE", `You need ${usd(short)} more to enter.`);
    typedData = authorizationTypedData(
      "receive", usdc.domain, newAuthorization({ from: wallet, to: d.vault, value: fee, nonce: entryDigest(d, message) }),
    );
  } else {
    typedData = entryTypedData(d, message);
  }
  const requested = await requestSignature(em, user, {
    kind: "event_entry",
    typedData,
    memo: fee > 0n ? `Enter the ${game.sport} event · ${usd(fee)}` : `Enter the ${game.sport} event`,
  });
  if (!requested.ok) return signatureRefused(requested);

  let entry = existing;
  if (!entry) {
    const row = new EventEntry();
    row.terms = terms;
    row.user = user;
    row.playerAddress = wallet;
    row.teamKey = message.teamKey;
    entry = await insertOrFind(em, row, () => em.findOne(EventEntry, { terms, user }));
    if (!entry) throw new Error("events: entry row missing after insert");
    if ((SEATED as readonly string[]).includes(entry.state)) return fail("ALREADY_ENTERED", "You are already in this event.");
  }
  entry.playerAddress = wallet;
  entry.teamKey = message.teamKey;
  entry.routed = message.routed;
  entry.payoutChainKey = payout?.chainKey ?? null;
  entry.payoutAddress = payout?.address ?? null;
  entry.attempt = message.attempt;
  entry.state = "signing";
  entry.signatureId = requested.signatureId;
  entry.txHash = null;
  entry.leaveSignatureId = null;
  entry.leaveTxHash = null;
  entry.enteredAt = null;
  entry.leftAt = null;
  entry.payout = null;
  entry.payoutKind = null;
  entry.payoutTxHash = null;
  entry.settledAt = null;
  await em.flush();
  return { ...(await eventStatus(em, game, user)), challenge: requested.challenge };
}

/** What the player's signature must be for, given the entry it is meant to pay for. */
function entryPayment(d: Deployment, terms: EventTerms, message: EntryMessage, signed: SignedTypedData) {
  if (BigInt(terms.entryFee) === 0n) return { ok: true as const, validAfter: 0n, validBefore: 0n };
  const auth = authorizationOf(signed.typedData);
  const bound = auth.nonce === entryDigest(d, message) && auth.value === BigInt(terms.entryFee)
    && auth.to.toLowerCase() === d.vault.toLowerCase() && auth.from.toLowerCase() === message.player.toLowerCase();
  if (!bound) return fail("SIGNATURE_MISMATCH", "That signature is not for this entry. Start again.");
  return { ok: true as const, validAfter: auth.validAfter, validBefore: auth.validBefore };
}

/**
 * Finish entering. With { signature } the server signs the entry's permit
 * (if there is still room) and the relayer registers the player, which
 * takes the fee and holds the seat in one step; then, and on any later
 * call, the receipt decides whether the seat stays.
 */
export async function confirmEntry(em: EntityManager, user: User, game: Game, body: { signature?: unknown } = {}) {
  const cfg = eventConfig();
  if (!cfg) return notConfigured();
  const d = cfg.deployment;
  const terms = await findTerms(em, game, d);
  const entry = terms ? await em.findOne(EventEntry, { terms, user }, { populate: ["user"] }) : null;
  if (!terms || !entry) return fail("ENTRY_NOT_FOUND", "You have not started entering this event.");

  if (entry.state === "signing" && body.signature !== undefined) {
    if (!registrationOpen(terms)) return fail("REGISTRATION_CLOSED", "Registration for this event has closed.");
    const signed = await acceptSignature(em, user, { signatureId: entry.signatureId, kind: "event_entry", signature: body.signature });
    if (!signed.ok) return signed;
    const message = entryMessage(terms, entry);
    const payment = entryPayment(d, terms, message, signed.signed);
    if (!payment.ok) return payment;
    const permit = await signEntryPermit(cfg.signer, d, message);

    // The game's row lock makes the last seat go to one entry, and two confirms of one entry send one call.
    const sent = await em.transactional(async (tx) => {
      const g = await tx.findOneOrFail(Game, { id: game.id }, { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true });
      const row = await tx.findOneOrFail(EventEntry, { id: entry.id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
      await tx.refresh(row);
      if (row.state !== "signing" || row.txHash) return null;
      if (g.status === "cancelled" || g.status === "played") return fail("GAME_CLOSED", "This event is no longer taking entries.");
      const joined = await tx.count(GameParticipant, { game: g, status: "joined" });
      if (joined >= g.capacity) return fail("EVENT_FULL", "This event filled up before you signed. Nothing was charged.");
      const r = await relay(tx, user, {
        kind: "event_entry",
        address: d.vault,
        abi: eventVaultAbi,
        functionName: "register",
        args: [message, permit, signed.signed.signature, payment.validAfter, payment.validBefore],
      });
      if (r.ok) {
        row.state = "pending";
        row.txHash = r.hash;
        await holdSeat(tx, g, user, joined);
      } else if (r.error.code === "RELAY_REVERTED") {
        row.state = "failed";
      }
      return r;
    });
    await em.refresh(entry);
    await em.refresh(game);
    if (sent && !sent.ok) {
      if (sent.error.code === "RELAY_REVERTED") return fail("ENTRY_FAILED", "The entry didn't go through, and nothing was charged. Check your balance and try again.");
      return sent;
    }
  }
  const recorded = await recordEntry(em, terms, entry, MINED_WAIT_MS);
  if (recorded) return recorded;
  if (entry.state === "failed") return fail("ENTRY_FAILED", "The entry didn't go through, and nothing was charged. Try again.");
  return eventStatus(em, game, user);
}

/**
 * Read the receipt of an entry's register call and write what it says: the
 * player is in (and the organizer is told), or the seat is given back.
 * `entry.user` and `terms.game` must be loaded.
 */
export async function recordEntry(em: EntityManager, terms: EventTerms, entry: EventEntry, waitMs: number): Promise<Failure | null> {
  if (entry.state !== "pending" || !entry.txHash) return null;
  const mined = await relayOutcome(entry.txHash as Hex, { kind: "event_entry", waitMs });
  if (!mined.ok) return mined;
  if (mined.outcome.state === "confirmed") {
    entry.state = "entered";
    entry.enteredAt = new Date();
    await em.flush();
    await notify(em, { recipient: terms.organizer.id, actor: entry.user, kind: "join", game: terms.game });
  } else if (mined.outcome.state === "reverted") {
    entry.state = "failed";
    await releaseSeat(em, terms.game, entry.user);
  }
  return null;
}

/**
 * Start leaving, which is only possible while registration is open: the
 * vault pays the fee back in the same call and the seat reopens.
 */
export async function startLeave(em: EntityManager, user: User, game: Game) {
  const cfg = eventConfig();
  if (!cfg) return notConfigured();
  const d = cfg.deployment;
  const terms = await findTerms(em, game, d);
  const entry = terms ? await em.findOne(EventEntry, { terms, user }) : null;
  if (!terms || !entry || entry.state !== "entered") return fail("NOT_ENTERED", "You are not in this event.");
  if (!registrationOpen(terms)) {
    return fail("REGISTRATION_CLOSED", "Registration has closed, so entries can no longer be given back.");
  }
  const requested = await requestSignature(em, user, {
    kind: "event_leave",
    typedData: leaveTypedData(d, { eventId: terms.eventKey as Hex, player: getAddress(entry.playerAddress), attempt: entry.attempt }),
    memo: BigInt(terms.entryFee) > 0n ? `Leave the event · ${usd(BigInt(terms.entryFee))} back` : "Leave the event",
  });
  if (!requested.ok) return signatureRefused(requested);
  entry.leaveSignatureId = requested.signatureId;
  entry.leaveTxHash = null;
  await em.flush();
  return { ...(await eventStatus(em, game, user)), challenge: requested.challenge };
}

/** Finish leaving: the relayer submits the signed Leave; its receipt gives the seat back. */
export async function confirmLeave(em: EntityManager, user: User, game: Game, body: { signature?: unknown } = {}) {
  const cfg = eventConfig();
  if (!cfg) return notConfigured();
  const d = cfg.deployment;
  const terms = await findTerms(em, game, d);
  const entry = terms ? await em.findOne(EventEntry, { terms, user }, { populate: ["user"] }) : null;
  if (!terms || !entry) return fail("NOT_ENTERED", "You are not in this event.");

  if (entry.state === "entered" && entry.leaveSignatureId && body.signature !== undefined) {
    const signed = await acceptSignature(em, user, { signatureId: entry.leaveSignatureId, kind: "event_leave", signature: body.signature });
    if (!signed.ok) return signed;
    const sent = await em.transactional(async (tx) => {
      const row = await tx.findOneOrFail(EventEntry, { id: entry.id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
      await tx.refresh(row);
      if (row.state !== "entered" || row.leaveTxHash) return null;
      const r = await relay(tx, user, {
        kind: "event_leave",
        address: d.vault,
        abi: eventVaultAbi,
        functionName: "leave",
        args: [terms.eventKey, getAddress(row.playerAddress), signed.signed.signature],
      });
      if (r.ok) {
        row.state = "leaving";
        row.leaveTxHash = r.hash;
      } else if (r.error.code === "RELAY_REVERTED") {
        row.leaveSignatureId = null;
      }
      return r;
    });
    await em.refresh(entry);
    if (sent && !sent.ok) return sent;
  }
  const recorded = await recordLeave(em, terms, entry, MINED_WAIT_MS);
  if (recorded) return recorded;
  return eventStatus(em, game, user);
}

/** Read the receipt of a leave call: the seat is given back, or the player is still in. */
export async function recordLeave(em: EntityManager, terms: EventTerms, entry: EventEntry, waitMs: number): Promise<Failure | null> {
  if (entry.state !== "leaving" || !entry.leaveTxHash) return null;
  const mined = await relayOutcome(entry.leaveTxHash as Hex, { kind: "event_leave", waitMs });
  if (!mined.ok) return mined;
  if (mined.outcome.state === "confirmed") {
    const fee = BigInt(terms.entryFee);
    entry.state = "left";
    entry.leftAt = new Date();
    entry.payout = fee.toString();
    entry.payoutKind = fee > 0n ? "refund" : null;
    entry.payoutTxHash = entry.leaveTxHash;
    entry.settledAt = entry.leftAt;
    await releaseSeat(em, terms.game, entry.user);
    await notify(em, { recipient: terms.organizer.id, actor: entry.user, kind: "left", game: terms.game });
  } else if (mined.outcome.state === "reverted") {
    entry.state = "entered";
    entry.leaveSignatureId = null;
    entry.leaveTxHash = null;
    await em.flush();
  }
  return null;
}

// ── prizes ────────────────────────────────────────────────────────────

function prizeView(p: EventPrize) {
  return {
    id: p.id,
    state: p.state,
    amount: BigInt(p.amount).toString(),
    amountUsd: usd(BigInt(p.amount)),
    txHash: p.txHash ?? null,
    returned: p.returned ?? null,
  };
}

/**
 * Start putting up prize money ({ amount }) for an event that takes a prize
 * and is still open: its host, or a sponsor of the event's league season or
 * court (orgs/sponsors.ts sponsorFor: the verified sponsor org's signer,
 * paying from that wallet; the prize is then shown as the org's). The
 * funder signs a USDC authorization for exactly the amount, payable only to
 * the vault, whose nonce is the Prize's digest; the split is the host's.
 */
export async function startPrize(em: EntityManager, user: User, game: Game, body: { amount?: unknown }) {
  if (game.kind !== "event") return fail("NOT_EVENT", "This game is not a paid event.");
  const sponsorOrg = game.host.id === user.id ? null : await sponsorFor(em, user, game);
  if (game.host.id !== user.id && !sponsorOrg) {
    return fail("NOT_HOST", "Only the host, or a sponsor of this league or court, puts up this event's prize.");
  }
  const cfg = eventConfig();
  if (!cfg) return notConfigured();
  const d = cfg.deployment;
  const terms = await findTerms(em, game, d);
  if (!terms || terms.status !== "open") return fail("EVENT_STATE", "This event is not taking prize money.");
  if (!terms.split) return fail("NO_PRIZE", "This event has no prize.");
  if (!mayTransact(user)) return fail("NOT_ELIGIBLE", "Paid events are open to adults and guardians only.");
  const wallet = walletOf(user);
  if (!wallet) return fail("NO_WALLET", "Set up your wallet first.");
  const amount = parseUsdc(body.amount);
  if (amount === null || amount < MIN_PRIZE || amount > MAX_PRIZE) {
    return fail("VALIDATION_ERROR", `A prize contribution is between ${usd(MIN_PRIZE)} and ${usd(MAX_PRIZE)}.`);
  }
  const status = await chain(() => readStatus(d, terms.eventKey as Hex));
  if (!status.ok) return status;
  if (status.value !== "open") return fail("EVENT_STATE", "This event is not taking prize money.");

  const usdc = await usdcDomain(d.chainId);
  if (!usdc.ok) return usdc;
  const short = await shortfall(d.chainId, usdc.domain.verifyingContract, wallet, amount);
  if (isFailure(short)) return short;
  if (short > 0n) return fail("LOW_BALANCE", `You need ${usd(short)} more to fund this prize.`);

  const prize = new EventPrize();
  prize.terms = terms;
  prize.funder = user;
  prize.funderAddress = wallet;
  prize.sponsorOrg = sponsorOrg;
  prize.amount = amount;
  prize.salt = toHex(randomBytes(32));
  const message = prizeMessage(terms, prize);
  const requested = await requestSignature(em, user, {
    kind: "event_prize",
    typedData: authorizationTypedData(
      "receive", usdc.domain, newAuthorization({ from: wallet, to: d.vault, value: amount, nonce: prizeDigest(d, message) }),
    ),
    memo: `Fund the ${game.sport} event's prize${sponsorOrg ? ` for ${sponsorOrg.name}` : ""} · ${usd(amount)}`,
  });
  if (!requested.ok) return signatureRefused(requested);
  prize.signatureId = requested.signatureId;
  em.persist(prize);
  await em.flush();
  return { ...(await eventStatus(em, game, user)), prize: prizeView(prize), challenge: requested.challenge };
}

/** Finish funding a prize: the server signs the permit for the event's split and the relayer funds it. */
export async function confirmPrize(em: EntityManager, user: User, prizeId: string, body: { signature?: unknown } = {}) {
  const cfg = eventConfig();
  if (!cfg) return notConfigured();
  const d = cfg.deployment;
  const prize = isUuid(prizeId)
    ? await em.findOne(EventPrize, { id: prizeId, funder: user }, { populate: ["funder", "terms", "terms.organizer", "terms.game"] })
    : null;
  if (!prize) return fail("PRIZE_NOT_FOUND", "No such prize contribution.");
  const terms = prize.terms;

  if (prize.state === "signing" && body.signature !== undefined) {
    const signed = await acceptSignature(em, user, { signatureId: prize.signatureId, kind: "event_prize", signature: body.signature });
    if (!signed.ok) return signed;
    const message = prizeMessage(terms, prize);
    const auth = authorizationOf(signed.signed.typedData);
    if (auth.nonce !== prizeDigest(d, message) || auth.value !== message.amount || auth.to.toLowerCase() !== d.vault.toLowerCase()) {
      return fail("SIGNATURE_MISMATCH", "That signature is not for this prize. Start again.");
    }
    const permit = await signPrizePermit(cfg.signer, d, message);
    const sent = await em.transactional(async (tx) => {
      const row = await tx.findOneOrFail(EventPrize, { id: prize.id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
      await tx.refresh(row);
      if (row.state !== "signing" || row.txHash) return null;
      const r = await relay(tx, user, {
        kind: "event_prize",
        address: d.vault,
        abi: eventVaultAbi,
        functionName: "fundPrize",
        args: [message, permit, signed.signed.signature, auth.validAfter, auth.validBefore],
      });
      if (r.ok) {
        row.state = "pending";
        row.txHash = r.hash;
      } else if (r.error.code === "RELAY_REVERTED") {
        row.state = "failed";
      }
      return r;
    });
    await em.refresh(prize);
    if (sent && !sent.ok) return sent;
  }
  const recorded = await recordPrize(em, prize, MINED_WAIT_MS);
  if (recorded) return recorded;
  await em.populate(terms.game, ["venue", "host"]);
  return { ...(await eventStatus(em, terms.game, user)), prize: prizeView(prize) };
}

/** Read the receipt of a fundPrize call. `prize.funder`, `terms.organizer` and `terms.game` must be loaded. */
export async function recordPrize(em: EntityManager, prize: EventPrize, waitMs: number): Promise<Failure | null> {
  if (prize.state !== "pending" || !prize.txHash) return null;
  const mined = await relayOutcome(prize.txHash as Hex, { kind: "event_prize", waitMs });
  if (!mined.ok) return mined;
  if (mined.outcome.state === "confirmed") {
    prize.state = "funded";
    prize.fundedAt = new Date();
    await em.flush();
  } else if (mined.outcome.state === "reverted") {
    prize.state = "failed";
    await em.flush();
  }
  return null;
}

// ── views ─────────────────────────────────────────────────────────────

/** Total prize money in the vault for these events, by terms id. */
async function prizeTotals(em: EntityManager, termsIds: string[]): Promise<Map<string, bigint>> {
  const totals = new Map<string, bigint>();
  if (!termsIds.length) return totals;
  const rows = await em.find(EventPrize, { terms: { $in: termsIds }, state: "funded" });
  for (const p of rows) totals.set(p.terms.id, (totals.get(p.terms.id) ?? 0n) + BigInt(p.amount));
  return totals;
}

/** Sponsor orgs with funded money in an event's prize, and how much each. */
async function prizeSponsors(em: EntityManager, termsId: string) {
  const rows = await em.find(EventPrize, { terms: termsId, state: "funded", sponsorOrg: { $ne: null } }, { populate: ["sponsorOrg"] });
  const by = new Map<string, { name: string; slug: string; amount: bigint }>();
  for (const p of rows) {
    const o = p.sponsorOrg!;
    const cur = by.get(o.id) ?? { name: o.name, slug: o.slug, amount: 0n };
    cur.amount += BigInt(p.amount);
    by.set(o.id, cur);
  }
  return [...by.values()].map((x) => ({ name: x.name, slug: x.slug, amountUsd: usd(x.amount) }));
}

/**
 * An event's terms in words, for a tryout page: fee, how many are in, when
 * registration closes. Null when it has no terms yet.
 */
export async function eventSummary(em: EntityManager, game: Game) {
  const d = eventDeployment();
  const terms = d ? await findTerms(em, game, d) : null;
  if (!terms) return null;
  const entrants = await em.count(EventEntry, { terms, state: { $in: ["entered", "leaving"] } });
  return {
    status: terms.status,
    entryFeeUsd: usd(BigInt(terms.entryFee)),
    free: BigInt(terms.entryFee) === 0n,
    entrants,
    capacity: game.capacity,
    registrationClosesAt: terms.registrationClosesAt.toISOString(),
    open: registrationOpen(terms) && game.status !== "cancelled" && game.status !== "played",
  };
}

/** Who holds an entry in an event: entered, or on their way in or out. */
export async function eventRegistrants(em: EntityManager, game: Game): Promise<User[]> {
  const d = eventDeployment();
  const terms = d ? await findTerms(em, game, d) : null;
  if (!terms) return [];
  const rows = await em.find(EventEntry, { terms, state: { $in: [...SEATED] } }, { populate: ["user"] });
  return rows.map((e) => e.user);
}

/** An event's prize in words, for a league season's finals line. Null when it has no terms. */
export async function prizeSummary(em: EntityManager, game: Game) {
  const d = eventDeployment();
  const terms = d ? await findTerms(em, game, d) : null;
  if (!terms) return null;
  const total = (await prizeTotals(em, [terms.id])).get(terms.id) ?? 0n;
  return { status: terms.status, takesPrize: Boolean(terms.split), prizeUsd: usd(total), sponsors: await prizeSponsors(em, terms.id) };
}

function entryView(entry: EventEntry) {
  return {
    state: entry.state,
    payout: entry.payoutChainKey && entry.payoutAddress ? { chain: entry.payoutChainKey, address: entry.payoutAddress } : null,
    /** What the event paid this player back or out, once it has. */
    paid: entry.payout ?? null,
    paidUsd: entry.payout ? usd(BigInt(entry.payout)) : null,
    paidKind: entry.payoutKind ?? null,
  };
}

/**
 * Everything the viewer needs to render an event: its terms and where it
 * stands, the fee the organizer bears, the prize, the result, their own
 * entry, and what they may do next. Reads only the database (and the
 * vault's fixed settings, once per process), so it is cheap to call.
 */
export async function eventStatus(em: EntityManager, game: Game, viewer: User) {
  const d = eventDeployment();
  const configured = eventConfig() !== null;
  const terms = d ? await findTerms(em, game, d) : null;
  const settings = d && terms ? await vaultSettings(d) : null;
  const isHost = (terms && terms.status !== "draft" ? terms.organizer : game.host).id === viewer.id;
  const eligible = mayTransact(viewer);
  // A sponsor of this event's season or court may add to the prize, for their org.
  const sponsorAs = isHost || game.kind !== "event" ? null : await sponsorFor(em, viewer, game);
  const live = game.status !== "cancelled" && game.status !== "played";

  let termsView = null;
  let mine: EventEntry | null = null;
  let seated = 0;
  if (terms) {
    const entries = await em.find(EventEntry, { terms, state: { $in: [...SEATED] } });
    seated = entries.length;
    mine = await em.findOne(EventEntry, { terms, user: viewer });
    const entrants = entries.filter((e) => e.state !== "pending").length;
    const prize = (await prizeTotals(em, [terms.id])).get(terms.id) ?? 0n;
    const fee = BigInt(terms.entryFee);
    const perEntry = settings ? feeOn(fee, settings.feeBps, settings.gasFee) : null;
    const receives = perEntry === null ? null : (fee - perEntry) * BigInt(entrants);

    let result = null;
    if (terms.attendees !== null && terms.attendees !== undefined && terms.placements) {
      const placed = terms.placements.length ? await em.find(User, { id: { $in: terms.placements } }) : [];
      const byId = new Map(placed.map((u) => [u.id, u]));
      const runs = terms.attendees >= terms.minAttendees;
      result = {
        attendees: terms.attendees,
        /** False: too few checked in, so the event refunds instead of paying out. */
        runs,
        finalAt: terms.finalAt?.toISOString() ?? null,
        placements: terms.placements.map((id, i) => {
          const share = runs && terms.split ? prizeShare(prize, terms.split, i + 1) : 0n;
          const u = byId.get(id);
          return { place: i + 1, user: u ? person(u) : { id, name: null, avatarUrl: null }, prize: share.toString(), prizeUsd: usd(share) };
        }),
      };
    }

    termsView = {
      eventKey: terms.eventKey,
      status: terms.status,
      organizer: person(terms.organizer),
      entryFee: fee.toString(),
      entryFeeUsd: usd(fee),
      minPlayers: terms.minEntrants,
      minAttendees: terms.minAttendees,
      registrationClosesAt: terms.registrationClosesAt.toISOString(),
      resultDeadline: terms.resultDeadline.toISOString(),
      /** Basis points per place when the event takes a prize; null when it does not. */
      split: terms.split ?? null,
      entrants,
      /** Players still needed for the event to run. */
      needs: Math.max(0, terms.minEntrants - entrants),
      prize: prize.toString(),
      prizeUsd: usd(prize),
      /** Sponsor orgs whose money is in the prize. */
      sponsors: await prizeSponsors(em, terms.id),
      /** The platform fee, which comes out of what the organizer receives; players pay the entry fee and nothing more. */
      fee: settings && perEntry !== null ? {
        bps: settings.feeBps,
        flat: settings.gasFee.toString(),
        perEntry: perEntry.toString(),
        perEntryUsd: usd(perEntry),
        correctionWindowSeconds: settings.correctionWindow,
      } : null,
      /** What the organizer is paid if the event runs with the players now entered. */
      organizerReceives: receives?.toString() ?? null,
      organizerReceivesUsd: receives === null ? null : usd(receives),
      organizerPaid: terms.organizerPayout ?? null,
      result,
      settledAt: terms.settledAt?.toISOString() ?? null,
      /** Organizer only: what they have been asked to sign that has not finished. */
      pending: isHost && terms.action ? { action: terms.action, sent: Boolean(terms.actionTxHash) } : null,
    };
  }

  const open = Boolean(terms && registrationOpen(terms)) && live;
  const iAmIn = Boolean(mine && (SEATED as readonly string[]).includes(mine.state));
  return {
    ok: true as const,
    configured,
    isEvent: game.kind === "event",
    eligible,
    isHost,
    /** The sponsor org the viewer would fund the prize for, when not the host. */
    sponsorAs: sponsorAs ? { name: sponsorAs.name, slug: sponsorAs.slug } : null,
    chainId: d?.chainId ?? null,
    vault: d?.vault ?? null,
    terms: termsView,
    entry: mine ? entryView(mine) : null,
    can: {
      setTerms: configured && game.kind === "event" && isHost && eligible && (!terms || terms.status === "draft")
        && !terms?.actionTxHash && closedReason(game) === null,
      enter: configured && open && eligible && !iAmIn && seated < game.capacity,
      leave: configured && open && mine?.state === "entered",
      addPrize: configured && live && (isHost || Boolean(sponsorAs)) && eligible && terms?.status === "open" && Boolean(terms.split),
      postResult: configured && isHost && Boolean(terms) && (terms?.status === "open" || terms?.status === "posted")
        && checkInWindow(game) === "closed",
      cancel: isHost && live && (!terms || terms.status === "draft" || terms.status === "open"),
    },
  };
}

/**
 * Event terms for a page of games, for the game list: what it costs to
 * enter, the prize, how full it is, and whether the viewer is in. A draft
 * shows only to its organizer.
 */
export async function termsForGames(em: EntityManager, gameIds: string[], viewer: User) {
  const d = eventDeployment();
  const configured = eventConfig() !== null;
  if (!d || !gameIds.length) return { ok: true as const, configured, terms: {} };
  const rows = await em.find(EventTerms, { game: { $in: gameIds }, chainId: d.chainId, vaultAddress: d.vault });
  const shown = rows.filter((r) => r.status !== "draft" || r.organizer.id === viewer.id);
  const ids = shown.map((r) => r.id);
  const entries = ids.length ? await em.find(EventEntry, { terms: { $in: ids }, state: { $in: [...SEATED] } }) : [];
  const prizes = await prizeTotals(em, ids);
  const terms: Record<string, {
    status: EventStatus; entryFeeUsd: string; free: boolean; prizeUsd: string | null; takesPrize: boolean;
    entrants: number; minPlayers: number; mine: string | null; place: number | null; finalAt: string | null;
  }> = {};
  for (const r of shown) {
    const own = entries.filter((e) => e.terms.id === r.id);
    const prize = prizes.get(r.id) ?? 0n;
    const placedAt = r.placements?.indexOf(viewer.id) ?? -1;
    terms[r.game.id] = {
      status: r.status,
      entryFeeUsd: usd(BigInt(r.entryFee)),
      free: BigInt(r.entryFee) === 0n,
      prizeUsd: prize > 0n ? usd(prize) : null,
      takesPrize: Boolean(r.split),
      entrants: own.filter((e) => e.state !== "pending").length,
      minPlayers: r.minEntrants,
      mine: own.find((e) => e.user.id === viewer.id)?.state ?? null,
      /** 1-based place when this viewer was placed; null otherwise. */
      place: placedAt >= 0 ? placedAt + 1 : null,
      finalAt: r.finalAt?.toISOString() ?? null,
    };
  }
  return { ok: true as const, configured, terms };
}

const PLACE = ["", "1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th"];

/**
 * Money this person has moved through events, for the payments page:
 * an entry fee, a refund, a prize they won or put up, and a host payout.
 */
export async function eventActivity(em: EntityManager, user: User) {
  const entries = await em.find(
    EventEntry,
    { user, state: { $in: ["entered", "pending", "leaving", "left"] } },
    { populate: ["terms", "terms.game"], orderBy: { updatedAt: "DESC" }, limit: 40 },
  );
  const prizes = await em.find(
    EventPrize,
    { funder: user, state: { $in: ["pending", "funded"] } },
    { populate: ["terms", "terms.game"], orderBy: { createdAt: "DESC" }, limit: 20 },
  );
  const hosted = await em.find(
    EventTerms,
    { organizer: user, organizerPayout: { $ne: null } },
    { populate: ["game"], orderBy: { settledAt: "DESC" }, limit: 20 },
  );

  const items: {
    kind: "entry" | "refund" | "prize" | "prize_put_up" | "host";
    at: string;
    sport: string;
    title: string;
    amountUsd: string;
    sign: "" | "+" | "-";
    state: "done" | "pending";
    txHash: string | null;
  }[] = [];

  for (const e of entries) {
    const fee = BigInt(e.terms.entryFee);
    const sport = e.terms.game.sport;
    if (e.payoutKind === "prize" && e.payout && BigInt(e.payout) > 0n) {
      const placed = (e.terms.placements?.indexOf(user.id) ?? -1) + 1;
      items.push({
        kind: "prize", at: (e.settledAt ?? e.updatedAt).toISOString(), sport,
        title: placed > 0 ? `${PLACE[placed] ?? `${placed}th`} place` : "Prize",
        amountUsd: usd(BigInt(e.payout)), sign: "+", state: "done", txHash: e.payoutTxHash ?? null,
      });
    } else if (e.payoutKind === "refund" && e.payout && BigInt(e.payout) > 0n) {
      items.push({
        kind: "refund", at: (e.settledAt ?? e.leftAt ?? e.updatedAt).toISOString(), sport,
        title: "Entry refunded", amountUsd: usd(BigInt(e.payout)), sign: "+", state: "done",
        txHash: e.payoutTxHash ?? null,
      });
    } else if (fee > 0n && (e.state === "entered" || e.state === "pending" || e.state === "leaving")) {
      items.push({
        kind: "entry", at: (e.enteredAt ?? e.updatedAt).toISOString(), sport,
        title: "Event entry", amountUsd: usd(fee), sign: "-",
        state: e.state === "entered" ? "done" : "pending", txHash: e.txHash ?? null,
      });
    } else if (e.state === "left" && fee > 0n) {
      items.push({
        kind: "refund", at: (e.leftAt ?? e.updatedAt).toISOString(), sport,
        title: "Entry refunded", amountUsd: usd(fee), sign: "+", state: "done",
        txHash: e.leaveTxHash ?? e.payoutTxHash ?? null,
      });
    }
  }
  for (const p of prizes) {
    items.push({
      kind: "prize_put_up", at: (p.fundedAt ?? p.createdAt).toISOString(), sport: p.terms.game.sport,
      title: "Prize you put up", amountUsd: usd(BigInt(p.amount)), sign: "-",
      state: p.state === "funded" ? "done" : "pending", txHash: p.txHash ?? null,
    });
    if (p.returned && BigInt(p.returned) > 0n) {
      items.push({
        kind: "refund", at: (p.settledAt ?? p.updatedAt).toISOString(), sport: p.terms.game.sport,
        title: "Prize returned", amountUsd: usd(BigInt(p.returned)), sign: "+", state: "done",
        txHash: p.returnTxHash ?? null,
      });
    }
  }
  for (const t of hosted) {
    if (!t.organizerPayout || BigInt(t.organizerPayout) <= 0n) continue;
    items.push({
      kind: "host", at: (t.settledAt ?? t.updatedAt).toISOString(), sport: t.game.sport,
      title: "Event payout", amountUsd: usd(BigInt(t.organizerPayout)), sign: "+", state: "done",
      txHash: t.organizerTxHash ?? null,
    });
  }
  items.sort((a, b) => b.at.localeCompare(a.at));
  return { ok: true as const, items };
}
