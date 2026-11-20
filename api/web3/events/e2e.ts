/**
 * End-to-end run of paid events against the REAL testnets: the EventVault in
 * .env on Arc testnet, the real relayer and database, Circle's Gateway API
 * and Base Sepolia. Only Circle's PIN screen is stood in for: each person
 * here is a local key that signs exactly the typed data Circle was asked
 * to show, and never sends a transaction.
 *
 *   node --env-file=.env --import=tsx api/web3/events/e2e.ts
 *   node --env-file=.env --import=tsx api/web3/events/e2e.ts --abort
 *
 * Three events that start together, seven minutes after the run begins:
 *
 *   ticketed     $0.25 entry, no prize. Four enter and one leaves again (the
 *                fee comes straight back). Two check in, one does not. The
 *                host confirms it ran and is paid three entries less the
 *                platform fee, which goes to the treasury.
 *   competitive  $0.20 entry and a $1 prize the host puts up, winner takes
 *                all; a player cannot add to it. Three
 *                enter and check in; the winner asked to be paid on Base
 *                Sepolia, and Gateway delivers the prize there.
 *   underfilled  needs three players and gets one. The vault voids it at the
 *                start; the entry and the host's prize are returned.
 *
 * It also checks that the ticketed event's no-show and a check-in are
 * written on chain and verify there, that no player's wallet ever sent a
 * transaction, and prints what every kind of call cost in gas.
 *
 * It takes about an hour and a half, nearly all of it waiting: 15 minutes
 * for check-in to close, then the vault's correction window (an hour on the
 * deployed vault). It lends the players about $3 of the relayer's test USDC
 * and takes it back at the end, less the $1 prize that leaves for Base and
 * a few cents of gas.
 *
 * Every step first looks at where things stand, so a run that stops can be
 * started again and carries on: its keys and ids are kept in
 * output/events-e2e.json (gitignored). --abort cancels what is still open,
 * takes the money back and deletes the rows. A finished run deletes its
 * rows too and keeps the file as output/events-e2e-done-<time>.json.
 *
 * A running API on the same database is fine: its jobs and this script take
 * the same job locks, so each tick runs once whoever runs it.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient, erc20Abi, formatUnits, getAddress, http, parseEventLogs, type Address, type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { initDb, em as forkEm } from "../../db.js";
import { Notification, type NotificationKind } from "../../entities/Notification.js";
import { User } from "../../entities/User.js";
import { Venue } from "../../entities/Venue.js";
import { checkInClosesAt, checkInToGame } from "../../games/checkin.js";
import { createGame, findGame, type CreateGameInput } from "../../games/lifecycle.js";
import { withJobLock } from "../../ops/jobs.js";
import { reliabilityOf } from "../../social/reliability.js";
import { RecordEntry } from "../record/RecordEntry.js";
import { recordConfigured } from "../record/sender.js";
import { recordByHash } from "../record/lookups.js";
import { recordTick } from "../record/timer.js";
import { publicClient, relayer } from "../chains.js";
import { payoutChainByKey } from "../gateway/config.js";
import { resolveChoice } from "../gateway/destinations.js";
import { GatewayPayout } from "../gateway/GatewayPayout.js";
import { payoutTick } from "../gateway/timer.js";
import { gameKey } from "../ids.js";
import { relay, relayOutcome } from "../relayer/submit.js";
import { usd } from "../usd.js";
import {
  authorizationArgs, authorizationTypedData, newAuthorization, usdcAuthorizationAbi, usdcDomain,
} from "../wallet/authorization.js";
import { arcBlockchain, setCircleApi } from "../wallet/circle.js";
import { parseTypedDataJson } from "../wallet/signature.js";
import { EventEntry } from "./EventEntry.js";
import { EventPrize } from "./EventPrize.js";
import { EventTerms } from "./EventTerms.js";
import {
  cancelEvent, confirmAction, confirmEntry, confirmLeave, confirmPrize, eventConfig, eventStatus, postEventResult,
  setEventTerms, startEntry, startLeave, startPrize, vaultSettings,
} from "./events.js";
import { chainStatus, eventVaultAbi, feeOn } from "./protocol.js";
import { eventTick } from "./timer.js";

// ── the plan ──────────────────────────────────────────────────────────

const TICKET = 250_000n; // $0.25
const ENTRY = 200_000n; // $0.20
const PRIZE = 1_000_000n; // $1.00
const SMALL_PRIZE = 200_000n; // $0.20
const dollars = (units: bigint) => formatUnits(units, 6);

type EventName = "ticketed" | "competitive" | "underfilled";
const EVENTS: EventName[] = ["ticketed", "competitive", "underfilled"];

/** Everyone in the run, and the test money each is lent before entering (a host, for their prize). */
const PEOPLE = {
  host1: 0n, a: TICKET, b: TICKET, c: TICKET, d: TICKET,
  host2: PRIZE, x: ENTRY, y: ENTRY, z: ENTRY,
  host3: SMALL_PRIZE, u: TICKET,
} satisfies Record<string, bigint>;
type Name = keyof typeof PEOPLE;
const NAMES = Object.keys(PEOPLE) as Name[];
const LENT = Object.values(PEOPLE).reduce((sum, v) => sum + v, 0n);

/** Events start this long after the run does: time to set terms, lend money and enter. */
const LEAD_MS = 7 * 60_000;
const VENUE = { name: "events-e2e court", lat: 34.05, lng: -118.25 };

