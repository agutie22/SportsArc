/**
 * Keeps events moving without anyone lifting a finger. Every tick:
 *
 *  1. Records calls still in flight whose browser went away: a host's
 *     create, result, cancel or prize, a player's entry or leave.
 *  2. Brings each started event's status in step with the vault, which
 *     decides on its own clock: void when too few registered at the start or
 *     too few checked in, final when the correction window passes, expired
 *     when no result came by the deadline. Players are told when an event
 *     is off.
 *  3. Pays out every settled event: claim() for each player and the host
 *     (their fees, and any prize money that comes back), sent from the relayer, so nobody has to ask for
 *     their money or pay gas to get it; then the platform's fees to the
 *     treasury. Each person is told what they were paid and why.
 *
 * The vault is the source of truth. What an account is owed is read from
 * it, and a claim someone else already submitted is recorded without a
 * transaction. Runs as the "event_settle" job (api/ops/jobs.ts): once per
 * tick across instances. Idle until EVENT_VAULT_ADDRESS, a USDC address and
 * TESTNET_PRIVATE_KEY are set.
 *
 * Wiring: one line in startWeb3Timers() in api/web3/index.ts.
 */

import type { EntityManager } from "@mikro-orm/postgresql";
import { getAddress, type Address, type Hex } from "viem";
import type { User } from "../../entities/User.js";
import { startJob } from "../../ops/jobs.js";
import { log } from "../../ops/log.js";
import { notify } from "../../social/notifications.js";
import { publicClient } from "../chains.js";
import { relay, relayOutcome } from "../relayer/submit.js";
import { usd } from "../usd.js";
import { EventEntry } from "./EventEntry.js";
import { EventPrize } from "./EventPrize.js";
import { EventTerms } from "./EventTerms.js";
import {
  eventConfig, readEvent, readStatus, recordAction, recordEntry, recordLeave, recordPrize, refundLine,
  type EventConfig,
} from "./events.js";
import { eventVaultAbi, isRefundable, isSettled, type ChainStatus, type Deployment } from "./protocol.js";

const EVERY_MS = 30_000;
const EVENTS_PER_TICK = 10;
const FLIGHTS_PER_TICK = 50;
const RECEIPT_TIMEOUT_MS = 60_000;

const POPULATE_TERMS = ["game", "organizer"] as const;

const here = (d: Deployment) => ({ chainId: d.chainId, vaultAddress: d.vault });

export function eventTimerConfigured(): boolean {
  return eventConfig() !== null;
}

// ── 1. calls in flight ────────────────────────────────────────────────

async function recordFlights(em: EntityManager, d: Deployment): Promise<number> {
  let recorded = 0;
  const actions = await em.find(
    EventTerms, { ...here(d), action: { $ne: null }, actionTxHash: { $ne: null } },
    { populate: POPULATE_TERMS, limit: FLIGHTS_PER_TICK },
  );
  for (const terms of actions) {
    await recordAction(em, d, terms, 0);
    if (!terms.actionTxHash) recorded++;
  }
  const entries = await em.find(
    EventEntry, { terms: here(d), state: { $in: ["pending", "leaving"] } },
    { populate: ["user", "terms", "terms.game", "terms.organizer"], limit: FLIGHTS_PER_TICK },
  );
  for (const entry of entries) {
    const before = entry.state;
    if (before === "pending") await recordEntry(em, entry.terms, entry, 0);
    else await recordLeave(em, entry.terms, entry, 0);
    if (entry.state !== before) recorded++;
  }
  const prizes = await em.find(
    EventPrize, { terms: here(d), state: "pending" },
    { populate: ["funder", "terms", "terms.game", "terms.organizer"], limit: FLIGHTS_PER_TICK },
  );
  for (const prize of prizes) {
    await recordPrize(em, prize, 0);
    if (prize.state !== "pending") recorded++;
  }
  return recorded;
}

// ── 2. status ─────────────────────────────────────────────────────────

/** Why an event that is off is off, for the people who entered it. */
function offReason(was: EventTerms["status"], now: ChainStatus): string {
  if (now === "cancelled") return "The host cancelled.";
  if (now === "expired") return "No result was posted in time.";
  return was === "posted" ? "Too few players checked in." : "Too few players registered.";
}

/**
 * Copy the vault's status for one event; on a change that ends it without a
 * payout, tell the players and the organizer. Returns whether it changed.
 */
