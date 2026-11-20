/**
 * Looking records up, and who may. Every record is its own entry on
 * SportsArcRecord, so checking one is a single question to the contract:
 * writtenAt(hash), the block time it was written, or 0.
 *
 * Two doors, neither of which reveals whose records exist:
 *
 *  - The participant, signed in, asks for *their own* record in a game
 *    (addressed as game + session user, GameParticipant's unique key).
 *    Nobody can name another user, so "not found" says nothing about anyone
 *    else. This is the only response that carries the salt that opens the
 *    participant commitment.
 *
 *  - Anyone may look a record up by its hash, with no sign-in. A hash is
 *    unguessable (it commits to a 256-bit salt), so holding one means the
 *    participant shared it; this door works as a verification link. It
 *    returns the kind and where it was written, never the values, and asks
 *    the contract itself (`onChain`), so the link shows the chain's answer,
 *    not ours.
 *
 * The profile badge needs one more thing: how many of a person's records
 * are confirmed. That count is no more than the "games played" a profile
 * already shows, so it is public to signed-in users. The games behind it
 * are record.ts's business: public from the profile unless the player has
 * hidden them, and always shown to their owner and to a share link.
 */

import type { EntityManager } from "@mikro-orm/postgresql";
import { getAddress, type Hex } from "viem";
import { GameParticipant } from "../../entities/GameParticipant.js";
import { User } from "../../entities/User.js";
import { fail } from "../../failure.js";
import { isUuid } from "../../validate.js";
import { publicChainView, publicClient } from "../chains.js";
import { recordAbi } from "./abi.js";
import { RecordEntry } from "./RecordEntry.js";
import { userKey } from "./keys.js";
import { ATTENDANCE_KINDS, isRecordKind, presenceFields, RECORD_KINDS, recordHash } from "./hashes.js";
import { recordChain, verifyingCount, whereWritten } from "./record.js";

const HASH_RE = /^0x[0-9a-f]{64}$/i;

/** A stored row whose values no longer hash to its hash is never served. */
function intact(row: RecordEntry): boolean {
  return isRecordKind(row.kind) && recordHash(row.kind, row.values) === row.hash;
}

/**
 * SportsArcRecord.writtenAt(hash) on the chain the record was written to:
 * when it was written (ISO), false when the contract has no such record,
 * null when it cannot be asked (not written yet, another chain, RPC down).
 */
async function askContract(row: RecordEntry): Promise<string | false | null> {
  if (row.status !== "confirmed" || !row.contract || !row.chainId) return null;
  try {
    const client = publicClient();
    if (client.chain.id !== row.chainId) return null;
    const at = await client.readContract({
      address: getAddress(row.contract), abi: recordAbi, functionName: "writtenAt", args: [row.hash as Hex],
    });
    return at > 0n ? new Date(Number(at) * 1000).toISOString() : false;
  } catch {
    return null;
  }
}

/** The signed-in user's own record in `gameId`, with everything to open it. */
export async function ownRecord(em: EntityManager, user: User, gameId: string) {
  const notFound = fail("NOT_FOUND", "You have no seat in that game.");
  if (!isUuid(gameId)) return notFound;
  const seat = await em.findOne(GameParticipant, { game: gameId.toLowerCase(), user });
  if (!seat) return notFound;
  const row = await em.findOne(RecordEntry, { slot: `attendance:${seat.id}` });
  if (!row) return fail("NOT_WRITTEN", "This game is not on the record yet. Records are written once check-in closes.");
  if (!intact(row)) return fail("RECORD_MISMATCH", "Stored record does not match its values.");
  return {
    ok: true as const,
    kind: row.kind,
    hash: row.hash,
    chain: whereWritten(row),
    encoding: isRecordKind(row.kind) ? RECORD_KINDS[row.kind].encoding : [],
    values: row.values,
    // The opening: participant = keccak256(abi.encode(userKey, salt)).
    opening: { userKey: userKey(user.id), salt: row.salt ?? null },
  };
}

