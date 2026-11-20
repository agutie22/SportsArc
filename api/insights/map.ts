/**
 * Where people play: per-court totals for the public map (frontend/map.js),
 * GET /api/insights/map. Moved here from api/map/activity.ts (the map
 * session wrote it); the field names are unchanged, and it adds what the
 * Spurs case study needs: check-ins, the court's partner sponsor and its
 * league play.
 *
 * Counts public, uncancelled games whose check-in has closed, over the last
 * 4, 12 or 52 weeks, per venue: how many, which weeks, which hours of the
 * week, plus upcoming public games. Nothing here names a person.
 *
 * Privacy, enforced before anything leaves the server:
 *  - minors' seats are never counted (players, show-up);
 *  - a court's player count and show-up rate are withheld (null) unless at
 *    least MIN_PLAYERS distinct adults played there in the window;
 *  - invite-only games are left out entirely.
 * Game counts and times are not withheld: public games are listed openly
 * already (GET /api/games). Check-ins follow the player rule (null under
 * MIN_PLAYERS adults). Players whose record is private are counted: a
 * count names no one (decided 2026-11-20).
 *
 * Showing up follows social/reliability.ts showedUp(): the phone checked
 * in, or the host confirmed the player as here. The SQL below restates it
 * because it counts in the database; keep the two in step.
 */

import type { EntityManager } from "@mikro-orm/postgresql";
import { Venue } from "../entities/Venue.js";
import { isSport } from "../entities/Game.js";
import { CHECKIN_RULES } from "../games/checkin.js";
import { partnerCourts } from "../orgs/sponsors.js";

/** A court's players and show-up rate are shown only from this many adults. */
export const MIN_PLAYERS = 5;
export const RANGES = [4, 12, 52] as const;
export type RangeWeeks = (typeof RANGES)[number];
/** Hours of the week are counted in local time; every venue so far is in Texas. */
export const MAP_TIMEZONE = "America/Chicago";

const WEEK_MS = 7 * 86_400_000;
const CACHE_MS = 60_000;

export function parseRange(raw: unknown): RangeWeeks {
  const n = Number(raw);
  return (RANGES as readonly number[]).includes(n) ? (n as RangeWeeks) : 12;
}

export function parseSport(raw: unknown): string {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return s && isSport(s) ? s : "";
}

export interface MapVenue {
  id: string;
  name: string;
  address: string | null;
  kind: string;
  indoor: boolean;
  lat: number;
  lng: number;
  /** Games played here in the window. */
  games: number;
  /** Games per week over the window, oldest week first. */
  weekly: number[];
  /** [hourOfWeek, games] pairs; hour 0 is Monday 00:00 local time. */
  hours: [number, number][];
  /** Adult seats that showed up (phone check-in or the host's word), or null under MIN_PLAYERS. */
  checkIns: number | null;
  /** The court's active partner sponsor (orgs/sponsors.ts), if any. */
  partner: { orgSlug: string; orgName: string; since: string | null } | null;
  /** League games played here in the window, and their seasons; null when none. */
  league: { games: number; seasons: { id: string; name: string }[] } | null;
  /** Distinct adults who held a seat, or null under MIN_PLAYERS. */
  players: number | null;
  /** Share of counted adult seats that showed up, or null under MIN_PLAYERS. */
  showUp: number | null;
  /** Public games still to come here. */
  upcoming: number;
  nextAt: string | null;
}

export interface MapActivity {
  sport: string;
  weeks: RangeWeeks;
  since: string;
  timezone: string;
  minPlayers: number;
  venues: MapVenue[];
}

interface SeatRow { venue: string; players: number; seats: number; showed: number }

/**
 * The privacy rule in one place: below MIN_PLAYERS distinct adults, a
 * court shows no player count and no show-up rate. Pure, so it is tested.
 */
export function seatFigures(row: SeatRow | undefined): { players: number | null; showUp: number | null; checkIns: number | null } {
  if (!row || row.players < MIN_PLAYERS || row.seats === 0) return { players: null, showUp: null, checkIns: null };
  return { players: row.players, showUp: Math.round((row.showed / row.seats) * 1000) / 1000, checkIns: row.showed };
}

/** Week index of a game, 0 for the oldest week of the window. */
export function weekIndex(startsAt: Date, since: Date, weeks: number): number {
  return Math.min(weeks - 1, Math.max(0, Math.floor((startsAt.getTime() - since.getTime()) / WEEK_MS)));
}

const cache = new Map<string, { at: number; body: MapActivity }>();