// ── what a run remembers ──────────────────────────────────────────────

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const OUTPUT = join(ROOT, "output");
const STATE_FILE = join(OUTPUT, "events-e2e.json");

interface Person {
  key: Hex;
  address: Address;
  userId: string;
}

interface State {
  startedAt: string;
  startsAt: string;
  vault: Address;
  people: Record<Name, Person>;
  /** A fresh address on Base Sepolia, where the winner is paid. */
  base: { key: Hex; address: Address };
  games: Partial<Record<EventName, string>>;
  lent: Partial<Record<Name, true>>;
  /** Base units already taken back from the throwaway wallets. */
  swept: string;
  result?: unknown;
}

let state: State;

function save(): void {
  mkdirSync(OUTPUT, { recursive: true });
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

// ── small helpers ─────────────────────────────────────────────────────

type Outcome = { ok: boolean; error?: { code: string; message: string } };

function ok<T extends Outcome>(r: T, what: string): Extract<T, { ok: true }> {
  assert.ok(r.ok, `${what}: ${JSON.stringify(r.error)}`);
  return r as Extract<T, { ok: true }>;
}
const codeOf = (r: Outcome) => (r.ok ? "ok" : r.error?.code);

const t0 = Date.now();
const stamp = () => {
  const s = Math.floor((Date.now() - t0) / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
const say = (...args: unknown[]) => console.log(stamp(), ...args);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let checks = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  assert.ok(cond, `${name}${detail === undefined ? "" : `: ${JSON.stringify(detail, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`}`);
  checks++;
  say(`  ok  ${name}`);
}

/** Sleep until `when`, saying how long is left every ten minutes. */
async function waitUntil(when: Date, why: string): Promise<void> {
  const left = () => when.getTime() - Date.now();
  if (left() <= 0) return;
  say(`waiting ${Math.ceil(left() / 60_000)} min for ${why} (${when.toISOString()})`);
  while (left() > 0) {
    await sleep(Math.min(left(), 10 * 60_000));
    if (left() > 30_000) say(`  ${Math.ceil(left() / 60_000)} min to go`);
  }
}

/** Run `each` and then `done` every few seconds until `done` says yes. */
async function until(what: string, timeoutMs: number, each: () => Promise<unknown>, done: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await each();
      if (await done()) return;
    } catch (err) {
      // The chain or the database not answering for a moment is not a failed run.
      say(`  (retrying ${what}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)})`);
    }
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await sleep(5_000);
  }
}

/** One tick of a job, under the lock the API's own timer takes; skipped when the API is running it. */
async function tick<T>(job: string, run: () => Promise<T>): Promise<T | null> {
  const r = await withJobLock(job, forkEm, run);
  return r.ran ? r.value : null;
}
const eventsTick = () => tick("event_settle", () => eventTick(forkEm));

// ── chain ─────────────────────────────────────────────────────────────

const cfg = eventConfig();
const server = relayer();
const arc = publicClient();
const explorer = arc.chain.blockExplorers?.default.url ?? "";
const txUrl = (hash: string | null | undefined) => (hash ? `${explorer}/tx/${hash}` : "-");

let usdc: Address;
const balanceOf = (address: Address) => arc.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [address] });
const balance = (name: Name) => balanceOf(state.people[name].address);
const vaultRead = () => ({ address: state.vault, abi: eventVaultAbi }) as const;
const keyOf = (event: EventName) => gameKey(state.games[event] as string);
const vaultStatus = async (event: EventName) =>
  chainStatus(await arc.readContract({ ...vaultRead(), functionName: "status", args: [keyOf(event)] }));

// ── Circle, stood in for ──────────────────────────────────────────────

/** What Circle was asked to show for each challenge it "opened". */
const asked = new Map<string, string>();

function standInForCircle(): void {
  const byCircleId = (id: string) => {
    const p = Object.values(state.people).find((x) => x.userId.replace(/-/g, "") === id);
    if (!p) throw new Error("unknown Circle user");
    return p;
  };
  setCircleApi({
    userToken: async (circleUserId) => ({ userToken: circleUserId, encryptionKey: "e2e" }),
    listWallets: async (userToken) => [{
      id: `e2e-${userToken}`, address: byCircleId(userToken).address, blockchain: arcBlockchain(), walletSetId: "e2e", state: "LIVE",
    }],
    createEvmTestnetWallet: async () => "unused",
    signTransaction: async () => "unused",
    signTypedData: async ({ data }) => {
      const id = randomUUID();
      asked.set(id, data);
      return id;
    },
    challengeStatus: async () => "PENDING",
  });
}

/** The PIN screen: `name`'s key signs what the challenge shows. */
async function pin(name: Name, challenge: { challengeId: string }): Promise<Hex> {
  const data = asked.get(challenge.challengeId);
  if (!data) throw new Error("no typed data was sent to Circle for that challenge");
  const account = privateKeyToAccount(state.people[name].key);
  return account.signTypedData(parseTypedDataJson(data) as Parameters<typeof account.signTypedData>[0]);
}

// ── steps, each safe to repeat ────────────────────────────────────────

async function at(name: Name, event: EventName) {
  const em = forkEm();
  const user = await em.findOneOrFail(User, { id: state.people[name].userId });
  const game = await findGame(em, state.games[event] as string);
  if (!game) throw new Error(`the ${event} game is gone`);
  return { em, user, game };
}

