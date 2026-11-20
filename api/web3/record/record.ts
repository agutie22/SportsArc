/**
 * A player's verified record: every game of theirs with a confirmed
 * check-in or missed seat on chain, in a shape a person can read, and the
 * link that shares it.
 *
 * Who may read it:
 *
 *  - Anyone, by the player's id (publicRecord). The games are public from
 *    the profile. A player who sets recordPrivate hides that list; the
 *    response then names them and says the record is private, with no
 *    venues or times.
 *
 *  - The player, signed in, reads their own (myRecord) either way, with how
 *    many recent games are still waiting to be verified and their share link.
 *
 *  - Anyone holding the player's share link (sharedRecord), including when
 *    the record is private. The token is 32 random bytes and exists only
 *    once the player asks for a link, so holding one means the player
 *    handed it over. Unlike the leaf-hash door in proofs.ts this one names
 *    the player, the venue and the time. Turning the link off deletes the
 *    token.
 *
 *  - The player, signed in, asks where one game of theirs stands
 *    (myGameRecord): verified, missed, still being verified, or nothing to
 *    write. The game sheet and the profile's Games tab read this.
 *
 * Each game carries its record hash, so the page can ask SportsArcRecord
 * itself (frontend/chain-check.js, writtenAt) instead of taking this
 * server's word. A row whose stored values no longer hash to it is left out.
 */

import { randomBytes } from "node:crypto";
import type { EntityManager } from "@mikro-orm/postgresql";
import type { Hex } from "viem";
import { GameParticipant } from "../../entities/GameParticipant.js";
import { User } from "../../entities/User.js";
import { fail } from "../../failure.js";
import { checkInClosesAt, checkInWindow } from "../../games/checkin.js";
import { publicChainView, relayer } from "../chains.js";
import { contractAddress } from "../contracts.js";
import { isUuid } from "../../validate.js";
import { RecordEntry } from "./RecordEntry.js";
import { GameResult } from "../../entities/GameResult.js";
import { ATTENDANCE_KINDS, isRecordKind, presenceFields, recordHash, resultFields, seatFields, standingFields } from "./hashes.js";
import { Team } from "../../leagues/Team.js";
import { recordConfigured } from "./sender.js";
import { ownershipOf } from "./portable.js";
import { RecordShare } from "./RecordShare.js";
import { recordIntervalMs } from "./timer.js";

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/**
 * The network, the record contract and the server wallet that writes to it
 * (its only writer), for the browser's own check and the explorer links.
 */
export function recordChain() {
  return { ...publicChainView(), contract: contractAddress("record"), writer: relayer()?.account.address ?? null };
}

/** Where a record was written, for the receipt and the explorer links. */
export function whereWritten(row: RecordEntry) {
  return {
    status: row.status,
    chainId: row.chainId ?? null,
    contract: row.contract ?? null,
    txHash: row.txHash ?? null,
    blockNumber: row.blockNumber ?? null,
    writtenAt: row.writtenAt?.toISOString() ?? null,
  };
}

const intact = (row: RecordEntry) => isRecordKind(row.kind) && recordHash(row.kind, row.values) === row.hash;

/** Where a confirmed companion record (the result, the game) was written. */
function written(row: RecordEntry) {
  return {
    hash: row.hash,
    recordedAt: row.writtenAt?.toISOString() ?? null,
    txHash: row.txHash ?? null,
    blockNumber: row.blockNumber ?? null,
  };
}

/** How the game went for this seat, in words the receipt uses. */
function forThem(f: ReturnType<typeof resultFields>): "won" | "lost" | "draw" | "sat_out" | "not_played" {
  if (f.outcome === "not_played") return "not_played";
  if (f.side === null) return "sat_out";
  if (f.outcome === "draw") return "draw";
  return f.winningSide === f.side ? "won" : "lost";
}

interface Extras {
  /** result and presence rows by seat id, game rows by game id: confirmed only. */
  results: Map<string, RecordEntry>;
  presence: Map<string, RecordEntry>;
  games: Map<string, RecordEntry>;
  /** Who recorded each game's result (SportsArc's account names), by game id. */
  recorders: Map<string, { id: string; name: string | null } | null>;
}