async function syncStatus(em: EntityManager, d: Deployment, terms: EventTerms): Promise<boolean> {
  const status = await readStatus(d, terms.eventKey as Hex);
  if (status === "none" || status === terms.status) return false;
  const was = terms.status;
  terms.status = status;
  const game = terms.game;
  // An event that is off before it was played is a cancelled game; one whose
  // players came and were too few has still happened.
  if (isRefundable(status) && was === "open" && status !== "expired" && game.status !== "played") game.status = "cancelled";
  await em.flush();
  if (isRefundable(status)) {
    const reason = offReason(was, status);
    const entries = await em.find(EventEntry, { terms, state: "entered" }, { populate: ["user"] });
    for (const entry of entries) {
      await notify(em, { recipient: entry.user, kind: "event_off", game, detail: `${reason}${refundLine(terms)}` });
    }
    await notify(em, { recipient: terms.organizer, kind: "event_off", game, detail: `${reason} Everyone is being refunded.` });
  }
  log.info("event status changed", { gameId: game.id, from: was, to: status });
  return true;
}

// ── 3. payouts ────────────────────────────────────────────────────────

const ORDINAL = ["1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th"];

interface Account {
  address: Address;
  entry?: EventEntry;
  prizes: EventPrize[];
  organizer: boolean;
}

/**
 * Pay one settled event's accounts. For each wallet with anything unrecorded
 * (an entry, prize contributions, the organizer's fees): send claim() if the
 * vault still owes it something, then record what each role was paid and
 * tell the person. Returns true once nothing is left to do for the event.
 */
async function settleEvent(em: EntityManager, cfg: EventConfig, terms: EventTerms): Promise<boolean> {
  const d = cfg.deployment;
  const key = terms.eventKey as Hex;
  const client = publicClient();
  const read = { address: d.vault, abi: eventVaultAbi } as const;

  const status = await readStatus(d, key);
  if (!isSettled(status)) return false;
  const ran = status === "final";
  const event = await readEvent(d, key);
  const game = terms.game;
  const fee = event.entryFee;

  const accounts = new Map<string, Account>();
  const at = (address: string): Account => {
    const k = address.toLowerCase();
    let a = accounts.get(k);
    if (!a) accounts.set(k, (a = { address: getAddress(address), prizes: [], organizer: false }));
    return a;
  };
  const entries = await em.find(EventEntry, { terms, state: "entered", settledAt: null }, { populate: ["user"] });
  for (const entry of entries) at(entry.playerAddress).entry = entry;
  const prizes = await em.find(EventPrize, { terms, state: "funded", settledAt: null }, { populate: ["funder"] });
  for (const prize of prizes) at(prize.funderAddress).prizes.push(prize);
  if (terms.organizerPayout === null || terms.organizerPayout === undefined) at(terms.organizerAddress).organizer = true;

  // What the result leaves unused goes back to whoever funded the prize, in proportion.
  const unused = ran && event.prizeTotal > 0n
    ? await client.readContract({ ...read, functionName: "unusedPrize", args: [key] })
    : 0n;
  const perEntryFee = await client.readContract({ ...read, functionName: "feeOn", args: [fee] });

  let done = true;
  for (const account of accounts.values()) {
    const owed = await client.readContract({ ...read, functionName: "claimable", args: [key, account.address] });
    const feesDue = account.organizer && ran
      ? await client.readContract({ ...read, functionName: "feesPending", args: [key] })
      : false;
    let hash: Hex | null = null;
    if (owed > 0n || feesDue) {
      const sent = await relay(em, null, { kind: "event_claim", ...read, functionName: "claim", args: [key, account.address] });
      if (!sent.ok) {
        log.warn("event claim not sent", { gameId: game.id, code: sent.error.code });
        done = false;
        continue;
      }
      hash = sent.hash;
      const mined = await relayOutcome(hash, { kind: "event_claim", waitMs: RECEIPT_TIMEOUT_MS });
      if (!mined.ok || mined.outcome.state !== "confirmed") {
        // Still in flight or failed: the next tick reads the vault again.
        done = false;
        continue;
      }
    }
    const now = new Date();

    if (account.entry) {
      const entry = account.entry;
      const share = ran
        ? await client.readContract({ ...read, functionName: "prizeShareOf", args: [key, entry.teamKey as Hex] })
        : fee;
      entry.payout = share.toString();
      entry.payoutKind = share === 0n ? null : ran ? "prize" : "refund";
      entry.payoutTxHash = hash;
      entry.settledAt = now;
      await em.flush();
      if (share > 0n && ran) {
        const place = (terms.placements ?? []).indexOf(entry.user.id);
        await notify(em, {
          recipient: entry.user, kind: "event_prize", game,
          detail: place >= 0 ? `${usd(share)} · ${ORDINAL[place] ?? `#${place + 1}`} place` : usd(share),
        });
      } else if (share > 0n) {
        await notify(em, { recipient: entry.user, kind: "event_refund", game, detail: `${usd(share)} back` });
      }
    }

    if (account.prizes.length) {
      let back = 0n;
      let funder: User | null = null;
      for (const prize of account.prizes) {
        const part = ran ? (unused * BigInt(prize.amount)) / event.prizeTotal : BigInt(prize.amount);
        prize.returned = part.toString();
        prize.returnTxHash = hash;
        prize.settledAt = now;
        back += part;
        funder = prize.funder;
      }
      await em.flush();
      if (back > 0n && funder) {
        await notify(em, {
          recipient: funder, kind: "event_refund", game,
          detail: ran ? `${usd(back)} of your prize money was not won and came back` : `${usd(back)} of prize money back`,
        });
      }
    }

    if (account.organizer) {
      const feeTotal = ran ? perEntryFee * BigInt(event.entrants) : 0n;
      const net = ran ? fee * BigInt(event.entrants) - feeTotal : 0n;
      terms.organizerPayout = net.toString();
      terms.feeTaken = feeTotal.toString();
      terms.organizerTxHash = hash;
      await em.flush();
      if (net > 0n) {
        const n = event.entrants;
        await notify(em, {
          recipient: terms.organizer, kind: "event_payout", game,
          detail: `${usd(net)} from ${n} entr${n === 1 ? "y" : "ies"}, after a ${usd(feeTotal)} fee`,
        });
      }
    }
  }
  if (done) {
    terms.status = status as EventTerms["status"];
    terms.settledAt = new Date();
    await em.flush();
  }
  return done;
}