const termsRow = (event: EventName) =>
  forkEm().findOneOrFail(EventTerms, { game: state.games[event] as string, vaultAddress: state.vault }, { populate: ["game"] });
const entryRow = (name: Name, event: EventName) =>
  forkEm().findOne(EventEntry, { user: state.people[name].userId, terms: { game: state.games[event] as string } });
const entryState = async (name: Name, event: EventName) => (await entryRow(name, event))?.state ?? null;

/** Ask again, with no signature, until `still` stops being true. */
async function settle<T>(read: () => Promise<T>, still: (r: T) => boolean, first: T): Promise<T> {
  let r = first;
  for (let i = 0; still(r) && i < 45; i++) {
    await sleep(2_000);
    r = await read();
  }
  return r;
}

async function ensureTerms(event: EventName, host: Name, body: Record<string, unknown>): Promise<void> {
  const { em, user, game } = await at(host, event);
  let s = ok(await eventStatus(em, game, user), "eventStatus");
  if (s.terms && s.terms.status !== "draft") return;
  if (!s.terms?.pending?.sent) {
    const started = ok(await setEventTerms(em, user, game, body), `${event}: setEventTerms`);
    s = ok(await confirmAction(em, user, game, { signature: await pin(host, started.challenge) }), `${event}: createEvent`);
  }
  s = await settle(async () => {
    const c = await at(host, event);
    return ok(await confirmAction(c.em, c.user, c.game, {}), `${event}: createEvent`);
  }, (r) => r.terms?.status === "draft", s);
  assert.equal(s.terms?.status, "open", `${event}: the vault did not open the event`);
  say(`${event}: open on chain`, txUrl((await termsRow(event)).createTxHash));
}

async function lend(name: Name): Promise<void> {
  const amount = PEOPLE[name];
  if (amount === 0n || state.lent[name]) return;
  const hash = await server!.writeContract({ address: usdc, abi: erc20Abi, functionName: "transfer", args: [state.people[name].address, amount] });
  const receipt = await arc.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success", `lending ${name} money reverted`);
  state.lent[name] = true;
  save();
}

async function ensureEntered(name: Name, event: EventName, payout: unknown = null, wrongSigner?: Name): Promise<void> {
  const { em, user, game } = await at(name, event);
  let s = ok(await eventStatus(em, game, user), "eventStatus");
  if (s.entry?.state === "entered") return;
  if (s.entry?.state !== "pending") {
    const choice = ok(await resolveChoice(em, user, payout), `${name}: payout choice`).choice;
    const started = ok(await startEntry(em, user, game, choice), `${name}: startEntry`);
    if (wrongSigner) {
      const refused = await confirmEntry(em, user, game, { signature: await pin(wrongSigner, started.challenge) });
      check("an entry signed by another wallet is refused", codeOf(refused) === "SIGNATURE_MISMATCH", refused);
    }
    s = ok(await confirmEntry(em, user, game, { signature: await pin(name, started.challenge) }), `${name}: register`);
  }
  s = await settle(async () => {
    const c = await at(name, event);
    return ok(await confirmEntry(c.em, c.user, c.game, {}), `${name}: register`);
  }, (r) => r.entry?.state === "pending", s);
  assert.equal(s.entry?.state, "entered", `${name} did not get into the ${event} event`);
}

async function ensureLeft(name: Name, event: EventName): Promise<void> {
  const { em, user, game } = await at(name, event);
  let s = ok(await eventStatus(em, game, user), "eventStatus");
  if (s.entry?.state === "left") return;
  if (s.entry?.state === "entered") {
    const started = ok(await startLeave(em, user, game), `${name}: startLeave`);
    s = ok(await confirmLeave(em, user, game, { signature: await pin(name, started.challenge) }), `${name}: leave`);
  }
  s = await settle(async () => {
    const c = await at(name, event);
    return ok(await confirmLeave(c.em, c.user, c.game, {}), `${name}: leave`);
  }, (r) => r.entry?.state === "leaving", s);
  assert.equal(s.entry?.state, "left", `${name} did not leave the ${event} event`);
}

const prizeRow = (funder: Name, event: EventName) =>
  forkEm().findOne(EventPrize, {
    funder: state.people[funder].userId, terms: { game: state.games[event] as string }, state: { $in: ["pending", "funded"] },
  });

/** The host puts up their event's prize. */
async function ensurePrize(host: Name, event: EventName, amount: bigint): Promise<void> {
  const { em, user, game } = await at(host, event);
  let row = await prizeRow(host, event);
  if (row?.state === "funded") return;
  if (!row) {
    const started = ok(await startPrize(em, user, game, { amount: dollars(amount) }), `${host}: startPrize`);
    ok(await confirmPrize(em, user, started.prize.id, { signature: await pin(host, started.challenge) }), `${host}: fundPrize`);
    row = await prizeRow(host, event);
  }
  for (let i = 0; row?.state === "pending" && i < 45; i++) {
    await sleep(2_000);
    const c = await at(host, event);
    ok(await confirmPrize(c.em, c.user, row.id, {}), `${host}: fundPrize`);
    row = await prizeRow(host, event);
  }
  assert.equal(row?.state, "funded", `${host}'s prize for the ${event} event was not funded`);
}

async function checkIn(name: Name, event: EventName): Promise<void> {
  const { em, user, game } = await at(name, event);
  ok(await checkInToGame(em, game, user, { lat: VENUE.lat, lng: VENUE.lng }), `${name}: check in`);
}