/** The confirmed result and game records, and who recorded each result, for these seats. */
async function extrasFor(em: EntityManager, seats: GameParticipant[]): Promise<Extras> {
  const seatSlots = seats.flatMap((s) => [`result:${s.id}`, `presence:${s.id}`]);
  const gameIds = [...new Set(seats.map((s) => s.game.id))];
  const out: Extras = { results: new Map(), presence: new Map(), games: new Map(), recorders: new Map() };
  if (seats.length === 0) return out;
  const rows = await em.find(RecordEntry, {
    status: "confirmed",
    slot: { $in: [...seatSlots, ...gameIds.map((id) => `game:${id}`)] },
  });
  for (const r of rows) {
    if (!intact(r)) continue;
    if (r.kind === "result" && r.participant) out.results.set(r.participant.id, r);
    if (r.kind === "presence" && r.participant) out.presence.set(r.participant.id, r);
    if (r.kind === "game" && r.game) out.games.set(r.game.id, r);
  }
  const results = await em.find(GameResult, { game: { $in: gameIds } }, { populate: ["recordedBy"] });
  for (const g of results) {
    out.recorders.set(g.game.id, g.recordedBy ? { id: g.recordedBy.id, name: g.recordedBy.name ?? null } : null);
  }
  return out;
}

/** One confirmed attendance row as a game a person can read, or null when its values no longer hash to it. */
function entryOf(row: RecordEntry, seat: GameParticipant, extras: Extras) {
  if (!intact(row)) return null;
  const showed = row.kind === "checkin";
  const result = extras.results.get(seat.id);
  const gameRecord = extras.games.get(seat.game.id);
  const presence = extras.presence.get(seat.id);
  const rf = result ? resultFields(result.values) : null;
  const host = seat.game.host;
  return {
    gameId: seat.game.id,
    hash: row.hash,
    kind: showed ? "checkin" as const : "missed" as const,
    sport: seat.game.sport,
    venueName: seat.game.venue.name,
    startsAt: seat.game.startsAt.toISOString(),
    /** When they checked in, or when check-in closed on a missed game. */
    at: (showed && seat.checkedInAt ? seat.checkedInAt : checkInClosesAt(seat.game)).toISOString(),
    /** When check-in closed and the roster was locked. */
    closedAt: checkInClosesAt(seat.game).toISOString(),
    /** When the record was written, from the contract. */
    recordedAt: row.writtenAt?.toISOString() ?? null,
    /** What the record commits to, for "check it yourself": hashes and seconds only. */
    fields: seatFields(row.values),
    chainId: row.chainId ?? null,
    contract: row.contract ?? null,
    txHash: row.txHash ?? null,
    blockNumber: row.blockNumber ?? null,
    /** The host who runs the game (SportsArc's account name). */
    host: { id: host.id, name: host.name ?? null },
    /** The final result for this seat, once written; null before (or for a seat not in the result). */
    result: result && rf ? {
      ...written(result),
      forThem: forThem(rf),
      side: rf.side,
      winningSide: rf.winningSide,
      finalAt: new Date(rf.finalAt * 1000).toISOString(),
      /** True when the host (not a co-host) recorded it. */
      recordedByHost: (extras.recorders.get(seat.game.id)?.id ?? host.id) === host.id,
      recordedBy: extras.recorders.get(seat.game.id) ?? null,
    } : null,
    /** The host's word on whether they were there, once final and written; null before or if the host never confirmed. */
    presence: presence ? { ...written(presence), ...presenceFields(presence.values), finalAt: new Date(presenceFields(presence.values).finalAt * 1000).toISOString() } : null,
    /** What the game was (sport, venue, start, host), as written; null before. */
    gameRecord: gameRecord ? written(gameRecord) : null,
  };
}

/** About how long after check-in closes a record is confirmed: one tick, and the send. */
function writtenWithinMin(): number {
  return Math.max(2, Math.ceil(recordIntervalMs() / 60_000) + 1);
}

