/**
 * What goes into a SportsArcRecord record, per record kind. Solidity mirror:
 * contracts/src/record/RecordHash.sol; change both together (check.ts
 * and test/SportsArcRecord.t.sol pin the same vectors).
 *
 * A record hash is keccak256(abi.encode(...values)), and values[0] is
 * always the kind tag, so a record of one kind can never pass as another.
 * Each record is written on its own (SportsArcRecord.write), and verifying it
 * is a lookup of this hash (SportsArcRecord.writtenAt).
 *
 * No personal data in a record. A check-in commits to:
 *   kind         keccak256("checkin")
 *   game         gameKey() from ../ids.ts
 *   participant  playerCode() from ./keys.ts: a salted commitment, fresh
 *                salt per record (why salted: see keys.ts)
 *   checkedInAt  unix seconds
 *
 * A no-show commits to the same shape with a different tag:
 *   kind         keccak256("noshow")
 *   game         gameKey()
 *   participant  the same salted commitment
 *   closedAt     unix seconds when that game's check-in closed
 *
 * What a game was (game), one per game, written when check-in closes:
 *   kind         keccak256("game")
 *   game         gameKey()
 *   sport        keccak256 of the lowercase sport ("basketball")
 *   venue        keccak256 of the lowercase venue UUID
 *   startsAt     unix seconds
 *   host         playerCode() of the host, its own fresh salt
 *
 * A result (result), one per seat of a game result, written once the
 * host can no longer correct it:
 *   kind         keccak256("result")
 *   game         gameKey()
 *   participant  playerCode(), a fresh salt (not the check-in's)
 *   side         0 or 1; SAT_OUT (255) for a seat checked in on no side
 *   outcome      OUTCOME_CODES: 0 win, 1 draw, 2 not played
 *   winningSide  0 or 1 on a win; NO_SIDE (255) otherwise
 *   finalAt      unix seconds when the result stopped being correctable
 *
 * The host's word on whether a player was there (presence), one per
 * seat, written once the host's roster confirmation is final:
 *   kind         keccak256("presence")
 *   game         gameKey()
 *   participant  playerCode(), a fresh salt
 *   present      1 here, 0 not here
 *   finalAt      unix seconds when the confirmation stopped being correctable
 *
 * A season, written once the organizer finishes it and every result it
 * counts is on chain (writer.ts buildSeasonRecords). Team, season and
 * league names stay off chain, like venue names.
 *
 * A team's final standing (standing), one per team:
 *   kind         keccak256("standing")
 *   season       keccak256 of the lowercase season UUID
 *   team         keccak256 of the lowercase team UUID
 *   wins, losses, ties, place
 *   results      listHash() of the result record hashes it counts (the
 *                team's own seats in the season's games), sorted: the
 *                standing cites the public results instead of restating them
 *   finalAt      unix seconds when the organizer finished the season
 *
 * A player on a team that season (member), one per rostered player:
 *   kind         keccak256("member")
 *   season, team as above
 *   participant  playerCode(), a fresh salt
 *   finalAt      as above
 *
 * The season itself (season), one per season:
 *   kind         keccak256("season")
 *   season       as above
 *   organizer    keccak256 of the lowercase UUID of the organization that ran it
 *   standings    listHash() of its standing hashes, in place order (ties
 *                by team key): the whole table in one value
 *   finalAt      as above
 *
 * A new kind adds an entry to RECORD_KINDS with its own tag and encoding
 * (starting with the tag). The writer, storage, contract and browser check
 * are kind-agnostic. docs/verified-record.md has the steps.
 */

import { concat, encodeAbiParameters, keccak256, stringToBytes, type AbiParameter, type Hex } from "viem";
import { gameKey } from "../ids.js";
import { playerCode, userKey } from "./keys.js";

const SEAT_ENCODING = ["bytes32", "bytes32", "bytes32", "uint64"] as const;