async function ensureResult(event: EventName, host: Name, placed: Name[], attendees: number): Promise<void> {
  const { em, user, game } = await at(host, event);
  let s = ok(await eventStatus(em, game, user), "eventStatus");
  if (s.terms?.status === "posted" || s.terms?.status === "final") return;
  if (!s.terms?.pending?.sent) {
    const started = ok(
      await postEventResult(em, user, game, { placements: placed.map((n) => state.people[n].userId) }), `${event}: postEventResult`,
    );
    check(`${event}: the server counted ${attendees} check-ins, enough to run`, started.attendees === attendees && started.runs, started.attendees);
    s = ok(await confirmAction(em, user, game, { signature: await pin(host, started.challenge) }), `${event}: postResult`);
  }
  s = await settle(async () => {
    const c = await at(host, event);
    return ok(await confirmAction(c.em, c.user, c.game, {}), `${event}: postResult`);
  }, (r) => r.terms?.status === "open", s);
  assert.equal(s.terms?.status, "posted", `${event}: the result was not posted`);
  say(`${event}: result posted, final at ${s.terms?.result?.finalAt}`, txUrl((await termsRow(event)).resultTxHash));
}

const notified = (name: Name, kind: NotificationKind, event: EventName) =>
  forkEm().count(Notification, { recipient: state.people[name].userId, kind, game: state.games[event] as string });

// ── money back, and tidying up ────────────────────────────────────────

/** Whatever the throwaway wallets hold goes back to the relayer, signed by them and sent by it. */
async function sweep(): Promise<bigint> {
  const token = await usdcDomain(arc.chain.id);
  if (!token.ok) throw new Error(token.error.message);
  for (const name of NAMES) {
    const person = state.people[name];
    const value = await balanceOf(person.address);
    if (value === 0n) continue;
    const account = privateKeyToAccount(person.key);
    const auth = newAuthorization({ from: person.address, to: server!.account.address, value });
    const typed = authorizationTypedData("transfer", token.domain, auth);
    const signature = await account.signTypedData(typed as Parameters<typeof account.signTypedData>[0]);
    const sent = ok(await relay(forkEm(), null, {
      kind: "e2e_sweep", address: usdc, abi: usdcAuthorizationAbi, functionName: "transferWithAuthorization",
      args: authorizationArgs(auth, signature),
    }), `sweep ${name}`);
    const mined = ok(await relayOutcome(sent.hash, { kind: "e2e_sweep", waitMs: 60_000 }), `sweep ${name}`);
    assert.equal(mined.outcome.state, "confirmed", `sweeping ${name} did not confirm`);
    state.swept = (BigInt(state.swept) + value).toString();
    save();
  }
  return BigInt(state.swept);
}

async function deleteRows(): Promise<void> {
  const em = forkEm();
  const venues = new Set<string>();
  for (const id of Object.values(state.games)) {
    const game = id ? await findGame(em, id) : null;
    if (game) venues.add(game.venue.id);
  }
  await em.nativeDelete(User, { id: { $in: Object.values(state.people).map((p) => p.userId) } });
  if (venues.size) await em.nativeDelete(Venue, { id: { $in: [...venues] }, name: VENUE.name });
}

function retire(label: "done" | "aborted"): string {
  const file = join(OUTPUT, `events-e2e-${label}-${state.startedAt.replace(/[:.]/g, "-")}.json`);
  save();
  renameSync(STATE_FILE, file);
  return file;
}

// ── --abort ───────────────────────────────────────────────────────────

async function abort(): Promise<void> {
  let held = false;
  for (const event of EVENTS) {
    if (!state.games[event]) continue;
    const host = ({ ticketed: "host1", competitive: "host2", underfilled: "host3" } as const)[event];
    const { em, user, game } = await at(host, event);
    const s = ok(await eventStatus(em, game, user), "eventStatus");
    if (!s.terms || s.terms.status === "draft" || s.terms.status === "open") {
      const r = ok(await cancelEvent(em, user, game), `${event}: cancel`);
      if ("challenge" in r) {
        ok(await confirmAction(em, user, game, { signature: await pin(host, r.challenge) }), `${event}: cancel`);
        say(`${event}: cancelled on chain`);
      }
    } else if (s.terms.status === "posted") {
      held = true;
      say(`${event}: a result is posted, so it can no longer be cancelled; it pays out at ${s.terms.result?.finalAt}`);
    }
  }
  if (held) {
    say("Run again without --abort once that time has passed to finish the run, or with --abort to take the money back then.");
    return;
  }
  await until("refunds", 5 * 60_000, eventsTick, async () =>
    (await forkEm().count(EventTerms, {
      game: { $in: Object.values(state.games) as string[] }, status: { $ne: "draft" }, settledAt: null,
    })) === 0);
  say(`took back $${dollars(await sweep())}`);
  await deleteRows();
  say("aborted; the run's file is now", retire("aborted"));
}

// ── the run ───────────────────────────────────────────────────────────

