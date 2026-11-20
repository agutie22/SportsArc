/**
 * Runnable checks for the record's pure logic: no database, no chain.
 *
 *   node --import=tsx api/web3/record/check.ts            # assert
 *   node --import=tsx api/web3/record/check.ts --print    # dump vectors
 *
 * The pinned hashes below are also pinned in contracts/test/SportsArcRecord.t.sol,
 * which rebuilds each record in Solidity from the same inputs. If hashes.ts
 * changes an encoding, this fails first and both files must change together.
 */

import assert from "node:assert/strict";
import { encodeAbiParameters, keccak256, stringToBytes, type Hex } from "viem";
import { gameKey } from "../ids.js";
import { playerCode, userKey } from "./keys.js";
import {
  checkInValues, gameValues, idKey, kindOfTag, listHash, memberValues, NO_SIDE, noShowValues, presenceFields, presenceValues,
  RECORD_KINDS, recordHash, resultFields, resultValues, seasonValues, seatFields, standingFields, standingValues,
} from "./hashes.js";

// ── fixed inputs (mirrored in SportsArcRecord.t.sol) ─────────────────────

const G1 = "3f1c2a9e-5b7d-4e8f-9a01-2b3c4d5e6f70";
const G2 = "A8B9C0D1-E2F3-4a5b-8c6d-7e8f90a1b2c3"; // mixed case: keys lowercase it
const U = [
  "0d6f4a1e-7c2b-4f3a-9e8d-1a2b3c4d5e6f",
  "5e4d3c2b-1a09-4f8e-8d7c-6b5a49382716",
  "c0ffee00-1234-4abc-8def-0123456789ab",
];
const salt = (i: number): Hex => keccak256(stringToBytes(`sportsarc record test salt ${i}`));

const INPUTS = [
  { gameId: G1, userId: U[0], checkedInAt: new Date("2026-09-20T17:05:09Z"), salt: salt(0) },
  { gameId: G1, userId: U[1], checkedInAt: new Date("2026-09-20T17:12:44.900Z"), salt: salt(1) },
  { gameId: G1, userId: U[2], checkedInAt: new Date("2026-09-20T16:58:00Z"), salt: salt(2) },
  { gameId: G2, userId: U[0], checkedInAt: new Date("2026-09-21T01:30:00Z"), salt: salt(3) },
  { gameId: G2, userId: U[2], checkedInAt: new Date("2026-09-21T01:41:17Z"), salt: salt(4) },
];

/** Which input the pinned check-in is. */
const TARGET = 1;

// ── pinned outputs ────────────────────────────────────────────────────

/** checkin for INPUTS[TARGET]: G1, U[1], salt 1, 2026-09-20T17:12:44Z. Pinned in SportsArcRecord.t.sol. */
const CHECKIN_RECORD = "0xd21b654c88b19c1bc3f4c4d9f956ef8bcba7feff5b19576724dcba685ec695d0";
/** game for G1: basketball, venue V, starts 2026-09-20T18:00:00Z, host U[0], salt 5. Pinned in SportsArcRecord.t.sol. */
const GAME_RECORD = "0x951867459e0ed167674d1833dab165785cbd2eb6dda69994b5551ee81f8d05b1";
/** result for G1, U[1], salt 6: side 1, a win for side 1, final 2026-09-20T20:30:00Z. Pinned in SportsArcRecord.t.sol. */
const RESULT_RECORD = "0xacffe2815d09bbdf246d561e1c6dbc3a67804159ccc27ac10556a7f418fb2f1c";
/** presence for G1, U[2], salt 8: not here, final 2026-09-21T19:15:00Z. Pinned in SportsArcRecord.t.sol. */
const PRESENCE_RECORD = "0xa12bde455c8b3e18059a3717e089ec4041f8b2c4e141d3f7ab57e3d107bf699c";
/** noshow for G1, U[0], salt 0, closedAt 2026-09-20T18:15:00Z. Pinned in SportsArcRecord.t.sol. */
const NOSHOW_RECORD = "0x924ca9fab0b558e2f45db4f7bccd55ffaf7d2ef8ac2f94779d1cc8e17fda0b60";