async function recordOf(em: EntityManager, user: User) {
  const rows = await em.find(
    RecordEntry,
    { participant: { user }, status: "confirmed", kind: { $in: [...ATTENDANCE_KINDS] } },
    { populate: ["participant", "participant.game", "participant.game.venue", "participant.game.host"] },
  );
  const extras = await extrasFor(em, rows.flatMap((r) => (r.participant ? [r.participant] : [])));
  const games = rows.flatMap((row) => {
    const entry = row.participant ? entryOf(row, row.participant, extras) : null;
    return entry ? [entry] : [];
  });
  games.sort((a, b) => b.startsAt.localeCompare(a.startsAt));

  return {
    player: recordOfPlayer(user),
    games,
    seasons: await seasonsOf(em, user),
    chain: recordChain(),
    seatIds: new Set(rows.map((r) => r.participant?.id)),
  };
}

/**
 * League seasons on the record: one per confirmed member, with the
 * team's confirmed standing and who vouched (the organization that ran
 * the season, named in season by its key). League play is adults only,
 * so team and league are shown wherever the record is.
 */
export async function seasonsOf(em: EntityManager, user: User) {
  const members = await em.find(
    RecordEntry,
    { user, kind: "member", status: "confirmed" },
    { populate: ["season", "season.league", "season.league.org"], orderBy: { createdAt: "DESC" } },
  );
  const out = [];
  for (const m of members) {
    const season = m.season;
    if (!season || !intact(m)) continue;
    const teamId = m.slot.split(":")[2];
    const [team, standing, seasonRow, teams] = await Promise.all([
      em.findOne(Team, { id: teamId }),
      em.findOne(RecordEntry, { slot: `standing:${season.id}:${teamId}`, status: "confirmed" }),
      em.findOne(RecordEntry, { slot: `season:${season.id}`, status: "confirmed" }),
      em.count(Team, { season }),
    ]);
    const st = standing && intact(standing) ? standingFields(standing.values) : null;
    const org = season.league.org;
    out.push({
      seasonId: season.id,
      league: season.league.name,
      season: season.name,
      team: team ? { id: team.id, name: team.name } : null,
      teams,
      standing: st ? { place: st.place, wins: st.wins, losses: st.losses, ties: st.ties } : null,
      /** Who vouched: the organizer; season commits to its key. */
      organizer: { name: org.name, slug: org.slug, verified: Boolean(org.verifiedAt) },
      finalAt: season.finalAt?.toISOString() ?? null,
      member: written(m),
      standingRecord: standing ? written(standing) : null,
      seasonRecord: seasonRow ? written(seasonRow) : null,
    });
  }
  return out;
}

/** Finished games of theirs with no confirmed record yet. Zero when nothing is writing them. */
export async function verifyingCount(em: EntityManager, user: User | string, verified: Set<string | undefined>): Promise<number> {
  if (!recordConfigured()) return 0;
  const seats = await em.find(
    GameParticipant,
    { user, status: "joined", game: { status: { $ne: "cancelled" } } },
    { populate: ["game"] },
  );
  return seats.filter((s) => checkInWindow(s.game) === "closed" && !verified.has(s.id)).length;
}

type Entry = NonNullable<ReturnType<typeof entryOf>>;

/**
 * A game as anyone may see it: no game id (it opens the game and its
 * roster), and no other person's name or id. Hosts can be minors, so
 * outside the player's own record a result says "the host" or "a co-host".
 */
function publicEntry({ gameId: _gameId, host: _host, result, ...g }: Entry) {
  return { ...g, host: null, result: result ? { ...result, recordedBy: null } : null };
}

/** The signed-in player's own record, their share link and what is still on its way. */
export async function myRecord(em: EntityManager, user: User) {
  const { seatIds, ...record } = await recordOf(em, user);
  const share = await em.findOne(RecordShare, { user });
  return {
    ok: true as const,
    private: user.recordPrivate,
    ...record,
    share: share ? { token: share.token } : null,
    /** The wallet that signed this record is yours, if you signed (the portable file carries it). */
    ownership: await ownershipOf(em, user).then((o) => (o ? { wallet: o.wallet, signedAt: o.signedAt } : null)),
    verifying: {
      count: await verifyingCount(em, user, seatIds),
      withinMin: writtenWithinMin(),
    },
  };
}

/**
 * The record on a profile. Public by default. A private record names the
 * player and carries no games; a share link is the way through that.
 */