async function start(): Promise<void> {
  const need = LENT + 500_000n;
  const have = await balanceOf(server!.account.address);
  assert.ok(have >= need, `the relayer holds $${dollars(have)}; this run needs $${dollars(need)} to lend out and pay gas`);

  const em = forkEm();
  const people = {} as Record<Name, Person>;
  for (const name of NAMES) {
    const key = generatePrivateKey();
    const u = new User();
    u.name = `events-e2e ${name}`;
    u.role = "player";
    u.audience = "adult";
    u.walletAddress = privateKeyToAccount(key).address;
    em.persist(u);
    people[name] = { key, address: u.walletAddress as Address, userId: u.id };
  }
  await em.flush();

  const baseKey = generatePrivateKey();
  const baseAddress = privateKeyToAccount(baseKey).address;
  // Whole seconds, as the vault keeps them.
  const startsAt = new Date(Math.ceil((Date.now() + LEAD_MS) / 1000) * 1000);
  state = {
    startedAt: new Date().toISOString(),
    startsAt: startsAt.toISOString(),
    vault: cfg!.deployment.vault,
    people,
    base: { key: baseKey, address: baseAddress },
    games: {},
    lent: {},
    swept: "0",
  };
  save();

  const venue: { id?: string } = {};
  for (const [event, host] of [["ticketed", "host1"], ["competitive", "host2"], ["underfilled", "host3"]] as const) {
    const user = await em.findOneOrFail(User, { id: people[host].userId });
    const input: CreateGameInput = { sport: "basketball", kind: "event", capacity: 4, startsAt: state.startsAt };
    const made = ok(await createGame(em, user, venue.id ? { ...input, venueId: venue.id } : { ...input, venue: VENUE }), `createGame ${event}`);
    venue.id = made.game.venue.id;
    state.games[event] = made.game.id;
    save();
  }
  say(`new run: three events starting ${state.startsAt}`);
}

