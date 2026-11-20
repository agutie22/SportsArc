/**
 * A sponsor org's insights (GET /api/orgs/:id/insights, and as CSV): what
 * its sponsorships show, in counts only. For the org's staff, once the org
 * is verified (orgs/roles.ts verifiedGate "insights").
 *
 *   courts    per partner court, per week: check-ins (a seat that showed up,
 *             by phone or by the host's word) and distinct players, and how
 *             much of it was league play; the same weeks for every other
 *             court as a baseline
 *   change    average weekly check-ins before and after the partnership
 *             started, at the partner courts and at the others
 *   seasons   each league season the org backs: teams, players, games
 *             played, check-ins
 *   funnel    per backed season: league players → invited to a tryout →
 *             registered → checked in at the tryout → invited to camp
 *
 * Privacy, enforced here and nowhere else: no names or ids of people, ever;
 * minors are never counted; any court or week figure under MIN_COUNT is
 * null (shown "<5"). Players whose record is private are counted: a count
 * names no one. Tryout stages are exact, as the camp invites are a club's
 * public result (decided 2026-11-20). Seeded demo data is labeled by the
 * page, not here.
 */

import type { EntityManager } from "@mikro-orm/postgresql";
import { fail } from "../failure.js";
import type { User } from "../entities/User.js";
import { GameParticipant } from "../entities/GameParticipant.js";
import { findOrg } from "../orgs/orgs.js";
import { requireOrg, verifiedGate } from "../orgs/roles.js";
import { Sponsorship } from "../orgs/Sponsorship.js";
import { Team } from "../leagues/Team.js";
import { TeamMember } from "../leagues/TeamMember.js";
import { Tryout } from "../tryouts/Tryout.js";
import { TryoutMark } from "../tryouts/TryoutMark.js";
import { eventRegistrants } from "../web3/events/events.js";

export const MIN_COUNT = 5;
export const INSIGHTS_TIMEZONE = "America/Chicago";
const RANGES = [8, 12, 26, 52];

/** The privacy rule for a count: under MIN_COUNT it is withheld. */
export const shown = (n: number): number | null => (n >= MIN_COUNT ? n : null);

