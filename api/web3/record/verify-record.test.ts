/**
 * frontend/verify-record.mjs carries its own keccak256, ABI encoding,
 * EIP-712 hashing and signature recovery so it runs with no dependencies.
 * This pins each against viem, and checks a whole record file end to end:
 * a good one passes, a tampered value, a wrong salt and a forged ownership
 * signature each fail.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { encodeAbiParameters, hashTypedData, keccak256 as viemKeccak, toHex, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { playerCode, userKey } from "./keys.js";
import { checkInValues, gameValues, memberValues, RECORD_KINDS, recordHash, resultValues, seasonValues, standingValues } from "./hashes.js";
import { COMMITMENT_INDEX, EXPORT_FORMAT, ownershipTypedData } from "./portable.js";

interface Checker {
  keccak256: (b: Uint8Array) => string;
  abiEncode: (types: readonly string[], values: readonly unknown[]) => Uint8Array;
  typedDataDigest: (td: unknown) => string;
  recoverAddress: (digest: string, sig: string) => string | null;
  checkRecordFile: (file: unknown, opts?: { ask?: (rpc: string, contract: string, hash: string) => Promise<number> }) => Promise<{
    ok: boolean;
    ownership: { signedByWallet: boolean; forThisPlayer: boolean } | null;
    entries: { kind: string; checks: Record<string, boolean | null> }[];
  }>;
}

const load = async () => (await import(new URL("../../../frontend/verify-record.mjs", import.meta.url).href)) as Checker;
const json = <T>(v: T): T => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));

test("keccak256 matches viem at every length around the block size", async () => {
  const { keccak256 } = await load();
  for (const n of [0, 1, 31, 32, 33, 64, 135, 136, 137, 200, 271, 272, 273, 500]) {
    const bytes = new Uint8Array(randomBytes(n));
    assert.equal(keccak256(bytes), viemKeccak(bytes), `length ${n}`);
  }
});

test("abi.encode of record values matches viem", async () => {
  const { abiEncode } = await load();
  const salt = toHex(randomBytes(32));
  const values = resultValues({ gameId: crypto.randomUUID(), userId: crypto.randomUUID(), side: 0, outcome: "win", winningSide: 0, finalAt: new Date(), salt });
  const types = RECORD_KINDS["result"].encoding;
  const viem = encodeAbiParameters(types.map((type) => ({ type })), values.map((v, i) => (types[i].startsWith("uint") ? BigInt(v) : v)));
  assert.equal(toHex(abiEncode(types, values)), viem);
});

test("the EIP-712 digest and signature recovery match viem", async () => {
  const { typedDataDigest, recoverAddress } = await load();
  for (let i = 0; i < 5; i++) {
    const account = privateKeyToAccount(generatePrivateKey());
    const td = ownershipTypedData({
      player: userKey(crypto.randomUUID()), wallet: account.address, issuedAt: 1_790_000_000 + i,
      chainId: 5042002, contract: "0x869517905F662957da7d59E696FdC613e09798cd",
    });
    const digest = hashTypedData(td as Parameters<typeof hashTypedData>[0]);
    assert.equal(typedDataDigest(json(td)), digest);
    const sig = await account.signTypedData(td as Parameters<typeof account.signTypedData>[0]);
    assert.equal(recoverAddress(digest, sig)?.toLowerCase(), account.address.toLowerCase());
    assert.notEqual(recoverAddress(viemKeccak(toHex("other")), sig)?.toLowerCase(), account.address.toLowerCase());
  }
});

test("a record file: passes, then each tampering fails", async () => {
  const { checkRecordFile } = await load();
  const userId = crypto.randomUUID();
  const gameId = crypto.randomUUID();
  const key = userKey(userId);
  const salt = toHex(randomBytes(32)) as Hex;
  const hostSalt = toHex(randomBytes(32)) as Hex;
  const checkin = checkInValues({ gameId, userId, checkedInAt: new Date(), salt });
  const game = gameValues({ gameId, sport: "soccer", venueId: crypto.randomUUID(), startsAt: new Date(), hostId: crypto.randomUUID(), salt: hostSalt });
  const account = privateKeyToAccount(generatePrivateKey());
  const td = ownershipTypedData({ player: key, wallet: account.address, issuedAt: 1_790_000_000, chainId: 5042002, contract: "0x869517905F662957da7d59E696FdC613e09798cd" });
  const signature = await account.signTypedData(td as Parameters<typeof account.signTypedData>[0]);
  const entry = (kind: "checkin" | "game", values: string[], s: Hex | null) => ({
    kind, hash: recordHash(kind, values), encoding: RECORD_KINDS[kind].encoding, values, salt: s,
    opens: s ? COMMITMENT_INDEX[kind] : null, gameId, written: { contract: "0x869517905F662957da7d59E696FdC613e09798cd" },
  });
  const file = {
    format: EXPORT_FORMAT,
    player: { name: "Test", key },
    chain: { rpcUrl: "http://rpc.invalid", contract: "0x869517905F662957da7d59E696FdC613e09798cd" },
    ownership: { wallet: account.address, typedData: json(td), signature },
    records: [entry("checkin", checkin, salt), entry("game", game, null)],
  };
  const onChain = new Set<string>(file.records.map((r) => r.hash));
  const ask = async (_rpc: string, _c: string, hash: string) => (onChain.has(hash) ? 1_790_000_100 : 0);

  const good = await checkRecordFile(file, { ask });
  assert.ok(good.ok, JSON.stringify(good));
  assert.deepEqual(good.entries[0].checks, { hash: true, kind: true, game: true, season: null, list: null, theirs: true, onChain: true });
  assert.equal(good.entries[1].checks.theirs, null, "no host salt in a player's file");
  assert.deepEqual(good.ownership, { wallet: account.address, signedByWallet: true, forThisPlayer: true });
  assert.equal(playerCode(key, salt), checkin[2]);

  const tampered = structuredClone(file);
  tampered.records[0].values[3] = String(Number(checkin[3]) + 60);
  assert.equal((await checkRecordFile(tampered, { ask })).entries[0].checks.hash, false, "a changed time is a different hash");

  const wrongSalt = structuredClone(file);
  wrongSalt.records[0].salt = toHex(randomBytes(32));
  assert.equal((await checkRecordFile(wrongSalt, { ask })).entries[0].checks.theirs, false);

  const notWritten = structuredClone(file);
  const none = async () => 0;
  assert.equal((await checkRecordFile(notWritten, { ask: none })).ok, false);

  const otherPlayer = structuredClone(file);
  otherPlayer.player.key = userKey(crypto.randomUUID());
  const r = await checkRecordFile(otherPlayer, { ask });
  assert.equal(r.ownership?.forThisPlayer, false);
  assert.equal(r.ok, false);
});

test("a season in a record file: the member is theirs, the standing's cites and the season's table add up", async () => {
  const { checkRecordFile } = await load();
  const userId = crypto.randomUUID();
  const seasonId = crypto.randomUUID();
  const teamId = crypto.randomUUID();
  const key = userKey(userId);
  const salt = toHex(randomBytes(32)) as Hex;
  const finalAt = new Date("2027-03-30T02:00:00Z");
  const cites = [viemKeccak(toHex("r1")), viemKeccak(toHex("r2")), viemKeccak(toHex("r3"))].map((h) => h.toLowerCase()).sort();
  const standing = standingValues({ seasonId, teamId, wins: 2, losses: 1, ties: 0, place: 1, resultHashes: cites, finalAt });
  const other = standingValues({ seasonId, teamId: crypto.randomUUID(), wins: 1, losses: 2, ties: 0, place: 2, resultHashes: [], finalAt });
  const table = [recordHash("standing", standing), recordHash("standing", other)];
  const member = memberValues({ seasonId, teamId, userId, finalAt, salt });
  const season = seasonValues({ seasonId, orgId: crypto.randomUUID(), standingHashes: table, finalAt });
  const entry = (
    kind: "member" | "standing" | "season",
    values: string[],
    extra: { salt?: string; opens?: number; cites?: string[]; table?: string[] } = {},
  ) => ({
    kind, hash: recordHash(kind, values), encoding: RECORD_KINDS[kind].encoding, values, salt: null as string | null,
    opens: null as number | null, gameId: null, seasonId: seasonId as string, cites: undefined as string[] | undefined,
    table: undefined as string[] | undefined, written: { contract: "0x869517905F662957da7d59E696FdC613e09798cd" }, ...extra,
  });
  const file = {
    format: EXPORT_FORMAT,
    player: { name: "Test", key },
    chain: { rpcUrl: "http://rpc.invalid", contract: "0x869517905F662957da7d59E696FdC613e09798cd" },
    ownership: null,
    records: [
      entry("member", member, { salt, opens: COMMITMENT_INDEX["member"] }),
      entry("standing", standing, { cites }),
      entry("season", season, { table }),
    ],
  };
  const ask = async () => 1_810_000_000;
  const good = await checkRecordFile(file, { ask });
  assert.ok(good.ok, JSON.stringify(good));
  assert.deepEqual(good.entries.map((e) => [e.checks.season, e.checks.theirs, e.checks.list]), [[true, true, null], [true, null, true], [true, null, true]]);

  const dropped = structuredClone(file);
  dropped.records[1].cites = cites.slice(1);
  assert.equal((await checkRecordFile(dropped, { ask })).entries[1].checks.list, false, "a standing citing fewer results does not add up");
  const reordered = structuredClone(file);
  reordered.records[2].table = [...table].reverse();
  assert.equal((await checkRecordFile(reordered, { ask })).entries[2].checks.list, false, "the table's order is part of the season");
  const notTheirs = structuredClone(file);
  notTheirs.records[0].salt = toHex(randomBytes(32));
  assert.equal((await checkRecordFile(notTheirs, { ask })).ok, false);
  const otherSeason = structuredClone(file);
  otherSeason.records[0].seasonId = crypto.randomUUID();
  assert.equal((await checkRecordFile(otherSeason, { ask })).entries[0].checks.season, false);
});