export const RECORD_KINDS = {
  "checkin": {
    tag: keccak256(stringToBytes("checkin")),
    encoding: SEAT_ENCODING,
  },
  "noshow": {
    tag: keccak256(stringToBytes("noshow")),
    encoding: SEAT_ENCODING,
  },
  "game": {
    tag: keccak256(stringToBytes("game")),
    encoding: ["bytes32", "bytes32", "bytes32", "bytes32", "uint64", "bytes32"],
  },
  "result": {
    tag: keccak256(stringToBytes("result")),
    encoding: ["bytes32", "bytes32", "bytes32", "uint8", "uint8", "uint8", "uint64"],
  },
  "presence": {
    tag: keccak256(stringToBytes("presence")),
    encoding: ["bytes32", "bytes32", "bytes32", "uint8", "uint64"],
  },
  "standing": {
    tag: keccak256(stringToBytes("standing")),
    encoding: ["bytes32", "bytes32", "bytes32", "uint16", "uint16", "uint16", "uint16", "bytes32", "uint64"],
  },
  "member": {
    tag: keccak256(stringToBytes("member")),
    encoding: ["bytes32", "bytes32", "bytes32", "bytes32", "uint64"],
  },
  "season": {
    tag: keccak256(stringToBytes("season")),
    encoding: ["bytes32", "bytes32", "bytes32", "bytes32", "uint64"],
  },
} as const satisfies Record<string, { tag: Hex; encoding: readonly string[] }>;

export type RecordKind = keyof typeof RECORD_KINDS;

export function isRecordKind(v: string): v is RecordKind {
  return v in RECORD_KINDS;
}

/** The kind whose tag is `tag`, or null. */
export function kindOfTag(tag: string): RecordKind | null {
  const t = tag.toLowerCase();
  for (const [kind, def] of Object.entries(RECORD_KINDS)) if (def.tag === t) return kind as RecordKind;
  return null;
}

/** The seat records: one per seat, the attendance of that seat. */
export const ATTENDANCE_KINDS = ["checkin", "noshow"] as const;

/** side and winningSide when there is none. */
export const NO_SIDE = 255;
export const SAT_OUT = NO_SIDE;
export const OUTCOME_CODES = { win: 0, draw: 1, not_played: 2 } as const;
export type OutcomeName = keyof typeof OUTCOME_CODES;

export interface CheckInInput {
  gameId: string;
  userId: string;
  checkedInAt: Date;
  salt: Hex;
}

/** ABI values of a check-in record, as decimal/hex strings. */
export function checkInValues(input: CheckInInput): string[] {
  return seatValues("checkin", input.gameId, input.userId, input.checkedInAt, input.salt);
}

export interface NoShowInput {
  gameId: string;
  userId: string;
  /** When check-in closed for the game. */
  closedAt: Date;
  salt: Hex;
}

/** A seat that was still held when check-in closed, with no check-in. */
export function noShowValues(input: NoShowInput): string[] {
  return seatValues("noshow", input.gameId, input.userId, input.closedAt, input.salt);
}

export interface GameInput {
  gameId: string;
  sport: string;
  venueId: string;
  startsAt: Date;
  hostId: string;
  salt: Hex;
}

/** What the game was: its sport, venue, start and a commitment to its host. */
export function gameValues(input: GameInput): string[] {
  return [
    RECORD_KINDS["game"].tag,
    gameKey(input.gameId),
    keccak256(stringToBytes(input.sport.toLowerCase())),
    keccak256(stringToBytes(input.venueId.toLowerCase())),
    seconds(input.startsAt),
    playerCode(userKey(input.hostId), input.salt),
  ];
}

export interface ResultInput {
  gameId: string;
  userId: string;
  /** 0, 1, or null for a seat on no side. */
  side: number | null;
  outcome: OutcomeName;
  /** 0 or 1 on a win, else null. */
  winningSide: number | null;
  finalAt: Date;
  salt: Hex;
}

/** One seat's result: its side, how the game ended, and when that became final. */
export function resultValues(input: ResultInput): string[] {
  return [
    RECORD_KINDS["result"].tag,
    gameKey(input.gameId),
    playerCode(userKey(input.userId), input.salt),
    String(input.side === 0 || input.side === 1 ? input.side : SAT_OUT),
    String(OUTCOME_CODES[input.outcome]),
    String(input.outcome === "win" && (input.winningSide === 0 || input.winningSide === 1) ? input.winningSide : NO_SIDE),
    seconds(input.finalAt),
  ];
}

export interface PresenceInput {
  gameId: string;
  userId: string;
  present: boolean;
  finalAt: Date;
  salt: Hex;
}

/** The host's word on one seat: here or not, and when that became final. */
export function presenceValues(input: PresenceInput): string[] {
  return [
    RECORD_KINDS["presence"].tag,
    gameKey(input.gameId),
    playerCode(userKey(input.userId), input.salt),
    input.present ? "1" : "0",
    seconds(input.finalAt),
  ];
}