/** Season records (Stage 5). Pinned in SportsArcRecord.t.sol test_seasonRecordsMatchTypescript. */
const SEASON_ID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const TEAM_1 = "1b2c3d4e-5f60-4718-9a2b-3c4d5e6f7081";
const TEAM_2 = "F0E1D2C3-B4A5-4968-8776-655443322110"; // mixed case: keys lowercase it
const ORG_ID = "2468ace0-1357-4bdf-8ace-0123456789ab";
const SEASON_FINAL = new Date("2027-03-30T02:00:00Z");
/** standing for TEAM_1: 5-1-0, 1st, citing keccak256("result one") and ("result two"). */
const STANDING_RECORD = "0x1bcc4abe1a727c83447229e47fdf309455d1d27db35a81b32229660677c8a33d";
/** standing for TEAM_2: 1-5-0, 2nd, citing nothing. */
const STANDING_RECORD_2 = "0x74a7f5ce98ad29b7882e14a960188d3df1675d22d9e604e179582c37793fc815";
/** member for TEAM_1, U[1], salt 9. */
const MEMBER_RECORD = "0x04944e8fdaae6120053ef272266cb0871f91115981bcb184ff03e29daa118b9f";
/** season for SEASON_ID run by ORG_ID, standings [TEAM_1, TEAM_2]. */
const SEASON_RECORD = "0xd8b2a3bb97585fcb2275166fddac0fc34aad2af889619e917cec7686d6381715";

// ── checks ────────────────────────────────────────────────────────────

const values = INPUTS.map(checkInValues);
const hashes = values.map((v) => recordHash("checkin", v));
const closedAt = new Date("2026-09-20T18:15:00Z");
const noShow = noShowValues({ gameId: G1, userId: U[0], closedAt, salt: salt(0) });
const noShowHash = recordHash("noshow", noShow);
const V = "7b1e0c4a-2d3f-4e5a-8b6c-9d0e1f2a3b4c";
const game = gameValues({ gameId: G1, sport: "Basketball", venueId: V, startsAt: new Date("2026-09-20T18:00:00Z"), hostId: U[0], salt: salt(5) });
const gameHash = recordHash("game", game);
const result = resultValues({
  gameId: G1, userId: U[1], side: 1, outcome: "win", winningSide: 1, finalAt: new Date("2026-09-20T20:30:00Z"), salt: salt(6),
});
const resultHash = recordHash("result", result);
const presence = presenceValues({ gameId: G1, userId: U[2], present: false, finalAt: new Date("2026-09-21T19:15:00Z"), salt: salt(8) });
const presenceHash = recordHash("presence", presence);

const resultOne = keccak256(stringToBytes("result one"));
const resultTwo = keccak256(stringToBytes("result two"));
const standing1 = standingValues({ seasonId: SEASON_ID, teamId: TEAM_1, wins: 5, losses: 1, ties: 0, place: 1, resultHashes: [resultTwo, resultOne], finalAt: SEASON_FINAL });
const standing2 = standingValues({ seasonId: SEASON_ID, teamId: TEAM_2, wins: 1, losses: 5, ties: 0, place: 2, resultHashes: [], finalAt: SEASON_FINAL });
const standingHash = recordHash("standing", standing1);
const standingHash2 = recordHash("standing", standing2);
const member = memberValues({ seasonId: SEASON_ID, teamId: TEAM_1, userId: U[1], finalAt: SEASON_FINAL, salt: salt(9) });
const memberHash = recordHash("member", member);
const season = seasonValues({ seasonId: SEASON_ID, orgId: ORG_ID, standingHashes: [standingHash, standingHash2], finalAt: SEASON_FINAL });
const seasonHash = recordHash("season", season);

if (process.argv.includes("--print")) {
  console.log(JSON.stringify({
    values, hashes, target: hashes[TARGET], noShow, noShowHash, game, gameHash, result, resultHash, presence, presenceHash,
    standing1, standingHash, standing2, standingHash2, member, memberHash, season, seasonHash,
  }, null, 2));
  process.exit(0);
}

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`ok  ${name}`);
}