async function run(): Promise<void> {
  const settings = await vaultSettings(cfg!.deployment);
  assert.ok(settings, "the vault's settings could not be read");
  const treasury = await arc.readContract({ ...vaultRead(), functionName: "treasury" });
  const ticketFee = feeOn(TICKET, settings.feeBps, settings.gasFee);
  const entryFee = feeOn(ENTRY, settings.feeBps, settings.gasFee);
  say(`vault ${state.vault}: fee ${settings.feeBps / 100}% + ${usd(settings.gasFee)} an entry, correction window ${settings.correctionWindow / 60} min`);
  say(`relayer ${server!.account.address}, treasury ${treasury}`);

  const startsAt = new Date(state.startsAt);
  const base = createPublicClient({ chain: baseSepolia, transport: http() });
  const baseUsdc = payoutChainByKey("baseSepolia")?.usdc;
  assert.ok(baseUsdc, "Base Sepolia is not a payout chain here");
  const baseBalance = () => base.readContract({ address: baseUsdc, abi: erc20Abi, functionName: "balanceOf", args: [state.base.address] });

  // ── 1. terms, money, entries ──
  const opening = (await Promise.all(EVENTS.map(vaultStatus))).some((s) => s === "none");
  if (opening || Date.now() < startsAt.getTime() - 45_000) {
    assert.ok(!opening || Date.now() < startsAt.getTime() - 150_000, "these events start too soon to open; run with --abort and start again");
    say("1. terms, signed by each host");
    await ensureTerms("ticketed", "host1", { entryFee: dollars(TICKET), minPlayers: 2, minAttendees: 2 });
    await ensureTerms("competitive", "host2", { entryFee: dollars(ENTRY), minPlayers: 3, minAttendees: 2, prize: "winner" });
    await ensureTerms("underfilled", "host3", { entryFee: dollars(TICKET), minPlayers: 3, prize: "winner" });

    say(`2. the relayer lends the players and hosts $${dollars(LENT)}`);
    for (const name of NAMES) await lend(name);

    say("3. entries, prizes and one change of mind, each one signature and no gas");
    for (const name of ["a", "b", "c"] as const) await ensureEntered(name, "ticketed", null, name === "b" ? "a" : undefined);
    if ((await entryState("d", "ticketed")) !== "left") {
      await ensureEntered("d", "ticketed");
      check("the entry fee left d's wallet", (await balance("d")) === 0n);
      {
        const { em, user, game } = await at("u", "ticketed");
        check("a full event takes nobody else", codeOf(await startEntry(em, user, game)) === "EVENT_FULL" && game.status === "full", game.status);
        const again = await at("a", "ticketed");
        check("and nobody enters twice", codeOf(await startEntry(again.em, again.user, again.game)) === "ALREADY_ENTERED");
      }
      await ensureLeft("d", "ticketed");
    }
    check("leaving before the start pays the entry straight back", (await balance("d")) === TICKET, await balance("d"));
    {
      const { em, user, game } = await at("d", "ticketed");
      const s = ok(await eventStatus(em, game, user), "eventStatus");
      check("and the seat is open again", s.terms?.entrants === 3 && s.can.enter && game.status === "open", s.terms?.entrants);
      const { em: em2, user: host1, game: g2 } = await at("host1", "ticketed");
      check("a ticketed event takes no prize", codeOf(await startPrize(em2, host1, g2, { amount: "1" })) === "NO_PRIZE");
    }

    await ensureEntered("x", "competitive", { chain: "baseSepolia", address: state.base.address });
    for (const name of ["y", "z"] as const) await ensureEntered(name, "competitive");
    {
      const { em, user, game } = await at("y", "competitive");
      check("only the host puts up the prize", codeOf(await startPrize(em, user, game, { amount: "1" })) === "NOT_HOST");
    }
    await ensurePrize("host2", "competitive", PRIZE);
    await ensureEntered("u", "underfilled");
    await ensurePrize("host3", "underfilled", SMALL_PRIZE);

    for (const name of ["a", "b", "c", "x", "y", "z", "u", "host2", "host3"] as const) {
      assert.equal(await balance(name), 0n, `${name} should have paid in everything they were lent`);
    }
    const held = await Promise.all(EVENTS.map((e) => arc.readContract({ ...vaultRead(), functionName: "eventOf", args: [keyOf(e)] })));
    check("the vault holds 3, 3 and 1 entries and both prizes",
      held[0].entrants === 3 && held[1].entrants === 3 && held[2].entrants === 1 && held[1].prizeTotal === PRIZE && held[2].prizeTotal === SMALL_PRIZE,
      held.map((h) => [h.entrants, h.prizeTotal]));

    say("4. check-in at the venue: everyone but c");
    for (const name of ["a", "b"] as const) await checkIn(name, "ticketed");
    for (const name of ["x", "y", "z"] as const) await checkIn(name, "competitive");
    {
      const { em, user, game } = await at("host1", "ticketed");
      check("a result cannot be posted while check-in is open", codeOf(await postEventResult(em, user, game, {})) === "CHECKIN_OPEN");
    }
  }

  // ── 2. the start: too few registered ──
  await waitUntil(new Date(startsAt.getTime() + 3_000), "the events to start");
  say("5. the underfilled event: one of three registered");
  await until("the underfilled event's refunds", 5 * 60_000, eventsTick, async () => Boolean((await termsRow("underfilled")).settledAt));
  {
    const terms = await termsRow("underfilled");
    check("the vault voided it at the start, with no signature from anyone",
      (await vaultStatus("underfilled")) === "void" && terms.status === "void" && terms.game.status === "cancelled", terms.status);
    check("the player has the entry back", (await balance("u")) === TICKET, await balance("u"));
    check("the host has the prize back, was paid nothing else, and no fee was taken",
      (await balance("host3")) === SMALL_PRIZE && BigInt(terms.feeTaken ?? "0") === 0n && BigInt(terms.organizerPayout ?? "0") === 0n,
      await balance("host3"));
    check("both were told", (await notified("u", "event_off", "underfilled")) === 1
      && (await notified("u", "event_refund", "underfilled")) === 1 && (await notified("host3", "event_refund", "underfilled")) === 1);
    check("the other two events are still on",
      (await vaultStatus("ticketed")) === "open" && (await vaultStatus("competitive")) === "open");
  }

  // ── 3. check-in closes: the results ──
  const closes = checkInClosesAt((await at("host1", "ticketed")).game);
  await waitUntil(new Date(closes.getTime() + 3_000), "check-in to close");
  say("6. the hosts post the results");
  {
    const { em, user, game } = await at("host1", "ticketed");
    const s = ok(await eventStatus(em, game, user), "eventStatus");
    if (s.terms?.status === "open" && !s.terms.pending) {
      const refused = await postEventResult(em, user, game, { placements: [state.people.c.userId] });
      check("a player who did not check in cannot be placed", codeOf(refused) === "VALIDATION_ERROR", refused);
    }
  }
  await ensureResult("ticketed", "host1", [], 2);
  await ensureResult("competitive", "host2", ["x"], 3);
  // Only while the window is open: a run started again after it has passed skips this.
  if ((await vaultStatus("ticketed")) === "posted" && (await vaultStatus("competitive")) === "posted") {
    check("nothing can be claimed while a result can still be corrected",
      (await arc.readContract({ ...vaultRead(), functionName: "claimable", args: [keyOf("competitive"), state.people.x.address] })) === 0n);
  }

  if (recordConfigured()) {
    say("7. the check-ins and the no-show are written to the record, one entry each");
    const recordOf = (name: Name) => forkEm().findOne(
      RecordEntry, { participant: { user: state.people[name].userId, game: state.games.ticketed as string }, kind: { $in: ["checkin", "noshow"] } },
    );
    await until("the records", 10 * 60_000, () => tick("record", () => recordTick(forkEm)), async () => {
      const [a, c] = await Promise.all([recordOf("a"), recordOf("c")]);
      return a?.status === "confirmed" && c?.status === "confirmed";
    });
    const [a, c] = await Promise.all([recordOf("a"), recordOf("c")]);
    const lookA = ok(await recordByHash(forkEm(), a!.hash), "a's record");
    const lookC = ok(await recordByHash(forkEm(), c!.hash), "c's record");
    check("a's check-in is on chain", lookA.kind === "checkin" && typeof lookA.onChain === "string", lookA.chain);
    check("c's no-show is on chain", lookC.kind === "noshow" && typeof lookC.onChain === "string", lookC.chain);
    check("each record has its own transaction", lookA.chain.txHash !== lookC.chain.txHash, [lookA.chain.txHash, lookC.chain.txHash]);
    say("   written in", txUrl(lookC.chain.txHash));
    const [ra, rc] = await Promise.all([reliabilityOf(forkEm(), state.people.a.userId), reliabilityOf(forkEm(), state.people.c.userId)]);
    check("reliability counts the game for both: a showed, c did not", ra.games === 1 && ra.showed === 1 && rc.games === 1 && rc.showed === 0, [ra, rc]);
  } else {
    say("7. the record contract is not configured (RECORD_CONTRACT_ADDRESS); skipped");
  }

  // ── 4. the correction window passes: payouts ──
  const finalAts = await Promise.all((["ticketed", "competitive"] as const).map((e) =>
    arc.readContract({ ...vaultRead(), functionName: "finalAt", args: [keyOf(e)] })));
  const finalAt = Number(finalAts[0] > finalAts[1] ? finalAts[0] : finalAts[1]) * 1000;
  assert.ok(finalAt > 0, "the posted results have no finalAt");
  await waitUntil(new Date(finalAt + 3_000), "the correction window to pass");
  say("8. the results are final: the relayer claims for everyone");
  await until("the payouts", 10 * 60_000, eventsTick, async () =>
    Boolean((await termsRow("ticketed")).settledAt) && Boolean((await termsRow("competitive")).settledAt));

  const ticketed = await termsRow("ticketed");
  const competitive = await termsRow("competitive");
  const hostTicket = 3n * (TICKET - ticketFee);
  const hostEntry = 3n * (ENTRY - entryFee);
  check(`ticketed: the host holds $${dollars(hostTicket)}: three entries, the no-show's included, less the fee`,
    (await balance("host1")) === hostTicket && ticketed.organizerPayout === hostTicket.toString(), await balance("host1"));
  check(`ticketed: the platform fee is $${dollars(3n * ticketFee)}`, ticketed.feeTaken === (3n * ticketFee).toString(), ticketed.feeTaken);
  check("ticketed: the players are owed nothing more", (await balance("a")) === 0n && (await balance("b")) === 0n && (await balance("c")) === 0n);
  check(`competitive: the host holds $${dollars(hostEntry)} (their prize went to the winner)`,
    (await balance("host2")) === hostEntry && competitive.organizerPayout === hostEntry.toString(), await balance("host2"));
  check(`competitive: the platform fee is $${dollars(3n * entryFee)}, and none of it comes from the prize`,
    competitive.feeTaken === (3n * entryFee).toString(), competitive.feeTaken);
  check("competitive: the prize was won in full, so none of it returns to the host",
    (await prizeRow("host2", "competitive"))?.returned === "0");
  check("competitive: the players who did not place get nothing", (await balance("y")) === 0n && (await balance("z")) === 0n);
  check("the hosts and the winner were told", (await notified("host1", "event_payout", "ticketed")) === 1
    && (await notified("host2", "event_payout", "competitive")) === 1 && (await notified("x", "event_prize", "competitive")) === 1);

  // The fee, as the chain recorded it.
  const feesExpected = 3n * ticketFee + 3n * entryFee;
  const claims = await Promise.all([ticketed, competitive].map((t) => arc.getTransactionReceipt({ hash: t.organizerTxHash as Hex })));
  const feeLogs = claims.flatMap((r) => parseEventLogs({ abi: eventVaultAbi, eventName: "FeeTaken", logs: r.logs }));
  check("the vault's FeeTaken events add up to the same fee", feeLogs.reduce((sum, l) => sum + l.args.amount, 0n) === feesExpected, feeLogs.map((l) => l.args.amount));
  await until("the treasury payment", 3 * 60_000, eventsTick, async () =>
    (await arc.readContract({ ...vaultRead(), functionName: "treasuryOwed" })) === 0n);
  const head = await arc.getBlockNumber();
  const firstClaim = claims.reduce((min, r) => (r.blockNumber < min ? r.blockNumber : min), head);
  const treasuryLogs = [];
  for (let from = firstClaim; from <= head; from += 2_000n) {
    const to = from + 1_999n < head ? from + 1_999n : head;
    treasuryLogs.push(...(await arc.getContractEvents({ ...vaultRead(), eventName: "TreasuryPaid", fromBlock: from, toBlock: to })));
  }
  const treasuryPaid = treasuryLogs.reduce((sum, l) => sum + (l.args.amount ?? 0n), 0n);
  check(`the treasury was paid the fees ($${dollars(treasuryPaid)})`, treasuryPaid >= feesExpected, treasuryPaid);

  // ── 5. the winner's prize, on Base ──
  say("9. the winner is paid on Base Sepolia through Gateway");
  const winner = await entryRow("x", "competitive");
  check("the winner's seat paid the payout wallet, not their Arc wallet",
    (await balance("x")) === 0n && winner?.payout === PRIZE.toString() && winner.payoutKind === "prize", winner?.payout);
  const payoutRow = () => forkEm().findOne(GatewayPayout, { user: state.people.x.userId });
  await until("the Gateway payout", 15 * 60_000, () => tick("gateway_payouts", () => payoutTick(forkEm)), async () => {
    const p = await payoutRow();
    return p?.state === "completed" || p?.state === "fallback";
  });
  const payout = (await payoutRow())!;
  say("   payout", { state: payout.state, amount: payout.amount, fee: payout.fee, sent: payout.sentAmount, tx: payout.destTxHash, reason: payout.fallbackReason });
  check("Gateway delivered it", payout.state === "completed" && payout.amount === PRIZE.toString()
    && getAddress(payout.destAddress) === state.base.address && BigInt(payout.sentAmount!) + BigInt(payout.fee!) === PRIZE, payout.state);
  let arrived = 0n;
  await until("the prize on Base Sepolia", 3 * 60_000, async () => undefined, async () => {
    arrived = await baseBalance();
    return arrived > 0n;
  });
  check(`$${dollars(arrived)} arrived on Base Sepolia (the prize less Circle's $${dollars(BigInt(payout.fee!))} fee)`, arrived === BigInt(payout.sentAmount!), arrived);

  // ── 6. nobody but the relayer sent anything ──
  const sent = await Promise.all(NAMES.map((n) => arc.getTransactionCount({ address: state.people[n].address })));
  check("none of the 13 wallets ever sent a transaction", sent.every((n) => n === 0), sent);

  // ── 7. what it cost ──
  const entries = await forkEm().find(EventEntry, { terms: { game: { $in: Object.values(state.games) as string[] } } });
  const prizes = await forkEm().find(EventPrize, { terms: { game: { $in: Object.values(state.games) as string[] } } });
  const allTerms = await Promise.all(EVENTS.map(termsRow));
  const calls: Record<string, (string | null | undefined)[]> = {
    createEvent: allTerms.map((t) => t.createTxHash),
    register: entries.map((e) => e.txHash),
    leave: entries.map((e) => e.leaveTxHash),
    fundPrize: prizes.map((p) => p.txHash),
    postResult: allTerms.map((t) => t.resultTxHash),
    claim: [...entries.filter((e) => e.payoutTxHash !== e.leaveTxHash).map((e) => e.payoutTxHash), ...allTerms.map((t) => t.organizerTxHash), ...prizes.map((p) => p.returnTxHash)],
    payTreasury: treasuryLogs.map((l) => l.transactionHash),
  };
  const gas: Record<string, { calls: number; gasEach: number; usdEach: string; txs: string[] }> = {};
  let spent = 0n;
  say("gas, paid by the relayer:");
  for (const [name, hashes] of Object.entries(calls)) {
    const unique = [...new Set(hashes.filter((h): h is string => Boolean(h)))];
    if (!unique.length) continue;
    const receipts = await Promise.all(unique.map((hash) => arc.getTransactionReceipt({ hash: hash as Hex })));
    const used = receipts.reduce((sum, r) => sum + r.gasUsed, 0n);
    const cost = receipts.reduce((sum, r) => sum + r.gasUsed * r.effectiveGasPrice, 0n);
    spent += cost;
    gas[name] = {
      calls: unique.length,
      gasEach: Number(used / BigInt(unique.length)),
      usdEach: formatUnits(cost / BigInt(unique.length), 18),
      txs: unique,
    };
    say(`   ${name.padEnd(12)} ${String(unique.length).padStart(2)} calls, ${gas[name].gasEach} gas and $${Number(gas[name].usdEach).toFixed(5)} each`);
  }
  say(`   in all $${Number(formatUnits(spent, 18)).toFixed(4)} of gas, against $${dollars(treasuryPaid)} of fees on 6 paid entries`);

  // ── 8. the money goes back ──
  const swept = await sweep();
  check(`the relayer took back what it lent that is still on Arc ($${dollars(swept)})`,
    swept === hostTicket + hostEntry + 2n * TICKET + SMALL_PRIZE, swept);

  state.result = {
    finishedAt: new Date().toISOString(),
    chainId: arc.chain.id,
    vault: state.vault,
    relayer: server!.account.address,
    treasury,
    fee: { bps: settings.feeBps, flat: settings.gasFee.toString(), correctionWindowSeconds: settings.correctionWindow },
    events: Object.fromEntries(allTerms.map((t, i) => [EVENTS[i], {
      gameId: t.game.id, eventKey: t.eventKey, status: t.status, attendees: t.attendees ?? null,
      organizerPayout: t.organizerPayout ?? null, feeTaken: t.feeTaken ?? null,
      createTx: t.createTxHash ?? null, resultTx: t.resultTxHash ?? null, organizerClaimTx: t.organizerTxHash ?? null,
    }])),
    treasuryPaid: treasuryPaid.toString(),
    treasuryTxs: treasuryLogs.map((l) => l.transactionHash),
    winner: {
      prize: PRIZE.toString(), claimTx: winner?.payoutTxHash ?? null, chain: payout.destChainKey, address: payout.destAddress,
      sent: payout.sentAmount, gatewayFee: payout.fee, destTx: payout.destTxHash,
    },
    record: recordConfigured(),
    gas,
    gasTotalUsd: formatUnits(spent, 18),
    checks,
  };
  await deleteRows();
  const file = retire("done");
  say(`ok: ${checks} checks passed. The record of this run is ${file}`);
}