/** keccak256 of a lowercase UUID: the on-chain key of a season, team or organization. */
export function idKey(id: string): Hex {
  return keccak256(stringToBytes(id.toLowerCase()));
}

/**
 * One value standing for a list of record hashes: keccak256 of them
 * concatenated in the given order (Solidity: keccak256(abi.encodePacked(list))).
 */
export function listHash(hashes: readonly string[]): Hex {
  return keccak256(hashes.length ? concat(hashes as Hex[]) : "0x");
}

export interface StandingInput {
  seasonId: string;
  teamId: string;
  wins: number;
  losses: number;
  ties: number;
  place: number;
  /** The result hashes the standing counts; sorted here. */
  resultHashes: readonly string[];
  finalAt: Date;
}

/** A team's final standing, citing the results it was counted from. */
export function standingValues(input: StandingInput): string[] {
  return [
    RECORD_KINDS["standing"].tag,
    idKey(input.seasonId),
    idKey(input.teamId),
    String(input.wins),
    String(input.losses),
    String(input.ties),
    String(input.place),
    listHash([...input.resultHashes].map((h) => h.toLowerCase()).sort()),
    seconds(input.finalAt),
  ];
}

export function standingFields(values: readonly string[]) {
  return {
    season: values[1] as Hex, team: values[2] as Hex,
    wins: Number(values[3]), losses: Number(values[4]), ties: Number(values[5]), place: Number(values[6]),
    results: values[7] as Hex, finalAt: Number(values[8]),
  };
}

export interface MemberInput {
  seasonId: string;
  teamId: string;
  userId: string;
  finalAt: Date;
  salt: Hex;
}

/** A player on a team that season, as a salted commitment. */
export function memberValues(input: MemberInput): string[] {
  return [
    RECORD_KINDS["member"].tag,
    idKey(input.seasonId),
    idKey(input.teamId),
    playerCode(userKey(input.userId), input.salt),
    seconds(input.finalAt),
  ];
}

export interface SeasonInput {
  seasonId: string;
  orgId: string;
  /** standing hashes in place order (ties by team key). */
  standingHashes: readonly string[];
  finalAt: Date;
}

/** The season: who ran it and its whole table in one value. */
export function seasonValues(input: SeasonInput): string[] {
  return [
    RECORD_KINDS["season"].tag,
    idKey(input.seasonId),
    idKey(input.orgId),
    listHash(input.standingHashes.map((h) => h.toLowerCase())),
    seconds(input.finalAt),
  ];
}

/** A presence record's fields in words. */
export function presenceFields(values: readonly string[]) {
  return { present: values[3] === "1", finalAt: Number(values[4]) };
}

const seconds = (d: Date) => String(Math.floor(d.getTime() / 1000));

function seatValues(kind: RecordKind, gameId: string, userId: string, at: Date, salt: Hex): string[] {
  return [
    RECORD_KINDS[kind].tag,
    gameKey(gameId),
    playerCode(userKey(userId), salt),
    String(Math.floor(at.getTime() / 1000)),
  ];
}

/** Stored string values back to what viem encodes (uints as bigint). */
function decodeValues(types: readonly string[], values: readonly string[]): unknown[] {
  if (types.length !== values.length) throw new Error("Record values do not match the kind's encoding.");
  return values.map((v, i) => (/^u?int\d*$/.test(types[i]) ? BigInt(v) : v));
}

/** keccak256(abi.encode(...values)): the record's ID on chain. */
export function recordHash(kind: RecordKind, values: readonly string[]): Hex {
  const { encoding } = RECORD_KINDS[kind];
  const params = encoding.map((type) => ({ type })) as AbiParameter[];
  return keccak256(encodeAbiParameters(params, decodeValues(encoding, values)));
}

/** The named fields of a seat record (check-in or no-show), for "check it yourself". */
export function seatFields(values: readonly string[]) {
  return { game: values[1] as Hex, participant: values[2] as Hex, at: Number(values[3]) };
}

/** A result record's fields in words, for the receipt. */
export function resultFields(values: readonly string[]) {
  const side = Number(values[3]);
  const outcome = (Object.keys(OUTCOME_CODES) as OutcomeName[]).find((k) => OUTCOME_CODES[k] === Number(values[4])) ?? "not_played";
  const winning = Number(values[5]);
  return {
    side: side === SAT_OUT ? null : side,
    outcome,
    winningSide: winning === NO_SIDE ? null : winning,
    finalAt: Number(values[6]),
  };
}
