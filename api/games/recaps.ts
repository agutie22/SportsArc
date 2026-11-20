/**
 * Game recaps. When a game ends, a "recap" post goes into the feed as a
 * result card: who actually showed up (verified check-ins), when it ran,
 * and — for someone who played — what it did for their record.
 *
 * Once the game's result has been recorded (see results.ts), it rides along as `result` and becomes the card's headline;
 * until then the card leads with the turnout. `resultStatus` is what the
 * card's button needs: "locked" (waiting on the host), "recorded" (the host
 * can still fix it) or "final"; null when the game has no result at all.
 * `viewer.canRecord` is the host or a co-host, the only people who record.
 *
 * Generation runs on a timer in the API process, as a job (jobs.ts): with
 * several instances, only the one holding the "recaps" lock runs a tick.
 */

import type { EntityManager } from "@mikro-orm/postgresql";
import { Game } from "../entities/Game.js";
import { GameParticipant } from "../entities/GameParticipant.js";
import { GameResult } from "../entities/GameResult.js";
import { ResultSeat } from "../entities/ResultSeat.js";
import { Post } from "../entities/Post.js";
import { venueRankFor } from "../social/discovery.js";
import { RecordEntry } from "../web3/record/RecordEntry.js";
import { recordConfigured } from "../web3/record/sender.js";
import { recordIntervalMs } from "../web3/record/timer.js";
import { correctUntil, canRecord } from "./results.js";
import { mayUse, roleOf } from "./roles.js";
import { notify } from "../social/notifications.js";
import { startJob } from "../ops/jobs.js";

/** A pickup run with one verified player is not much of a recap. */
const MIN_CHECKED_IN = 2;
/** Games that ended longer ago than this are never backfilled. */
const LOOKBACK_MS = 3 * 86_400_000;

export async function generateRecaps(em: EntityManager): Promise<number> {
  const now = Date.now();
  const candidates = await em.find(
    Game,
    {
      status: { $ne: "cancelled" },
      startsAt: { $gte: new Date(now - LOOKBACK_MS - 12 * 3600_000), $lte: new Date(now) },
    },
    { populate: ["venue", "host"] },
  );

  let made = 0;
  for (const game of candidates) {
    const endsAt = game.startsAt.getTime() + game.durationMinutes * 60_000;
    if (endsAt > now || endsAt < now - LOOKBACK_MS) continue;
    if (await em.count(Post, { kind: "recap", game })) continue;

    const roster = await em.find(GameParticipant, { game, status: "joined", checkedInAt: { $ne: null } });
    if (roster.length < MIN_CHECKED_IN) continue;

    const post = new Post();
    post.author = game.host;
    post.kind = "recap";
    post.game = game;
    post.body = `${roster.length} checked in at ${game.venue.name}.`;
    await em.persistAndFlush(post);
    made += 1;

    for (const seat of roster) {
      await notify(em, { recipient: seat.user.id, kind: "recap", post, game });
    }
  }
  return made;
}

export function startRecapTimer(fork: () => EntityManager, everyMs = 60_000): void {
  startJob({ name: "recaps", fork, everyMs }, async () => {
    try {
      const n = await generateRecaps(fork());
      if (n) console.log(`[recaps] wrote ${n} recap${n === 1 ? "" : "s"}`);
    } catch (err) {
      console.warn("[recaps] tick failed:", err instanceof Error ? err.message : err);
    }
  });
}

export type RecapResultStatus = "locked" | "recorded" | "final" | null;

/** The card's view of a result row: no row, waiting on the host, fixable, or final. */
export function recapResultStatus(
  row: { status: "locked" | "settled"; outcome?: string | null; firstRecordedAt?: Date | null } | null,
  now = Date.now(),
): RecapResultStatus {
  if (!row) return null;
  if (row.status !== "settled" || !row.outcome) return "locked";
  return canRecord(row.status, row.firstRecordedAt, now) ? "recorded" : "final";
}

/** What the result card needs. Viewer-specific fields only when they played. */
export async function recapPayload(em: EntityManager, game: Game, viewerId?: string) {
  const seats = await em.find(
    GameParticipant,
    { game, status: "joined" },
    { populate: ["user"], orderBy: { checkedInAt: "ASC" } },
  );
  const verified = seats.filter((s) => s.checkedInAt);
  const startsAt = game.startsAt;
  const endsAt = new Date(startsAt.getTime() + game.durationMinutes * 60_000);

  let you = null;
  const mine = viewerId ? verified.find((s) => s.user.id === viewerId) : undefined;
  if (mine && viewerId) {
    // Nth verified game on this person's record: every earlier one, plus
    // this. Not "$lte startsAt" — Postgres keeps microseconds and a JS Date
    // does not, so the bound can land just before this game's own start.
    const gameNumber = 1 + await em.count(GameParticipant, {
      user: viewerId,
      status: "joined",
      checkedInAt: { $ne: null },
      game: { id: { $ne: game.id }, startsAt: { $lt: startsAt } },
    });
    you = {
      gameNumber,
      venueRank: await venueRankFor(em, game.venue.id, viewerId),
    };
  }

  // The recorded outcome, including the hour it can still be corrected.
  // `yourSide` is the viewer's own locked seat, so the card can say whether they won.
  const row = await em.findOne(GameResult, { game }, { populate: ["recordedBy"] });
  const resultStatus = recapResultStatus(row);
  let result = null;
  if (row && (resultStatus === "recorded" || resultStatus === "final")) {
    const seat = mine ? await em.findOne(ResultSeat, { result: row, participant: mine }) : null;
    const fixUntil = resultStatus === "recorded" ? correctUntil(row.status, row.firstRecordedAt) : null;
    result = {
      outcome: row.outcome,
      winningSide: row.winningSide ?? null,
      score: row.score0 !== null && row.score0 !== undefined ? [row.score0, row.score1 ?? 0] : null,
      settledAt: row.firstRecordedAt?.toISOString() ?? null,
      correctUntil: fixUntil?.toISOString() ?? null,
      recordedBy: row.recordedBy ? { id: row.recordedBy.id, name: row.recordedBy.name ?? null } : null,
      yourSide: seat ? seat.side ?? null : null,
      seated: Boolean(seat),
    };
  }

  // Only the host or a co-host records; everyone else waits on them.
  const runs = viewerId ? mayUse(await roleOf(em, game, viewerId), "result") : false;

  // How many of these check-ins are on the public record, and whether this
  // server writes them at all. The sheet says "verified" only from this.
  const onRecord = verified.length
    ? await em.count(RecordEntry, { participant: { $in: verified.map((s) => s.id) }, status: "confirmed", kind: "checkin" })
    : 0;

  return {
    sport: game.sport,
    venueName: game.venue.name,
    venueId: game.venue.id,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    durationMinutes: game.durationMinutes,
    host: { id: game.host.id, name: game.host.name ?? null },
    verifiedCount: verified.length,
    rosterCount: seats.length,
    roster: verified.slice(0, 12).map((s) => ({
      id: s.user.id,
      name: s.user.name ?? null,
      role: s.user.role ?? null,
      avatarUrl: s.user.avatarUrl ?? null,
    })),
    you,
    viewer: { canRecord: runs && resultStatus !== null && resultStatus !== "final" },
    resultStatus,
    result,
    record: {
      verified: onRecord,
      writing: recordConfigured(),
      everyMin: Math.max(1, Math.round(recordIntervalMs() / 60_000)),
    },
  };
}
