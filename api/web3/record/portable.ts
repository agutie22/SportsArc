/**
 * The portable record: a player's own entries in one file they can keep,
 * hand to a coach or scout, and have checked with no SportsArc involved
 * (frontend/verify-record.mjs, which only asks the chain's public RPC).
 *
 *   exportRecord      the file, for the signed-in player only
 *   startOwnership    opens a PIN challenge for the player's wallet to sign
 *                     RecordOwner { player, wallet, issuedAt }
 *   confirmOwnership  checks and keeps that signature; later files carry it
 *
 * What the file holds, per entry: its kind, its values in the kind's ABI
 * encoding, its hash and where it was written, and the salt that opens the
 * player's commitment inside it (`opens` names which value that is). It
 * also holds the player key (keccak256 of the user id) that, with each
 * salt, shows the entry is theirs. Holding the file therefore proves those
 * games are this player's: it is theirs to share, and only they can
 * download it.
 *
 * Game records (game) come with every game the player has an entry in,
 * but carry the host's salt only when the player is the host: another
 * person's salt is theirs alone. SportsArc's own details (sport, venue,
 * start time, names) ride along as `about`, marked as SportsArc's word;
 * the checker relies on the values and the chain only.
 *
 * League seasons come the same way: the player's member (with its
 * salt), plus their team's standing and the season as context, with
 * no salt. A standing carries `cites`, the result hashes it counted, and
 * a season carries `table`, its standing hashes in order, so the checker
 * can recompute both list hashes itself.
 *
 * The ownership signature is optional and, like every signature, adults
 * and guardians only (wallet/signature.ts). Without it the file still
 * proves the entries exist and open with the player key; with it, anyone
 * can see which wallet vouches for that key.
 */

import type { EntityManager } from "@mikro-orm/postgresql";
import { getAddress, isAddress, type Address } from "viem";
import type { User } from "../../entities/User.js";
import { fail } from "../../failure.js";
import { UserSignature } from "../wallet/UserSignature.js";
import { acceptSignature, parseTypedDataJson, requestSignature, type TypedData } from "../wallet/signature.js";
import { publicChainView } from "../chains.js";
import { contractAddress } from "../contracts.js";
import { RecordEntry } from "./RecordEntry.js";
import { userKey } from "./keys.js";
import { ATTENDANCE_KINDS, isRecordKind, RECORD_KINDS, recordHash, resultFields, standingFields } from "./hashes.js";
import { Game } from "../../entities/Game.js";
import { Team } from "../../leagues/Team.js";

export const EXPORT_FORMAT = "sportsarc-record/1";
const OWNER_KIND = "record_owner";

/** Which value of each kind is the player's (or host's) salted commitment. */
export const COMMITMENT_INDEX: Record<string, number> = {
  "checkin": 2, "noshow": 2, "result": 2, "presence": 2, "game": 5, "member": 3,
};

/** EIP-712 data for "this wallet vouches for this player key". */
export function ownershipTypedData(input: { player: string; wallet: Address; issuedAt: number; chainId: number; contract: Address }): TypedData {
  return {
    domain: { name: "SportsArc Record", version: "1", chainId: input.chainId, verifyingContract: input.contract },
    types: { RecordOwner: [{ name: "player", type: "bytes32" }, { name: "wallet", type: "address" }, { name: "issuedAt", type: "uint64" }] },
    primaryType: "RecordOwner",
    message: { player: input.player, wallet: input.wallet, issuedAt: BigInt(input.issuedAt) },
  };
}

const bigints = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

/** The player's latest ownership signature, if they made one. */
export async function ownershipOf(em: EntityManager, user: User) {
  const row = await em.findOne(UserSignature, { user, kind: OWNER_KIND, status: "signed" }, { orderBy: { signedAt: "DESC" } });
  if (!row?.signature) return null;
  const typedData = parseTypedDataJson(row.typedData);
  if (typedData.message.player !== userKey(user.id)) return null;
  return { wallet: getAddress(row.signerAddress), typedData: JSON.parse(JSON.stringify(typedData, bigints)), signature: row.signature, signedAt: row.signedAt?.toISOString() ?? null };
}