/** The Monday (local) starting each of the last `weeks` weeks, oldest first, as YYYY-MM-DD. */
export function weekStarts(weeks: number, now = new Date(), tz = INSIGHTS_TIMEZONE): string[] {
  const local = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const d = new Date(`${local}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // back to Monday
  const out: string[] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const w = new Date(d);
    w.setUTCDate(d.getUTCDate() - i * 7);
    out.push(w.toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Average weekly count before and after `since` (a week start), over the
 * weeks given; null on a side with fewer than two weeks, or whose average
 * falls under MIN_COUNT.
 */
export function beforeAfter(weeks: string[], counts: Map<string, number>, since: string) {
  const before = weeks.filter((w) => w < since);
  const after = weeks.filter((w) => w >= since);
  const avg = (list: string[]) => {
    if (list.length < 2) return null;
    const a = list.reduce((sum, w) => sum + (counts.get(w) ?? 0), 0) / list.length;
    return a >= MIN_COUNT ? Math.round(a * 10) / 10 : null;
  };
  return { before: avg(before), after: avg(after), weeksBefore: before.length, weeksAfter: after.length };
}

interface WeekRow { venue: string; wk: string; checkins: number; players: number; league: number }

export async function orgInsights(em: EntityManager, user: User, orgRef: string, opts: { weeks?: unknown } = {}, now = new Date()) {
  const org = await findOrg(em, orgRef);
  if (!org) return fail("ORG_NOT_FOUND", "That organization does not exist.");
  const denied = await requireOrg(em, user.id, org.id, "run");
  if (denied) return denied;
  const unverified = verifiedGate(org, "insights");
  if (unverified) return unverified;

  const n = Number(opts.weeks);
  const weeksCount = RANGES.includes(n) ? n : 12;
  const weeks = weekStarts(weeksCount, now);
  const from = new Date(`${weeks[0]}T00:00:00Z`);
  from.setUTCDate(from.getUTCDate() - 1); // a day of slack for the time zone; weeks outside are dropped below

  const sponsorships = await em.find(Sponsorship, { sponsor: org, status: { $in: ["active", "ended"] } }, {
    populate: ["venue", "season", "season.league", "season.league.org"], orderBy: { createdAt: "ASC" },
  });
  const courts = sponsorships.filter((s) => s.venue);
  const partnerIds = new Set(courts.map((s) => s.venue!.id));

  const rows = await em.execute<WeekRow[]>(
    `select g.venue_id as venue,
            to_char(date_trunc('week', g.starts_at at time zone ?), 'YYYY-MM-DD') as wk,
            count(*) filter (where gp.checked_in_at is not null or gp.host_present is true)::int as checkins,
            count(distinct gp.user_id) filter (where gp.checked_in_at is not null or gp.host_present is true)::int as players,
            count(*) filter (where (gp.checked_in_at is not null or gp.host_present is true) and g.kind = 'league')::int as league
       from games g
       join game_participants gp on gp.game_id = g.id and gp.status = 'joined'
       join users u on u.id = gp.user_id
      where g.status <> 'cancelled' and g.starts_at >= ? and g.starts_at < ?
        and coalesce(u.audience, '') <> 'minor'
      group by 1, 2`,
    [INSIGHTS_TIMEZONE, from, now],
  );
  const inWindow = rows.filter((r) => weeks.includes(r.wk));
  const weekOf = (since: Date | null | undefined) => {
    if (!since) return weeks[0];
    const local = new Intl.DateTimeFormat("en-CA", { timeZone: INSIGHTS_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(since);
    return weeks.filter((w) => w <= local).pop() ?? weeks[0];
  };

  // Every other court together, as the baseline.
  const others = new Map<string, number>();
  for (const r of inWindow) if (!partnerIds.has(r.venue)) others.set(r.wk, (others.get(r.wk) ?? 0) + r.checkins);

  const courtViews = courts.map((s) => {
    const mine = inWindow.filter((r) => r.venue === s.venue!.id);
    const byWeek = new Map(mine.map((r) => [r.wk, r]));
    const checkins = new Map(mine.map((r) => [r.wk, r.checkins]));
    const since = weekOf(s.startsAt);
    const total = mine.reduce((a, r) => a + r.checkins, 0);
    const league = mine.reduce((a, r) => a + r.league, 0);
    return {
      venue: { id: s.venue!.id, name: s.venue!.name, lat: s.venue!.lat, lng: s.venue!.lng },
      status: s.status,
      since: s.startsAt?.toISOString() ?? null,
      sinceWeek: since,
      weekly: weeks.map((w) => ({
        week: w,
        checkIns: shown(byWeek.get(w)?.checkins ?? 0),
        players: shown(byWeek.get(w)?.players ?? 0),
      })),
      total: shown(total),
      leagueShare: total >= MIN_COUNT ? Math.round((league / total) * 100) / 100 : null,
      change: beforeAfter(weeks, checkins, since),
      baseline: beforeAfter(weeks, others, since),
    };
  });

  const seasonViews = [];
  for (const s of sponsorships.filter((x) => x.season)) {
    const season = s.season!;
    const teams = await em.find(Team, { season });
    const members = teams.length ? await em.find(TeamMember, { team: { $in: teams } }, { populate: ["user"] }) : [];
    const adults = members.filter((m) => m.user.audience !== "minor");
    const playerIds = new Set(adults.map((m) => m.user.id));
    const played = await em.execute<{ games: number; checkins: number }[]>(
      `select count(distinct g.id)::int as games,
              count(gp.id) filter (where gp.checked_in_at is not null or gp.host_present is true)::int as checkins
         from games g
         left join game_participants gp on gp.game_id = g.id and gp.status = 'joined'
        where g.season_id = ? and g.kind = 'league' and g.status <> 'cancelled' and g.starts_at < ?`,
      [season.id, now],
    );
    seasonViews.push({
      season: { id: season.id, name: season.name, status: season.status, league: season.league.name, org: { slug: season.league.org.slug, name: season.league.org.name } },
      status: s.status,
      offer: s.offer ?? null,
      teams: teams.length,
      players: shown(playerIds.size),
      games: played[0]?.games ?? 0,
      checkIns: shown(played[0]?.checkins ?? 0),
      funnel: await funnelFor(em, playerIds),
    });
  }

  return {
    ok: true as const,
    insights: {
      org: { id: org.id, slug: org.slug, name: org.name },
      weeks,
      timezone: INSIGHTS_TIMEZONE,
      minCount: MIN_COUNT,
      courts: courtViews,
      others: weeks.map((w) => ({ week: w, checkIns: shown(others.get(w) ?? 0) })),
      seasons: seasonViews,
    },
  };
}

/**
 * League players → invited to any tryout → registered → checked in at the
 * tryout → invited to camp, counting only these players. Exact counts.
 */
async function funnelFor(em: EntityManager, playerIds: Set<string>) {
  const ids = [...playerIds];
  if (!ids.length) return { leaguePlayers: 0, invited: 0, registered: 0, checkedIn: 0, camp: 0 };
  const marks = await em.find(TryoutMark, { user: { $in: ids }, kind: { $in: ["invited", "camp"] } }, { populate: ["tryout", "tryout.game"] });
  const invited = new Set(marks.filter((m) => m.kind === "invited").map((m) => m.user.id));
  const camp = new Set(marks.filter((m) => m.kind === "camp").map((m) => m.user.id));
  const tryouts = new Map<string, Tryout>();
  for (const m of marks) tryouts.set(m.tryout.id, m.tryout);
  const registered = new Set<string>();
  const checkedIn = new Set<string>();
  for (const t of tryouts.values()) {
    for (const u of await eventRegistrants(em, t.game)) if (playerIds.has(u.id)) registered.add(u.id);
    const seats = await em.find(GameParticipant, { game: t.game, user: { $in: ids }, checkedInAt: { $ne: null } });
    for (const s of seats) checkedIn.add(s.user.id);
  }
  return { leaguePlayers: ids.length, invited: invited.size, registered: registered.size, checkedIn: checkedIn.size, camp: camp.size };
}

/** The insights as CSV: `courts` (one row per court per week) or `funnel` (one row per season). */
export function insightsCsv(insights: Extract<Awaited<ReturnType<typeof orgInsights>>, { ok: true }>["insights"], table: string): string {
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const line = (cells: unknown[]) => cells.map(cell).join(",");
  if (table === "funnel") {
    return [
      line(["season", "league", "run_by", "teams", "players", "games", "check_ins", "league_players", "invited", "registered", "checked_in_at_tryout", "camp"]),
      ...insights.seasons.map((s) => line([
        s.season.name, s.season.league, s.season.org.name, s.teams, s.players ?? "<5", s.games, s.checkIns ?? "<5",
        s.funnel.leaguePlayers, s.funnel.invited, s.funnel.registered, s.funnel.checkedIn, s.funnel.camp,
      ])),
    ].join("\n") + "\n";
  }
  const out = [line(["week_starting", "court", "partner_since", "check_ins", "players"])];
  for (const c of insights.courts) {
    for (const w of c.weekly) out.push(line([w.week, c.venue.name, c.since?.slice(0, 10) ?? "", w.checkIns ?? "<5", w.players ?? "<5"]));
  }
  for (const w of insights.others) out.push(line([w.week, "All other courts", "", w.checkIns ?? "<5", ""]));
  return out.join("\n") + "\n";
}