export async function publicRecord(em: EntityManager, userId: string) {
  if (!isUuid(userId)) return fail("NOT_FOUND", "No such person.");
  const user = await em.findOne(User, { id: userId.toLowerCase() });
  if (!user) return fail("NOT_FOUND", "No such person.");
  if (user.recordPrivate) {
    return { ok: true as const, private: true as const, player: recordOfPlayer(user), games: [], seasons: [] };
  }
  const { seatIds: _seatIds, games, ...record } = await recordOf(em, user);
  return {
    ok: true as const,
    private: false as const,
    ...record,
    games: games.map(publicEntry),
  };
}

function recordOfPlayer(user: User) {
  return {
    id: user.id,
    name: user.name ?? null,
    role: user.role ?? null,
    headline: user.headline ?? null,
    avatarUrl: user.avatarUrl ?? null,
  };
}

/** Hide or show the game list. The show-up count is unchanged either way. */
export async function setRecordPrivacy(em: EntityManager, user: User, raw: unknown) {
  const flag = raw && typeof raw === "object" ? (raw as { private?: unknown }).private : undefined;
  if (typeof flag !== "boolean") return fail("VALIDATION_ERROR", "private is true or false.");
  user.recordPrivate = flag;
  await em.flush();
  return { ok: true as const, private: flag };
}

/** What a share link shows. */
export async function sharedRecord(em: EntityManager, token: string) {
  const notFound = fail("NOT_FOUND", "This link is no longer shared.");
  if (!TOKEN_RE.test(token)) return notFound;
  const share = await em.findOne(RecordShare, { token }, { populate: ["user"] });
  if (!share) return notFound;
  const { seatIds: _seatIds, games, ...record } = await recordOf(em, share.user);
  // Game ids open the game and its roster; a share link shows the record only.
  return { ok: true as const, ...record, games: games.map(publicEntry) };
}

/** The player's share link, made on first ask and the same one after that. */
export async function shareRecord(em: EntityManager, user: User) {
  let share = await em.findOne(RecordShare, { user });
  if (!share) {
    share = new RecordShare();
    share.user = user;
    share.token = randomBytes(32).toString("base64url");
    await em.persistAndFlush(share);
  }
  return { ok: true as const, token: share.token };
}

/** Turn the link off. Sharing again later gives a new one. */
export async function unshareRecord(em: EntityManager, user: User) {
  await em.nativeDelete(RecordShare, { user });
  return { ok: true as const };
}

/**
 * Where one game of the signed-in player's stands on the record:
 *   verified    showed up (checked in, or the host confirmed them as here), on chain
 *   missed      held a seat at close without checking in, on chain
 *   verifying   check-in has closed; its record is being written
 *   waiting     checked in; the record is written when check-in closes (closesAt)
 *   none        nothing to write yet (check-in still open, cancelled,
 *               left early, or nothing is writing records on this server)
 * `game` is the same shape as a record page's game, so the receipt opens.
 */
export async function myGameRecord(em: EntityManager, user: User, gameId: string) {
  const notFound = fail("NOT_FOUND", "You have no seat in that game.");
  if (!isUuid(gameId)) return notFound;
  const seat = await em.findOne(
    GameParticipant,
    { game: gameId.toLowerCase(), user },
    { populate: ["game", "game.venue", "game.host"] },
  );
  if (!seat) return notFound;
  const chain = recordChain();
  const withinMin = writtenWithinMin();
  const closesAt = checkInClosesAt(seat.game).toISOString();
  const checkedIn = Boolean(seat.checkedInAt);

  const row = await em.findOne(RecordEntry, { slot: `attendance:${seat.id}`, status: "confirmed" });
  const entry = row ? entryOf(row, seat, await extrasFor(em, [seat])) : null;
  if (entry) {
    // Showed up: checked in, or the host confirmed them as here (social/reliability.ts).
    const showed = entry.kind === "checkin" || entry.presence?.present === true;
    return { ok: true as const, state: showed ? "verified" as const : "missed" as const, checkedIn, game: entry, chain, withinMin, closesAt };
  }
  const live = seat.status === "joined" && seat.game.status !== "cancelled" && recordConfigured();
  const closed = checkInWindow(seat.game) === "closed";
  const state = !live ? "none" as const
    : closed ? "verifying" as const
      : checkedIn ? "waiting" as const : "none" as const;
  return { ok: true as const, state, checkedIn, game: null, chain, withinMin, closesAt };
}