/** The signed-in player's portable record. */
export async function exportRecord(em: EntityManager, user: User, origin: string) {
  const mine = await em.find(
    RecordEntry,
    { $or: [{ participant: { user } }, { user, kind: "member" }], status: "confirmed" },
    { populate: ["participant", "game", "game.venue", "season", "season.league", "season.league.org"], orderBy: { createdAt: "ASC" } },
  );
  const seasonContext = await seasonContextOf(em, mine.filter((r) => r.kind === "member"));
  const gameIds = [...new Set(mine.flatMap((r) => (r.game ? [r.game.id] : [])))];
  const games = gameIds.length
    ? await em.find(RecordEntry, { kind: "game", status: "confirmed", game: { $in: gameIds } }, { populate: ["game", "game.venue"] })
    : [];

  const entry = (r: RecordEntry) => {
    if (!isRecordKind(r.kind) || recordHash(r.kind, r.values) !== r.hash) return null;
    const ownsCommitment = r.kind === "game" ? r.game?.host.id === user.id : true;
    const g = r.game;
    return {
      kind: r.kind,
      hash: r.hash,
      encoding: RECORD_KINDS[r.kind].encoding,
      values: r.values,
      salt: ownsCommitment ? r.salt ?? null : null,
      opens: ownsCommitment && r.salt ? COMMITMENT_INDEX[r.kind] : null,
      gameId: g?.id ?? null,
      written: { chainId: r.chainId, contract: r.contract, txHash: r.txHash, blockNumber: r.blockNumber, writtenAt: r.writtenAt?.toISOString() ?? null },
      seasonId: r.season?.id ?? null,
      ...(seasonContext.lists.get(r.id) ?? {}),
      /** SportsArc's details for the game or season: the checker does not rely on them. */
      about: g ? { sport: g.sport, venue: g.venue.name, startsAt: g.startsAt.toISOString() } : seasonContext.about.get(r.id) ?? null,
    };
  };
  const records = [...mine, ...games, ...seasonContext.rows].map(entry).filter((e): e is NonNullable<ReturnType<typeof entry>> => e !== null);

  return {
    ok: true as const,
    file: {
      format: EXPORT_FORMAT,
      exportedAt: new Date().toISOString(),
      player: { name: user.name ?? null, key: userKey(user.id) },
      chain: { ...publicChainView(), contract: contractAddress("record") },
      ownership: await ownershipOf(em, user),
      counts: {
        attendance: records.filter((r) => (ATTENDANCE_KINDS as readonly string[]).includes(r.kind)).length,
        results: records.filter((r) => r.kind === "result").length,
        games: records.filter((r) => r.kind === "game").length,
        seasons: records.filter((r) => r.kind === "member").length,
      },
      records,
      check: `Download ${origin}/verify-record.mjs and run: node verify-record.mjs <this file>. It asks the chain's public RPC only.`,
    },
  };
}

/**
 * For a player's member records: their team's standing and the
 * season (context, no salt), what each cites, and SportsArc's words for
 * them (league, season, team, organizer, place).
 */
async function seasonContextOf(em: EntityManager, members: RecordEntry[]) {
  const rows: RecordEntry[] = [];
  const lists = new Map<string, { cites?: string[]; table?: string[] }>();
  const about = new Map<string, Record<string, unknown>>();
  for (const m of members) {
    const season = m.season;
    if (!season) continue;
    const teamId = m.slot.split(":")[2];
    const team = await em.findOne(Team, { id: teamId });
    const [standing, seasonRow] = await Promise.all([
      em.findOne(RecordEntry, { slot: `standing:${season.id}:${teamId}`, status: "confirmed" }),
      em.findOne(RecordEntry, { slot: `season:${season.id}`, status: "confirmed" }),
    ]);
    const words = {
      league: season.league.name, season: season.name, team: team?.name ?? null, organizer: season.league.org.name,
      place: standing ? standingFields(standing.values).place : null,
    };
    about.set(m.id, words);
    if (standing && !rows.some((r) => r.id === standing.id)) {
      rows.push(standing);
      about.set(standing.id, words);
      lists.set(standing.id, { cites: await citedResults(em, season.id, teamId) });
    }
    if (seasonRow && !rows.some((r) => r.id === seasonRow.id)) {
      rows.push(seasonRow);
      about.set(seasonRow.id, { league: words.league, season: words.season, organizer: words.organizer });
      const table = await em.find(RecordEntry, { kind: "standing", season: season.id });
      const order = new Map(table.map((t) => [t.hash, t]));
      // The season's table, in the order its record lists it.
      lists.set(seasonRow.id, {
        table: [...order.values()]
          .sort((a, b) => standingFields(a.values).place - standingFields(b.values).place || a.values[2].localeCompare(b.values[2]))
          .map((t) => t.hash),
      });
    }
  }
  return { rows, lists, about };
}

/** The result hashes a team's standing counted: its own seats in the season's games. */
async function citedResults(em: EntityManager, seasonId: string, teamId: string): Promise<string[]> {
  const games = await em.find(Game, { season: seasonId, kind: "league" });
  if (!games.length) return [];
  const results = await em.find(RecordEntry, { kind: "result", game: { $in: games } });
  return results
    .filter((r) => {
      const g = games.find((x) => x.id === r.game?.id);
      const side = resultFields(r.values).side;
      return g && ((side === 0 && g.homeTeam?.id === teamId) || (side === 1 && g.awayTeam?.id === teamId));
    })
    .map((r) => r.hash.toLowerCase())
    .sort();
}

/** Open the PIN challenge for the player's wallet to vouch for their player key. */
export async function startOwnership(em: EntityManager, user: User) {
  const contract = contractAddress("record");
  const raw = user.walletAddress?.trim() ?? "";
  if (!contract) return fail("NOT_CONFIGURED", "The record is not on chain on this server.");
  if (!isAddress(raw)) return fail("NO_WALLET", "Set up your wallet first.");
  const typedData = ownershipTypedData({
    player: userKey(user.id), wallet: getAddress(raw), issuedAt: Math.floor(Date.now() / 1000),
    chainId: publicChainView().id, contract,
  });
  return requestSignature(em, user, { kind: OWNER_KIND, typedData, memo: "Sign that this SportsArc record is yours. Nothing is sent." });
}

/** Keep the player's signature once it checks out against their wallet. */
export async function confirmOwnership(em: EntityManager, user: User, body: { signatureId?: unknown; signature?: unknown }) {
  const signed = await acceptSignature(em, user, { signatureId: body.signatureId, kind: OWNER_KIND, signature: body.signature });
  if (!signed.ok) return signed;
  return { ok: true as const, ownership: await ownershipOf(em, user) };
}