check("kind tags are keccak256 of their names, and map back", () => {
  assert.equal(RECORD_KINDS["checkin"].tag, keccak256(stringToBytes("checkin")));
  assert.equal(RECORD_KINDS["noshow"].tag, keccak256(stringToBytes("noshow")));
  assert.equal(kindOfTag(RECORD_KINDS["noshow"].tag.toUpperCase().replace("0X", "0x")), "noshow");
  assert.equal(kindOfTag(keccak256(stringToBytes("other"))), null);
});

check("a record hash is keccak256(abi.encode(values)), single-hashed", () => {
  const v = values[TARGET];
  const direct = keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint64" }],
    [v[0] as Hex, v[1] as Hex, v[2] as Hex, BigInt(v[3])],
  ));
  assert.equal(hashes[TARGET], direct);
});

check("record values hold hashes and seconds only", () => {
  const v = values[TARGET];
  assert.equal(v[1], gameKey(G1));
  assert.equal(v[2], playerCode(userKey(U[1]), salt(1)));
  assert.equal(v[3], String(Date.UTC(2026, 8, 20, 17, 12, 44) / 1000)); // .900 s truncated
  for (const s of values.flat()) {
    for (const id of [G1, G2, ...U]) assert.ok(!s.toLowerCase().includes(id.toLowerCase().replace(/-/g, "")));
  }
  assert.deepEqual(seatFields(v), { game: v[1], participant: v[2], at: Number(v[3]) });
});

check("keys are case-insensitive over UUIDs", () => {
  assert.equal(userKey(U[0].toUpperCase()), userKey(U[0]));
  assert.equal(values[3][1], gameKey(G2.toLowerCase()));
});

check("a fresh salt unlinks the same user across records", () => {
  assert.notEqual(values[0][2], values[3][2]); // U[0] in G1 and in G2
});

check("every record has its own hash", () => {
  assert.equal(new Set(hashes).size, hashes.length);
});

check("any changed field is a different record", () => {
  const v = values[TARGET];
  for (let i = 1; i < v.length; i++) {
    const changed = [...v];
    changed[i] = i === 3 ? String(Number(v[3]) + 1) : keccak256(v[i] as Hex);
    assert.notEqual(recordHash("checkin", changed), hashes[TARGET], `field ${i}`);
  }
});

check("a no-show is a different kind over the same seat shape", () => {
  assert.equal(noShow[0], RECORD_KINDS["noshow"].tag);
  assert.equal(noShow[1], gameKey(G1));
  assert.equal(noShow[2], playerCode(userKey(U[0]), salt(0)));
  assert.equal(noShow[3], String(Date.parse("2026-09-20T18:15:00Z") / 1000));
  const sameSeatCheckIn = checkInValues({ ...INPUTS[0], checkedInAt: closedAt });
  assert.notEqual(noShowHash, recordHash("checkin", sameSeatCheckIn));
});

check("a game record holds hashes, seconds and a salted host only", () => {
  assert.equal(game[0], RECORD_KINDS["game"].tag);
  assert.equal(game[1], gameKey(G1));
  assert.equal(game[2], keccak256(stringToBytes("basketball")), "sport is lowercased");
  assert.equal(game[3], keccak256(stringToBytes(V)));
  assert.equal(game[4], String(Date.parse("2026-09-20T18:00:00Z") / 1000));
  assert.equal(game[5], playerCode(userKey(U[0]), salt(5)));
  assert.notEqual(game[5], values[0][2], "the host's commitment is not their check-in's");
});