// ── main ──────────────────────────────────────────────────────────────

const orm = await initDb();
let failed = false;
try {
  assert.ok(cfg && server, "EVENT_VAULT_ADDRESS, WEB3_USDC_ADDRESS and TESTNET_PRIVATE_KEY must be set");
  const token = await usdcDomain(arc.chain.id);
  assert.ok(token.ok, "the chain's USDC could not be read");
  usdc = token.domain.verifyingContract;

  const aborting = process.argv.includes("--abort");
  if (existsSync(STATE_FILE)) {
    state = JSON.parse(readFileSync(STATE_FILE, "utf-8")) as State;
    assert.equal(getAddress(state.vault), cfg.deployment.vault, "output/events-e2e.json is a run against another vault");
    say(`${aborting ? "aborting" : "carrying on with"} the run started ${state.startedAt}`);
  } else {
    assert.ok(!aborting, "there is no run to abort (no output/events-e2e.json)");
    await start();
  }
  standInForCircle();
  if (aborting) await abort();
  else await run();
} catch (err) {
  failed = true;
  console.error(stamp(), "FAILED:", err);
  if (existsSync(STATE_FILE)) {
    console.error("The run's keys and ids are in output/events-e2e.json. Run again to carry on from here, or with --abort to cancel what is open and take the money back.");
  }
} finally {
  await orm.close(true);
}
process.exit(failed ? 1 : 0);