/** Anyone holding a record hash: the kind and where it was written, never the values. */
export async function recordByHash(em: EntityManager, hash: string) {
  if (!HASH_RE.test(hash)) return fail("VALIDATION_ERROR", "Expected a 32-byte hex record ID.");
  const row = await em.findOne(RecordEntry, { hash: hash.toLowerCase() });
  if (!row) return fail("NOT_FOUND", "No record has that ID.");
  if (!intact(row)) return fail("RECORD_MISMATCH", "Stored record does not match its values.");
  const onChain = await askContract(row);
  return {
    ok: true as const,
    kind: row.kind,
    hash: row.hash,
    chain: whereWritten(row),
    /** The contract's own answer: when it was written, false if it has no such record, null if it could not be asked. */
    onChain,
    network: publicChainView(),
  };
}

/**
 * Of these attendance records, the seats whose missed game the host
 * confirmed as here (a confirmed presence saying 1). With a check-in,
 * that is showing up: either source is enough (social/reliability.ts).
 */
async function hostSaidHere(em: EntityManager, rows: RecordEntry[]): Promise<Set<string>> {
  const missed = rows.filter((r) => r.kind === "noshow" && r.participant).map((r) => `presence:${r.participant!.id}`);
  if (!missed.length) return new Set();
  const presence = await em.find(RecordEntry, { slot: { $in: missed }, status: "confirmed", kind: "presence" });
  return new Set(presence.filter((p) => presenceFields(p.values).present && p.participant).map((p) => p.participant!.id));
}

const showed = (r: RecordEntry, here: Set<string>) => r.kind === "checkin" || (r.participant ? here.has(r.participant.id) : false);

/**
 * How many of a person's records are confirmed, how many finished games
 * are still waiting to be written, and the latest record (with its hash,
 * so the browser can ask SportsArcRecord itself).
 */
export async function verifiedSummary(em: EntityManager, userId: string) {
  if (!isUuid(userId)) return fail("NOT_FOUND", "No such person.");
  const id = userId.toLowerCase();
  const user = await em.findOne(User, { id });
  const rows = await em.find(
    RecordEntry,
    { participant: { user: id }, status: "confirmed", kind: { $in: [...ATTENDANCE_KINDS] } },
    { orderBy: { writtenAt: "DESC" } },
  );
  const latest = rows[0];
  const here = await hostSaidHere(em, rows);
  return {
    ok: true as const,
    verified: rows.length,
    /** Of those, the games they checked in to (the rest are missed games). */
    checkIns: rows.filter((r) => r.kind === "checkin").length,
    /** The games they showed up to: checked in, or the host confirmed them as here. */
    showedUp: rows.filter((r) => showed(r, here)).length,
    verifying: await verifyingCount(em, id, new Set(rows.map((r) => r.participant?.id))),
    latest: latest ? { hash: latest.hash, ...whereWritten(latest) } : null,
    chain: recordChain(),
    /** The game list is hidden; the counts above stay. */
    private: Boolean(user?.recordPrivate),
  };
}

/** Most people one list asks about at once. */
export const COUNTS_MAX = 100;

/** The same two counts for a list of people (directory, a game's roster), keyed by user id. */
export async function verifiedCounts(em: EntityManager, ids: string[]) {
  const list = [...new Set(ids.filter(isUuid).map((id) => id.toLowerCase()))].slice(0, COUNTS_MAX);
  const people: Record<string, { verified: number; checkIns: number; showedUp: number }> = {};
  for (const id of list) people[id] = { verified: 0, checkIns: 0, showedUp: 0 };
  if (list.length) {
    const rows = await em.find(
      RecordEntry,
      { participant: { user: { $in: list } }, status: "confirmed", kind: { $in: [...ATTENDANCE_KINDS] } },
      { populate: ["participant"] },
    );
    const here = await hostSaidHere(em, rows);
    for (const r of rows) {
      const c = people[r.participant?.user.id ?? ""];
      if (!c) continue;
      c.verified += 1;
      if (r.kind === "checkin") c.checkIns += 1;
      if (showed(r, here)) c.showedUp += 1;
    }
  }
  return { ok: true as const, people };
}