check("a result record: side, outcome, winning side, final time; fields read back", () => {
  assert.deepEqual(result.slice(3), ["1", "0", "1", String(Date.parse("2026-09-20T20:30:00Z") / 1000)]);
  assert.deepEqual(resultFields(result), { side: 1, outcome: "win", winningSide: 1, finalAt: Date.parse("2026-09-20T20:30:00Z") / 1000 });
  const satOut = resultValues({ gameId: G1, userId: U[2], side: null, outcome: "draw", winningSide: 0, finalAt: new Date(0), salt: salt(7) });
  assert.equal(satOut[3], String(NO_SIDE));
  assert.equal(satOut[5], String(NO_SIDE), "a draw has no winning side, whatever was passed");
  assert.deepEqual(resultFields(satOut), { side: null, outcome: "draw", winningSide: null, finalAt: 0 });
  assert.notEqual(result[2], values[TARGET][2], "a fresh salt: the result does not link to the check-in");
});

check("a presence record: the host's here or not, final time; fields read back", () => {
  assert.deepEqual(presence.slice(3), ["0", String(Date.parse("2026-09-21T19:15:00Z") / 1000)]);
  assert.deepEqual(presenceFields(presence), { present: false, finalAt: Date.parse("2026-09-21T19:15:00Z") / 1000 });
  const here = presenceValues({ gameId: G1, userId: U[2], present: true, finalAt: new Date("2026-09-21T19:15:00Z"), salt: salt(8) });
  assert.notEqual(recordHash("presence", here), presenceHash, "here and not here are different records");
  assert.notEqual(presence[2], values[2][2], "a fresh salt: it does not link to the check-in");
});

check("a standing cites its results as one sorted list hash, whatever order they came in", () => {
  assert.equal(standing1[1], idKey(SEASON_ID));
  assert.equal(standing1[2], idKey(TEAM_1));
  assert.equal(standing2[2], idKey(TEAM_2.toLowerCase()), "team keys lowercase the UUID");
  assert.equal(standing1[7], listHash([resultTwo, resultOne].sort()));
  const reordered = standingValues({ seasonId: SEASON_ID, teamId: TEAM_1, wins: 5, losses: 1, ties: 0, place: 1, resultHashes: [resultOne, resultTwo], finalAt: SEASON_FINAL });
  assert.equal(recordHash("standing", reordered), standingHash);
  assert.equal(standing2[7], keccak256("0x"), "no results: keccak256 of nothing");
  assert.deepEqual(
    { wins: standingFields(standing1).wins, losses: standingFields(standing1).losses, place: standingFields(standing1).place },
    { wins: 5, losses: 1, place: 1 },
  );
  const changed = standingValues({ seasonId: SEASON_ID, teamId: TEAM_1, wins: 5, losses: 1, ties: 0, place: 2, resultHashes: [resultOne, resultTwo], finalAt: SEASON_FINAL });
  assert.notEqual(recordHash("standing", changed), standingHash, "another place is another record");
});

check("a member record is a salted player on a team that season; the season names its organizer and table", () => {
  assert.equal(member[3], playerCode(userKey(U[1]), salt(9)));
  assert.notEqual(member[3], values[TARGET][2], "a fresh salt: it does not link to the player's games");
  assert.equal(season[2], idKey(ORG_ID));
  assert.equal(season[3], listHash([standingHash, standingHash2]));
  assert.notEqual(listHash([standingHash2, standingHash]), season[3], "the table's order is part of it");
  for (const v of [...standing1, ...member, ...season]) {
    for (const id of [SEASON_ID, TEAM_1, TEAM_2, ORG_ID, ...U]) assert.ok(!v.toLowerCase().includes(id.toLowerCase().replace(/-/g, "")));
  }
});

check("pinned vectors match (keep SportsArcRecord.t.sol in step)", () => {
  assert.equal(standingHash, STANDING_RECORD);
  assert.equal(standingHash2, STANDING_RECORD_2);
  assert.equal(memberHash, MEMBER_RECORD);
  assert.equal(seasonHash, SEASON_RECORD);
  assert.equal(hashes[TARGET], CHECKIN_RECORD);
  assert.equal(noShowHash, NOSHOW_RECORD);
  assert.equal(gameHash, GAME_RECORD);
  assert.equal(resultHash, RESULT_RECORD);
  assert.equal(presenceHash, PRESENCE_RECORD);
});

console.log(`\n${passed} checks passed`);
