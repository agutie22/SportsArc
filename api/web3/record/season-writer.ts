/**
 * Builds a league season's records once the organizer has finished it
 * (Season.finalAt) and every result it counts is on the record:
 *
 *   standing  one per team: wins, losses, ties and place, citing the
 *                result records of the team's own seats in the games
 *   member    one per rostered player, a fresh salted commitment
 *   season    one per season: the organizer and the whole table
 *
 * A season counts the results of its uncancelled league games settled
 * before it was finished. Wins, losses and ties are read back from those
 * games' result records (resultFields), never from GameResult, so the
 * standing matches the public record; GameResult's scores only break ties
 * on record (point difference), the same rule as the season page.
 *
 * Waits, building nothing, while any counted result is not yet written as
 * result (they are written once the correction hour is over). Runs in
 * the record tick (timer.ts) under the builders' advisory lock; each fact
 * is written once (unique slot). sender.ts sends the rows like any other.
 */

import type { EntityManager } from "@mikro-orm/postgresql";
import { Game } from "../../entities/Game.js";
import { GameResult } from "../../entities/GameResult.js";
import { ResultSeat } from "../../entities/ResultSeat.js";
import { fail, type Failure } from "../../failure.js";
import { Season } from "../../leagues/Season.js";
import { Team } from "../../leagues/Team.js";
import { TeamMember } from "../../leagues/TeamMember.js";
import { standings, type FixtureOutcome } from "../../leagues/rules.js";
import { RecordEntry } from "./RecordEntry.js";
import { newSalt } from "./keys.js";
import { idKey, memberValues, recordHash, resultFields, seasonValues, standingValues, type RecordKind } from "./hashes.js";
import { BUILD_LOCK_KEY } from "./writer.js";

function row(kind: RecordKind, slot: string, values: string[], season: Season, extra: Partial<RecordEntry> = {}) {
  const r = new RecordEntry();
  r.kind = kind;
  r.slot = slot;
  r.values = values;
  r.hash = recordHash(kind, values);
  r.salt = null;
  r.season = season;
  Object.assign(r, extra);
  return r;
}

export type SeasonBuild = { ok: true; seasons: number; records: number; waiting: number } | Failure;

/** Build the records of up to `seasons` finished seasons not yet written. */
export function buildSeasonRecords(em: EntityManager, opts: { seasons?: number; only?: string[] } = {}): Promise<SeasonBuild> {
  const max = Math.max(1, Math.trunc(opts.seasons ?? 5));
  return em.transactional(async (tx) => {
    await tx.execute("select pg_advisory_xact_lock(?)", [BUILD_LOCK_KEY]);
    const finished = await tx.find(
      Season,
      { status: "final", finalAt: { $ne: null }, ...(opts.only ? { id: { $in: opts.only } } : {}) },
      { populate: ["league", "league.org"], orderBy: { finalAt: "ASC" } },
    );
    let built = 0;
    let records = 0;
    let waiting = 0;
    for (const season of finished) {
      if (built >= max) break;
      if (await tx.count(RecordEntry, { slot: `season:${season.id}` })) continue;
      const out = await buildOne(tx, season);
      if (out === null) { waiting += 1; continue; }
      built += 1;
      records += out;
    }
    await tx.flush();
    return { ok: true as const, seasons: built, records, waiting };
  }).catch((err: unknown) => fail("BUILD_FAILED", err instanceof Error ? err.message : String(err)));
}

/** Persist one season's records; null when a counted result is not on the record yet. */
async function buildOne(tx: EntityManager, season: Season): Promise<number | null> {
  const finalAt = season.finalAt as Date;
  const teams = await tx.find(Team, { season }, { orderBy: { name: "ASC" } });
  const games = await tx.find(Game, { season, kind: "league", status: { $ne: "cancelled" } });
  const results = games.length
    ? await tx.find(GameResult, { game: { $in: games }, status: "settled", firstRecordedAt: { $lt: finalAt } }, { populate: ["game"] })
    : [];

  const cites = new Map<string, string[]>(teams.map((t) => [t.id, []]));
  const outcomes: FixtureOutcome[] = [];
  for (const result of results) {
    const game = games.find((g) => g.id === result.game.id)!;
    if (!game.homeTeam || !game.awayTeam) continue;
    const seats = await tx.find(ResultSeat, { result });
    const written = seats.length
      ? await tx.find(RecordEntry, { kind: "result", slot: { $in: seats.map((s) => `result:${s.participant.id}`) } })
      : [];
    if (written.length < seats.length) return null;
    const bySeat = new Map(written.map((w) => [w.slot.slice("result:".length), w]));
    for (const seat of seats) {
      const team = seat.side === 0 ? game.homeTeam.id : seat.side === 1 ? game.awayTeam.id : null;
      const rec = bySeat.get(seat.participant.id);
      if (team && rec) cites.get(team)?.push(rec.hash);
    }
    const fields = resultFields(written[0].values);
    outcomes.push({
      home: game.homeTeam.id, away: game.awayTeam.id,
      outcome: fields.outcome, winningSide: fields.winningSide,
      score0: result.score0 ?? null, score1: result.score1 ?? null,
    });
  }

  const table = standings(teams.map((t) => t.id), outcomes);
  // The season record lists standings by place, ties by team key.
  const ordered = [...table].sort((a, b) => a.place - b.place || idKey(a.team).localeCompare(idKey(b.team)));
  let records = 0;
  const standingHashes: string[] = [];
  for (const st of ordered) {
    const values = standingValues({
      seasonId: season.id, teamId: st.team, wins: st.wins, losses: st.losses, ties: st.ties, place: st.place,
      resultHashes: cites.get(st.team) ?? [], finalAt,
    });
    const r = row("standing", `standing:${season.id}:${st.team}`, values, season);
    standingHashes.push(r.hash);
    tx.persist(r);
    records += 1;
  }
  const members = teams.length ? await tx.find(TeamMember, { team: { $in: teams } }, { populate: ["user"] }) : [];
  for (const m of members) {
    const salt = newSalt();
    const values = memberValues({ seasonId: season.id, teamId: m.team.id, userId: m.user.id, finalAt, salt });
    tx.persist(row("member", `member:${season.id}:${m.team.id}:${m.user.id}`, values, season, { salt, user: m.user }));
    records += 1;
  }
  const values = seasonValues({ seasonId: season.id, orgId: season.league.org.id, standingHashes, finalAt });
  tx.persist(row("season", `season:${season.id}`, values, season));
  return records + 1;
}
