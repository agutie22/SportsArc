/**
 * End-to-end check of the verified record against the database in .env:
 *
 *   node --env-file=.env --import=tsx api/web3/record/check-e2e.ts
 *
 * Seeds its own users, venue, games and check-ins, then: builds a record for
 * every eligible seat (a check-in or a missed game) and one for the game,
 * never twice (also under two concurrent builders); writes each seat's
 * result, and the host's word on who was there, only once the correction
 * hour has passed; keeps records pending with no chain; serves them
 * under the access rules in lookups.ts; and, when forge is installed,
 * compares abi.ts with the compiled SportsArcRecord. Deletes what it seeded.
 * Chain env from .env is ignored, so nothing is sent.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EntityManager } from "@mikro-orm/postgresql";
import {
  keccak256, stringToBytes, toEventSelector, toFunctionSelector, type Abi, type AbiParameter, type Hex,
} from "viem";
import { initDb } from "../../db.js";
import { Game } from "../../entities/Game.js";
import { GameParticipant } from "../../entities/GameParticipant.js";
import { GameResult } from "../../entities/GameResult.js";
import { ResultSeat } from "../../entities/ResultSeat.js";
import { CORRECTION_WINDOW_MS } from "../../games/results.js";
import { confirmRoster } from "../../games/roster.js";
import { RosterCheck } from "../../entities/RosterCheck.js";
import { User } from "../../entities/User.js";
import { Venue } from "../../entities/Venue.js";
import { gameKey } from "../ids.js";
import { recordAbi } from "./abi.js";
import { RecordEntry } from "./RecordEntry.js";
import { playerCode, userKey } from "./keys.js";
import { gameValues, presenceFields, recordHash, resultFields } from "./hashes.js";
import { ownRecord, recordByHash } from "./lookups.js";
import { postPendingRecords, postRecord } from "./sender.js";
import { buildPresenceRecords, buildRecords, buildResultRecords } from "./writer.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CHAIN_ENV = ["WEB3_CHAIN", "WEB3_RPC_URL", "TESTNET_PRIVATE_KEY", "RECORD_CONTRACT_ADDRESS"];

let passed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed += 1;
  console.log(`ok  ${name}`);
}

/** forge on PATH, else foundryup's default install; null when neither runs. */
function forgeBinary(): string | null {
  for (const bin of ["forge", join(homedir(), ".foundry", "bin", "forge")]) {
    if (bin !== "forge" && !existsSync(bin)) continue;
    try {
      execFileSync(bin, ["--version"], { stdio: "ignore" });
      return bin;
    } catch {
      // try the next
    }
  }
  return null;
}

// ── seed ──────────────────────────────────────────────────────────────

interface Seed {
  users: Record<"a" | "b" | "c" | "d" | "e", User>;
  closed: Game;
  open: Game;
  cancelled: Game;
  venue: Venue;
  seats: Record<string, GameParticipant>;
}

async function seed(em: EntityManager, now: Date): Promise<Seed> {
  const mk = (name: string) => {
    const u = new User();
    u.name = `record-check ${name}`;
    em.persist(u);
    return u;
  };
  const users = { a: mk("a"), b: mk("b"), c: mk("c"), d: mk("d"), e: mk("e") };

  const venue = new Venue();
  venue.name = "record-check court";
  venue.lat = 34.05;
  venue.lng = -118.25;
  venue.kind = "park";
  em.persist(venue);

  const game = (startsAt: Date, status: Game["status"]) => {
    const g = new Game();
    g.host = users.a;
    g.venue = venue;
    g.sport = "basketball";
    g.startsAt = startsAt;
    g.status = status;
    em.persist(g);
    return g;
  };
  const closed = game(new Date(now.getTime() - 2 * 3600_000), "played");
  const open = game(new Date(now.getTime() - 5 * 60_000), "full"); // window still open
  const cancelled = game(new Date(now.getTime() - 2 * 3600_000), "cancelled");

  const seat = (g: Game, u: User, status: GameParticipant["status"], checkedIn: boolean) => {
    const p = new GameParticipant();
    p.game = g;
    p.user = u;
    p.status = status;
    p.checkedInAt = checkedIn ? new Date(g.startsAt.getTime() - 10 * 60_000 + 123) : null;
    em.persist(p);
    return p;
  };
  const seats = {
    aClosed: seat(closed, users.a, "joined", true),
    bClosed: seat(closed, users.b, "joined", true),
    cClosed: seat(closed, users.c, "joined", false),
    dClosed: seat(closed, users.d, "cancelled", true), // checked in, then left
    aOpen: seat(open, users.a, "joined", true),
    aCancelled: seat(cancelled, users.a, "joined", true),
  };
  await em.flush();
  return { users, closed, open, cancelled, venue, seats };
}