export async function mapActivity(em: EntityManager, opts: { sport?: unknown; weeks?: unknown }, now = new Date()): Promise<MapActivity> {
  const sport = parseSport(opts.sport);
  const weeks = parseRange(opts.weeks);
  const key = `${sport}|${weeks}`;
  const hit = cache.get(key);
  if (hit && now.getTime() - hit.at < CACHE_MS) return hit.body;

  const since = new Date(now.getTime() - weeks * WEEK_MS);
  // Check-in has closed: who played is fixed (games/checkin.ts).
  const closed = new Date(now.getTime() - CHECKIN_RULES.graceMinAfter * 60_000);
  const played = `g.status <> 'cancelled' and g.visibility = 'public'
     and g.starts_at >= ? and g.starts_at < ? and (? = '' or g.sport = ?)`;
  const playedArgs = [since, closed, sport, sport];

  const [games, seats, upcoming] = await Promise.all([
    em.execute<{ venue: string; starts_at: Date; local: string; season: string | null; season_name: string | null }[]>(
      `select g.venue_id as venue, g.starts_at, g.season_id as season, s.name as season_name,
              to_char(g.starts_at at time zone ?, 'ID HH24') as local
         from games g
         left join seasons s on s.id = g.season_id and g.kind = 'league'
        where ${played}`,
      [MAP_TIMEZONE, ...playedArgs],
    ),
    em.execute<SeatRow[]>(
      `select g.venue_id as venue,
              count(distinct gp.user_id)::int as players,
              count(*)::int as seats,
              count(*) filter (where gp.checked_in_at is not null or gp.host_present is true)::int as showed
         from games g
         join game_participants gp on gp.game_id = g.id and gp.status = 'joined'
         join users u on u.id = gp.user_id
        where ${played} and coalesce(u.audience, '') <> 'minor'
        group by g.venue_id`,
      playedArgs,
    ),
    em.execute<{ venue: string; n: number; next: Date }[]>(
      `select g.venue_id as venue, count(*)::int as n, min(g.starts_at) as next
         from games g
        where g.status in ('open', 'full') and g.visibility = 'public'
          and g.starts_at >= ? and (? = '' or g.sport = ?)
        group by g.venue_id`,
      [now, sport, sport],
    ),
  ]);

  const acc = new Map<string, { games: number; weekly: number[]; hours: Map<number, number>; league: number; seasons: Map<string, string> }>();
  const slot = (id: string) => {
    let a = acc.get(id);
    if (!a) acc.set(id, (a = { games: 0, weekly: new Array(weeks).fill(0), hours: new Map(), league: 0, seasons: new Map() }));
    return a;
  };
  for (const g of games) {
    const a = slot(g.venue);
    a.games += 1;
    if (g.season) {
      a.league += 1;
      a.seasons.set(g.season, g.season_name ?? "");
    }
    a.weekly[weekIndex(new Date(g.starts_at), since, weeks)] += 1;
    const [isoDow, hour] = g.local.split(" ").map(Number);
    const h = (isoDow - 1) * 24 + hour;
    a.hours.set(h, (a.hours.get(h) ?? 0) + 1);
  }
  const seatBy = new Map(seats.map((s) => [s.venue, s]));
  const upBy = new Map(upcoming.map((u) => [u.venue, u]));
  for (const u of upcoming) slot(u.venue);

  // A partner court shows on the map even with no games yet.
  const partners = await partnerCourts(em);
  for (const id of partners.keys()) slot(id);
  const ids = [...acc.keys()];
  const venues = ids.length ? await em.find(Venue, { id: { $in: ids } }) : [];
  const out: MapVenue[] = venues.map((v) => {
    const a = acc.get(v.id)!;
    const up = upBy.get(v.id);
    return {
      id: v.id, name: v.name, address: v.address ?? null, kind: v.kind, indoor: v.indoor, lat: v.lat, lng: v.lng,
      games: a.games,
      weekly: a.weekly,
      hours: [...a.hours].sort((x, y) => x[0] - y[0]),
      ...seatFigures(seatBy.get(v.id)),
      partner: partners.has(v.id)
        ? { orgSlug: partners.get(v.id)!.sponsor.slug, orgName: partners.get(v.id)!.sponsor.name, since: partners.get(v.id)!.startsAt }
        : null,
      league: a.league ? { games: a.league, seasons: [...a.seasons].map(([id, name]) => ({ id, name })) } : null,
      upcoming: up?.n ?? 0,
      nextAt: up ? new Date(up.next).toISOString() : null,
    };
  });
  out.sort((x, y) => y.games - x.games || y.upcoming - x.upcoming);

  const body: MapActivity = { sport, weeks, since: since.toISOString(), timezone: MAP_TIMEZONE, minPlayers: MIN_PLAYERS, venues: out };
  cache.set(key, { at: now.getTime(), body });
  return body;
}