/** Send the platform fees taken so far to the treasury, if there are any. */
async function payTreasury(em: EntityManager, d: Deployment): Promise<void> {
  const read = { address: d.vault, abi: eventVaultAbi } as const;
  const owed = await publicClient().readContract({ ...read, functionName: "treasuryOwed" });
  if (owed === 0n) return;
  const sent = await relay(em, null, { kind: "event_treasury", ...read, functionName: "payTreasury", args: [] });
  if (!sent.ok) return;
  await relayOutcome(sent.hash, { kind: "event_treasury", waitMs: RECEIPT_TIMEOUT_MS });
  log.info("event fees paid to the treasury", { amount: usd(owed), txHash: sent.hash });
}

// ── the tick ──────────────────────────────────────────────────────────

/** One run over everything with event work left. Exported for checks. */
export async function eventTick(fork: () => EntityManager): Promise<{ recorded: number; changed: number; settled: number }> {
  const out = { recorded: 0, changed: 0, settled: 0 };
  const cfg = eventConfig();
  if (!cfg) return out;
  const d = cfg.deployment;
  const em = fork();

  out.recorded = await recordFlights(em, d);

  // Events the vault's clock may have moved: started, or waiting out a correction window.
  const live = await em.find(
    EventTerms,
    { ...here(d), $or: [{ status: "open", startsAt: { $lte: new Date() } }, { status: "posted" }] },
    { populate: POPULATE_TERMS, orderBy: { updatedAt: "ASC" }, limit: FLIGHTS_PER_TICK },
  );
  for (const terms of live) {
    try {
      if (await syncStatus(em, d, terms)) out.changed++;
    } catch (err) {
      log.warn("event status read failed", { gameId: terms.game.id, err });
    }
  }

  const due = await em.find(
    EventTerms,
    { ...here(d), status: { $in: ["final", "void", "cancelled", "expired"] }, settledAt: null },
    { populate: POPULATE_TERMS, orderBy: { updatedAt: "ASC" }, limit: EVENTS_PER_TICK },
  );
  let feesTaken = false;
  for (const terms of due) {
    try {
      if (await settleEvent(em, cfg, terms)) out.settled++;
      if (BigInt(terms.feeTaken ?? "0") > 0n) feesTaken = true;
    } catch (err) {
      log.error("event payout failed", { gameId: terms.game.id, err });
    }
  }
  if (feesTaken) {
    try {
      await payTreasury(em, d);
    } catch (err) {
      log.warn("event treasury payment failed", { err });
    }
  }
  return out;
}

export function startEventTimer(fork: () => EntityManager): () => void {
  return startJob({ name: "event_settle", fork, everyMs: EVERY_MS }, async () => {
    if (!eventTimerConfigured()) return;
    try {
      const r = await eventTick(fork);
      if (r.recorded || r.changed || r.settled) log.info("events advanced", r);
    } catch (err) {
      log.error("event tick failed", { err });
    }
  });
}