async function recordsOf(em: EntityManager, seat: GameParticipant) {
  return em.fork().find(RecordEntry, { slot: `attendance:${seat.id}` });
}

// ── abi ───────────────────────────────────────────────────────────────

function canonical(params: readonly AbiParameter[]): string {
  return params
    .map((p) => {
      const components = (p as { components?: readonly AbiParameter[] }).components;
      return p.type.startsWith("tuple") && components
        ? `(${canonical(components)})${p.type.slice(5)}`
        : p.type;
    })
    .join(",");
}

function abiKeys(abi: Abi): Set<string> {
  const keys = new Set<string>();
  for (const item of abi) {
    if (item.type === "function") {
      keys.add(`function ${toFunctionSelector(item)} -> ${canonical(item.outputs)}`);
    } else if (item.type === "event") {
      keys.add(`event ${toEventSelector(item)} ${item.inputs.map((i) => (i.indexed ? "i" : "d")).join("")}`);
    } else if (item.type === "error") {
      keys.add(`error ${toFunctionSelector(`function ${item.name}(${canonical(item.inputs)})`)}`);
    }
  }
  return keys;
}

// ── run ───────────────────────────────────────────────────────────────

async function main() {
  for (const k of CHAIN_ENV) delete process.env[k];
  const orm = await initDb();
  const em = orm.em.fork();
  const now = new Date();
  const s = await seed(em, now);
  const code = (r: { ok: boolean; error?: { code: string } }) => (r.ok ? "ok" : r.error?.code);
  const mine = [s.closed.id, s.open.id, s.cancelled.id];

  try {
    await check("own record before anything is written: NOT_WRITTEN", async () => {
      assert.equal(code(await ownRecord(em.fork(), s.users.c, s.closed.id)), "NOT_WRITTEN");
    });

    await check("build: every joined seat of a closed, uncancelled game, and nothing else", async () => {
      const r = await buildRecords(em.fork(), { now, only: mine });
      assert.ok(r.ok, JSON.stringify(r));
      assert.ok(r.records >= 3, "a, b (check-ins) and c (missed)");
      const [a] = await recordsOf(em, s.seats.aClosed);
      const [b] = await recordsOf(em, s.seats.bClosed);
      const [c] = await recordsOf(em, s.seats.cClosed);
      assert.equal(a?.kind, "checkin");
      assert.equal(b?.kind, "checkin");
      assert.equal(c?.kind, "noshow", "held a seat at close without checking in");
      for (const k of ["dClosed", "aOpen", "aCancelled"]) {
        assert.equal((await recordsOf(em, s.seats[k])).length, 0, `${k} must not be written`);
      }
      for (const row of [a, b, c]) {
        assert.equal(row.status, "pending");
        assert.equal(row.game?.id, s.closed.id);
        assert.equal(recordHash(row.kind as "checkin", row.values), row.hash);
      }
    });

    await check("the game record: sport, venue, start and a salted host, written once", async () => {
      const rows = await em.fork().find(RecordEntry, { slot: `game:${s.closed.id}` });
      assert.equal(rows.length, 1);
      const [row] = rows;
      assert.equal(row.kind, "game");
      assert.equal(row.participant ?? null, null);
      const again = gameValues({
        gameId: s.closed.id, sport: "basketball", venueId: s.venue.id, startsAt: s.closed.startsAt, hostId: s.users.a.id, salt: row.salt as Hex,
      });
      assert.deepEqual(row.values, again);
      assert.equal((await em.fork().find(RecordEntry, { slot: { $like: "game:%" }, game: { $in: [s.open.id, s.cancelled.id] } })).length, 0,
        "no game record before check-in closes, nor for a cancelled game");
    });

    await check("every record has its own hash and its own salt", async () => {
      const rows = await em.fork().find(RecordEntry, { game: s.closed.id });
      assert.equal(new Set(rows.map((r) => r.hash)).size, rows.length);
      assert.equal(new Set(rows.map((r) => r.salt)).size, rows.length);
    });

    await check("a seat is never written twice", async () => {
      const r = await buildRecords(em.fork(), { now, only: mine });
      assert.ok(r.ok);
      assert.equal((await recordsOf(em, s.seats.aClosed)).length, 1);
    });

    await check("two concurrent builders: one record for a new seat, both succeed", async () => {
      const late = new GameParticipant();
      late.game = s.closed;
      late.user = s.users.e;
      late.status = "joined";
      late.checkedInAt = new Date(s.closed.startsAt.getTime() - 60_000);
      await em.persistAndFlush(late);
      s.seats.eClosed = late;
      const [x, y] = await Promise.all([buildRecords(em.fork(), { now, only: mine }), buildRecords(em.fork(), { now, only: mine })]);
      assert.ok(x.ok && y.ok, "both builders return ok");
      assert.equal((await recordsOf(em, late)).length, 1);
    });

    await check("no chain configured: NOT_CONFIGURED, records stay pending", async () => {
      const posted = await postPendingRecords(em.fork());
      assert.equal(code(posted), "NOT_CONFIGURED");
      const fork = em.fork();
      const [row] = await fork.find(RecordEntry, { slot: `attendance:${s.seats.aClosed.id}` });
      assert.equal(code(await postRecord(fork, row)), "NOT_CONFIGURED");
      assert.equal(row.status, "pending");
    });

    await check("results: written only after the correction hour, one per seat, sides and outcome as recorded", async () => {
      const first = new Date(now.getTime() - 2 * CORRECTION_WINDOW_MS);
      const result = new GameResult();
      result.game = s.closed;
      result.status = "settled";
      result.lockedAt = s.closed.startsAt;
      result.outcome = "win";
      result.winningSide = 1;
      result.firstRecordedAt = first;
      result.recordedAt = first;
      result.recordedBy = s.users.a;
      em.persist(result);
      const seat = (p: GameParticipant, side: number | null) => {
        const rs = new ResultSeat();
        rs.result = result;
        rs.participant = p;
        rs.side = side;
        em.persist(rs);
      };
      seat(s.seats.aClosed, 1);
      seat(s.seats.bClosed, 0);
      await em.flush();

      const early = await buildResultRecords(em.fork(), { only: mine, now: new Date(first.getTime() + CORRECTION_WINDOW_MS / 2) });
      assert.ok(early.ok && early.records === 0, "still correctable: nothing written");

      const r = await buildResultRecords(em.fork(), { only: mine, now });
      assert.ok(r.ok && r.records === 2, JSON.stringify(r));
      const a = await em.fork().findOneOrFail(RecordEntry, { slot: `result:${s.seats.aClosed.id}` });
      const b = await em.fork().findOneOrFail(RecordEntry, { slot: `result:${s.seats.bClosed.id}` });
      assert.deepEqual(resultFields(a.values), {
        side: 1, outcome: "win", winningSide: 1, finalAt: Math.floor((first.getTime() + CORRECTION_WINDOW_MS) / 1000),
      });
      assert.equal(resultFields(b.values).side, 0);
      const [attendance] = await recordsOf(em, s.seats.aClosed);
      assert.notEqual(a.values[2], attendance.values[2], "a fresh salt: the result does not link to the check-in");

      const again = await buildResultRecords(em.fork(), { only: mine, now });
      assert.ok(again.ok && again.records === 0, "written once");
    });

    await check("the host confirms who was here: rules, then presence records once final", async () => {
      const answers = (o: Record<string, boolean>) => ({ present: o });
      const closedSeats = await em.fork().find(GameParticipant, { game: s.closed.id, status: "joined" });
      const all = Object.fromEntries(closedSeats.map((p) => [p.user.id, Boolean(p.checkedInAt)]));
      all[s.users.c.id] = true; // no check-in, but the host says they were there

      assert.equal(code(await confirmRoster(em.fork(), s.closed, s.users.b, answers(all))), "NOT_HOST");
      assert.equal(code(await confirmRoster(em.fork(), s.open, s.users.a, answers({ [s.users.a.id]: true }))), "ROSTER_NOT_YET");
      assert.equal(code(await confirmRoster(em.fork(), s.closed, s.users.a, answers({ [s.users.a.id]: true }))), "VALIDATION_ERROR",
        "every player must be answered");
      assert.equal(code(await confirmRoster(em.fork(), s.closed, s.users.a, answers(all))), "ok");
      const c = await em.fork().findOneOrFail(GameParticipant, { id: s.seats.cClosed.id });
      assert.equal(c.hostPresent, true);

      const check = await em.fork().findOneOrFail(RosterCheck, { game: s.closed.id });
      const early = await buildPresenceRecords(em.fork(), { only: mine, now: new Date(check.firstConfirmedAt.getTime() + CORRECTION_WINDOW_MS / 2) });
      assert.ok(early.ok && early.records === 0, "still correctable: nothing written");

      const later = new Date(check.firstConfirmedAt.getTime() + CORRECTION_WINDOW_MS + 1000);
      const r = await buildPresenceRecords(em.fork(), { only: mine, now: later });
      assert.ok(r.ok && r.records === closedSeats.length, JSON.stringify(r));
      const cRecord = await em.fork().findOneOrFail(RecordEntry, { slot: `presence:${s.seats.cClosed.id}` });
      assert.equal(cRecord.kind, "presence");
      assert.equal(presenceFields(cRecord.values).present, true, "the host's word, beside a no-show from the phone");
      const [cAttendance] = await recordsOf(em, s.seats.cClosed);
      assert.equal(cAttendance.kind, "noshow", "the phone's record is kept as written");
      assert.notEqual(cRecord.values[2], cAttendance.values[2], "a fresh salt");

      const again = await buildPresenceRecords(em.fork(), { only: mine, now: later });
      assert.ok(again.ok && again.records === 0, "written once");
      assert.equal(code(await confirmRoster(em.fork(), s.closed, s.users.a, answers(all))), "ok", "still fixable inside the hour");
    });

    await check("own record: values and opening check out", async () => {
      const r = await ownRecord(em.fork(), s.users.a, s.closed.id);
      assert.ok(r.ok, JSON.stringify(r));
      const [, game, participant, secs] = r.values;
      assert.equal(game, gameKey(s.closed.id));
      assert.equal(participant, playerCode(r.opening.userKey, r.opening.salt as Hex));
      assert.equal(r.opening.userKey, userKey(s.users.a.id));
      assert.equal(secs, String(Math.floor((s.seats.aClosed.checkedInAt as Date).getTime() / 1000)));
      assert.equal(recordHash("checkin", r.values), r.hash);
      assert.equal(r.chain.status, "pending");
    });

    await check("own record only ever returns the viewer's own", async () => {
      const a = await ownRecord(em.fork(), s.users.a, s.closed.id);
      const b = await ownRecord(em.fork(), s.users.b, s.closed.id);
      assert.ok(a.ok && b.ok);
      assert.notEqual(a.hash, b.hash);
      assert.equal(b.opening.userKey, userKey(s.users.b.id));
    });

    await check("own record errors: not written, unknown game, junk id, left early", async () => {
      assert.equal(code(await ownRecord(em.fork(), s.users.a, s.open.id)), "NOT_WRITTEN");
      assert.equal(code(await ownRecord(em.fork(), s.users.a, randomUUID())), "NOT_FOUND");
      assert.equal(code(await ownRecord(em.fork(), s.users.a, "not-a-uuid")), "NOT_FOUND");
      assert.equal(code(await ownRecord(em.fork(), s.users.d, s.closed.id)), "NOT_WRITTEN");
    });

    await check("public lookup by hash: kind and chain only, no ids, values or salt", async () => {
      const own = await ownRecord(em.fork(), s.users.a, s.closed.id);
      assert.ok(own.ok);
      const r = await recordByHash(em.fork(), own.hash.toUpperCase().replace("0X", "0x"));
      assert.ok(r.ok);
      assert.equal(r.hash, own.hash);
      assert.equal(r.kind, "checkin");
      assert.equal(r.onChain, null, "nothing written, so the contract is not asked");
      const body = JSON.stringify(r);
      for (const secret of [s.users.a.id, s.closed.id, own.opening.salt as string, ...own.values.slice(1)]) {
        assert.ok(!body.includes(secret), `public lookup leaks ${secret}`);
      }
      assert.ok(!("values" in r) && !("opening" in r));
    });

    await check("public lookup errors: unknown hash, malformed hash", async () => {
      assert.equal(code(await recordByHash(em.fork(), keccak256(stringToBytes(randomUUID())))), "NOT_FOUND");
      assert.equal(code(await recordByHash(em.fork(), "0x1234")), "VALIDATION_ERROR");
    });

    const forge = forgeBinary();
    if (!forge) {
      console.log("skip the abi check: forge is not installed");
      return;
    }

    execFileSync(forge, ["build"], { cwd: join(ROOT, "contracts"), stdio: "ignore" });
    const artifact = JSON.parse(
      readFileSync(join(ROOT, "contracts", "out", "SportsArcRecord.sol", "SportsArcRecord.json"), "utf8"),
    ) as { abi: Abi };

    await check("abi.ts matches the compiled contract", () => {
      const compiled = abiKeys(artifact.abi);
      for (const key of abiKeys(recordAbi)) assert.ok(compiled.has(key), `abi.ts drifted: ${key}`);
    });
  } finally {
    const fork = em.fork();
    await fork.nativeDelete(RecordEntry, { game: { $in: [s.closed.id, s.open.id, s.cancelled.id] } });
    await fork.nativeDelete(Game, { id: { $in: [s.closed.id, s.open.id, s.cancelled.id] } });
    await fork.nativeDelete(Venue, { id: s.venue.id });
    await fork.nativeDelete(User, { id: { $in: Object.values(s.users).map((u) => u.id) } });
    await orm.close();
  }
}

main().then(
  () => {
    console.log(`\n${passed} checks passed`);
    process.exit(0);
  },
  (err) => {
    console.error(err);
    console.error(`\nFAILED after ${passed} passing checks`);
    process.exit(1);
  },
);
