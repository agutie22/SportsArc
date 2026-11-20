/**
 * Demo data for the private beta: Austin and San Antonio pickup sports, with a game in
 * every state the product has, so the owner and UX work can exercise every
 * flow without staging each one by hand.
 *
 *   node --env-file=.env --import=tsx scripts/seed.ts [--reset] [--me you@example.com]
 *
 *   (no flags)   remove any earlier demo data, then seed afresh. Re-running is
 *                safe and is how you refresh the time-bound states ("check-in
 *                open now", "sides being picked"), which only
 *                hold for an hour or so after a run.
 *   --reset      remove the demo data and stop.
 *   --me <email> also create or reuse that account (SEED_ME works too) and
 *                place it in games across the states, in every role.
 *
 * Safety:
 *  - Refuses to run when NODE_ENV=production unless SEED_ALLOW_PRODUCTION=1.
 *  - Every demo account's email ends in @demo.sportsarc.test. Reset removes
 *    exactly: games hosted by a demo account, games (the ones the --me
 *    account hosts) whose every player but the host is a demo account,
 *    games whose notes start with "[DEMO:" (how earlier seeds tagged them)
 *    that have a demo player, their system and recap posts, venues a demo account
 *    created that no other game uses, and the demo accounts (which cascades
 *    to their posts, likes, follows, notifications and seats). Real accounts,
 *    the --me account included, are never deleted; only their links to demo
 *    data go with it.
 *
 * Data goes in through the real domain functions (createGame, joinGame,
 * checkInToGame, setSide, startGame, recordResult, setCohost, cancelGame, createPost, followUser, toggleLike,
 * recordProfileView). Direct SQL is used only to move a game's clock: open
 * check-in now, or push a game that was played "now" back into the past.
 * Games sit at hours people play in Austin (evenings, weekend mornings),
 * and their notes read like a host wrote them; the state each one shows
 * is printed in the summary, never written into the app.
 * All names are fictional; venues are public places (Gregory Gym is UT's
 * campus rec center), placed from OpenStreetMap to within ~100 m.
 */

import { initDb } from "../api/db.js";
import type { EntityManager } from "@mikro-orm/postgresql";
import { User } from "../api/entities/User.js";
import { UserIdentifier } from "../api/entities/UserIdentifier.js";
import { Venue } from "../api/entities/Venue.js";
import { applyProfile } from "../api/social/users.js";
import { applyProfileDetails, createPost, followUser, toggleLike } from "../api/social/social.js";
import { checkInToGame } from "../api/games/checkin.js";
import { setCohost } from "../api/games/hosting.js";
import { cancelGame, createGame, findGame, joinGame } from "../api/games/lifecycle.js";
import { buildVenue } from "../api/games/venues.js";
import { getResult, recordResult, setSide, startGame } from "../api/games/results.js";
import { generateRecaps } from "../api/games/recaps.js";
import { recordProfileView } from "../api/social/discovery.js";
import { addInvite, inviteOnlyEnabled } from "../api/auth/invites.js";
import { normalizeEmail } from "../api/auth/otp.js";

export const DEMO_DOMAIN = "demo.sportsarc.test";
/** How seeds before Nov 2026 tagged game notes; reset still finds those. */
export const DEMO_TAG = "[DEMO:";
const TZ = "America/Chicago";
export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

// ── arguments and the production guard ────────────────────────────────

const USAGE = "usage: scripts/seed.ts [--reset] [--me you@example.com]";

function parseArgs(argv: string[]) {
  let reset = false;
  let me: string | null = process.env.SEED_ME?.trim() || null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--reset") reset = true;
    else if (a === "--me") me = argv[++i] ?? "";
    else if (a.startsWith("--me=")) me = a.slice(5);
    else if (a === "-h" || a === "--help") { console.log(USAGE); process.exit(0); }
    else { console.error(`unknown argument ${a}\n${USAGE}`); process.exit(2); }
  }
  return { reset, me };
}

function guardProduction(): void {
  if (process.env.NODE_ENV?.trim() !== "production") return;
  if (process.env.SEED_ALLOW_PRODUCTION === "1") {
    console.warn("!! NODE_ENV=production and SEED_ALLOW_PRODUCTION=1: seeding a production database.");
    return;
  }
  console.error("Refusing to seed: NODE_ENV=production. Set SEED_ALLOW_PRODUCTION=1 if you really mean it.");
  process.exit(1);
}

function dbLabel(): string {
  try {
    const u = new URL(process.env.DATABASE_URL ?? "");
    return `${u.hostname}:${u.port || 5432}${u.pathname}`;
  } catch {
    return "(DATABASE_URL unreadable)";
  }
}

// ── content: venues and people ────────────────────────────────────────

export type VenueKey = "givens" | "arc" | "gregory" | "healy" | "star" | "zilker" | "zilkersand" | "dovesprings" | "southaustin" | "olmos" | "montopolis";

export interface VenueSeed { name: string; address: string; city: string; lat: number; lng: number; kind: string; indoor?: boolean }

/** Public places; coordinates are the courts or fields themselves, to within ~100 m. */
export const VENUES: Record<VenueKey, VenueSeed> = {
  // Austin
  givens: { name: "Givens District Park Basketball Courts", address: "3811 E 12th St, Austin, TX 78721", city: "Austin, TX", lat: 30.2746, lng: -97.6904, kind: "court" },
  arc: { name: "Austin Recreation Center", address: "1301 Shoal Creek Blvd, Austin, TX 78701", city: "Austin, TX", lat: 30.2782, lng: -97.7490, kind: "gym", indoor: true },
  gregory: { name: "Gregory Gym (UT RecSports)", address: "2101 Speedway, Austin, TX 78712", city: "Austin, TX", lat: 30.2840, lng: -97.7364, kind: "gym", indoor: true },
  zilker: { name: "Zilker Park Great Lawn", address: "2100 Barton Springs Rd, Austin, TX 78746", city: "Austin, TX", lat: 30.2719, lng: -97.7670, kind: "park" },
  zilkersand: { name: "Zilker Park Sand Volleyball Courts", address: "2100 Barton Springs Rd, Austin, TX 78746", city: "Austin, TX", lat: 30.2688, lng: -97.7685, kind: "court" },
  dovesprings: { name: "Dove Springs Recreation Center Sand Courts", address: "5801 Ainez Dr, Austin, TX 78744", city: "Austin, TX", lat: 30.1877, lng: -97.7382, kind: "court" },
  southaustin: { name: "South Austin Neighborhood Park Courts", address: "1100 Cumberland Rd, Austin, TX 78704", city: "Austin, TX", lat: 30.2418, lng: -97.7677, kind: "court" },
  montopolis: { name: "Montopolis Recreation Center", address: "1200 Montopolis Dr, Austin, TX 78741", city: "Austin, TX", lat: 30.2323, lng: -97.6999, kind: "field" },
  // San Antonio
  healy: { name: "Healy-Murphy Park", address: "210 Nolan St, San Antonio, TX 78202", city: "San Antonio, TX", lat: 29.4275, lng: -98.4804, kind: "court" },
  star: { name: "STAR Soccer Complex", address: "5103 David Edwards Dr, San Antonio, TX 78233", city: "San Antonio, TX", lat: 29.5435, lng: -98.3925, kind: "field" },
  olmos: { name: "Olmos Basin Park", address: "651 Devine Rd, San Antonio, TX 78212", city: "San Antonio, TX", lat: 29.4946, lng: -98.4930, kind: "field" },
};

interface Person {
  key: string;
  name: string;
  role: "player" | "coach" | "scout";
  audience: "adult" | "minor";
  sport: string;
  position?: string;
  home: VenueKey;
  bio: string;
  classYear?: string;
  school?: string;
  heightInches?: number;
  highlight?: boolean;
}

/** Fictional people. "riley" stands in for the --me account when there is none. */
const PEOPLE: Person[] = [
  // basketball
  { key: "darnell", name: "Darnell Brooks", role: "player", audience: "adult", sport: "basketball", position: "PG", home: "givens", bio: "Runs the Saturday 8am full-court at Givens. Pass first, talk trash second.", heightInches: 73, highlight: true },
  { key: "keisha", name: "Keisha Monroe", role: "player", audience: "adult", sport: "basketball", position: "SG", home: "healy", bio: "Former D2 guard. San Antonio runs, and Austin when the I-35 traffic allows." },
  { key: "tomas", name: "Tomás Rivera", role: "player", audience: "adult", sport: "basketball", position: "SF", home: "arc", bio: "ARC open gym on Tuesdays. Corner threes and loud celebrations." },
  { key: "jalen", name: "Jalen Park", role: "player", audience: "adult", sport: "basketball", position: "C", home: "gregory", bio: "Grad student. 6'8\" and still getting posterized at Gregory by guards half my size.", heightInches: 80 },
  { key: "andre", name: "Andre Whitfield", role: "player", audience: "adult", sport: "basketball", position: "PF", home: "healy", bio: "Organizes the downtown San Antonio run more than he makes it to. Working on it." },
  { key: "mia", name: "Mia Castillo", role: "player", audience: "adult", sport: "basketball", position: "G", home: "givens", bio: "East Austin and Gregory. Fast breaks only." },
  { key: "nate", name: "Nate Okafor", role: "player", audience: "adult", sport: "basketball", position: "F", home: "gregory", bio: "Rebounds, screens, the dirty work. Gregory Gym after class." },
  { key: "devon", name: "Devon Price", role: "player", audience: "minor", sport: "basketball", position: "PG", home: "arc", bio: "Class of 2027. Handles, vision, a jumper that is getting there.", classYear: "2027", school: "Pecan Ridge High (fictional)", highlight: true },
  // soccer
  { key: "luis", name: "Luis Ortega", role: "player", audience: "adult", sport: "soccer", position: "CM", home: "star", bio: "Sunday 7v7 at STAR, next to Toyota Field, since forever." },
  { key: "sofia", name: "Sofia Marín", role: "player", audience: "adult", sport: "soccer", position: "ST", home: "star", bio: "Finisher. Will ask for the ball.", highlight: true },
  { key: "kwame", name: "Kwame Mensah", role: "player", audience: "adult", sport: "soccer", position: "CB", home: "zilker", bio: "Center back. Organized, calm, occasionally late to Zilker." },
  { key: "hana", name: "Hana Sato", role: "player", audience: "adult", sport: "soccer", position: "GK", home: "zilker", bio: "Keeper who wants to play out from the back." },
  { key: "diego", name: "Diego Fuentes", role: "player", audience: "adult", sport: "soccer", position: "RW", home: "montopolis", bio: "Small-sided at Montopolis on weeknights." },
  { key: "priya", name: "Priya Raman", role: "player", audience: "adult", sport: "soccer", position: "LW", home: "montopolis", bio: "Left foot only, and proud of it." },
  { key: "ava", name: "Ava Lindqvist", role: "player", audience: "minor", sport: "soccer", position: "CAM", home: "zilker", bio: "Class of 2028. Club player looking for extra touches.", classYear: "2028", school: "Live Oak Prep (fictional)" },
  // volleyball
  { key: "kai", name: "Kai Nakamura", role: "player", audience: "adult", sport: "volleyball", position: "Outside", home: "zilkersand", bio: "Doubles at the Zilker sand courts most mornings, before the heat." },
  { key: "brooke", name: "Brooke Halverson", role: "player", audience: "adult", sport: "volleyball", position: "Setter", home: "zilkersand", bio: "Setter by trade, blocker by necessity." },
  { key: "marco", name: "Marco Bellini", role: "player", audience: "adult", sport: "volleyball", position: "Blocker", home: "dovesprings", bio: "Dove Springs sand, weekends." },
  { key: "tess", name: "Tess Yamada", role: "player", audience: "adult", sport: "volleyball", position: "Defender", home: "dovesprings", bio: "Digs everything. Asks for nothing." },
  // pickleball
  { key: "ruth", name: "Ruth Abernathy", role: "player", audience: "adult", sport: "pickleball", position: "Doubles", home: "southaustin", bio: "Took up pickleball at 61. Now I run the South Austin ladder." },
  { key: "sam", name: "Sam Delgado", role: "player", audience: "adult", sport: "pickleball", position: "Doubles", home: "southaustin", bio: "Ex-tennis player, reformed." },
  { key: "gloria", name: "Gloria Chen", role: "player", audience: "adult", sport: "pickleball", position: "Singles", home: "southaustin", bio: "Third-shot drop evangelist." },
  { key: "ben", name: "Ben Adeyemi", role: "player", audience: "adult", sport: "pickleball", position: "Doubles", home: "southaustin", bio: "Weekday lunch games, all levels." },
  // flag football
  { key: "trey", name: "Trey Holloway", role: "player", audience: "adult", sport: "football", position: "QB", home: "olmos", bio: "Flag football QB at Olmos Basin. Quick release, questionable reads." },
  { key: "marcus", name: "Marcus Bell", role: "player", audience: "adult", sport: "football", position: "WR", home: "olmos", bio: "Slot receiver. Hands like glue." },
  { key: "chris", name: "Chris Lam", role: "player", audience: "adult", sport: "football", position: "Rusher", home: "olmos", bio: "Seven-Mississippi specialist." },
  { key: "riley", name: "Riley Ellis", role: "player", audience: "adult", sport: "basketball", position: "Wing", home: "givens", bio: "Plays whatever is on. Will organize if nobody else does." },
  // coaches and scouts
  { key: "ramos", name: "Linda Ramos", role: "coach", audience: "adult", sport: "basketball", position: "Head coach", home: "arc", bio: "Head coach, Eastside Elite (fictional AAU club). Always looking for guards who defend." },
  { key: "hughes", name: "Pete Hughes", role: "coach", audience: "adult", sport: "soccer", position: "Assistant coach", home: "star", bio: "Assistant coach, Mission Trail FC Academy (fictional)." },
  { key: "vance", name: "Rob Vance", role: "scout", audience: "adult", sport: "basketball", position: "Regional scout", home: "gregory", bio: "Central Texas scout. I watch pickup between Austin and San Antonio because that is where the unknowns are." },
  { key: "ito", name: "Naomi Ito", role: "scout", audience: "adult", sport: "volleyball", position: "Scout", home: "zilkersand", bio: "Beach and indoor volleyball scout for a fictional recruiting service." },
];

const emailOf = (key: string) => `${key}@${DEMO_DOMAIN}`;

// ── plumbing ──────────────────────────────────────────────────────────

export type Fork = () => EntityManager;
export type Who = string; // a PEOPLE key, or "ME"

export interface Ctx {
  fork: Fork;
  ids: Map<string, string>; // key -> user id; "ME" -> the owner or riley
  meIsOwner: boolean;
}

export function must<T extends { ok: boolean }>(r: T, what: string): Extract<T, { ok: true }> {
  if (!r.ok) {
    const e = (r as { error?: { code: string; message: string } }).error;
    throw new Error(`${what} failed: ${e?.code} ${e?.message}`);
  }
  return r as Extract<T, { ok: true }>;
}

/** Drop undefined keys: the profile patch treats a present key as "set this". */
export function defined<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export async function userOf(em: EntityManager, ctx: Ctx, who: Who): Promise<User> {
  const id = ctx.ids.get(who);
  if (!id) throw new Error(`unknown person ${who}`);
  return em.findOneOrFail(User, { id });
}

export async function gameOf(em: EntityManager, id: string) {
  const g = await findGame(em, id);
  if (!g) throw new Error(`game ${id} vanished`);
  return g;
}

export async function sql(ctx: Ctx, q: string, params: unknown[] = []) {
  return ctx.fork().getConnection().execute(q, params);
}

/** Move every timestamp of one game by `ms` (negative: into the past). */
export async function shiftGame(ctx: Ctx, gameId: string, ms: number): Promise<void> {
  const d = `(? * interval '1 millisecond')`;
  const s = [ms, gameId];
  await sql(ctx, `update games set starts_at = starts_at + ${d}, created_at = created_at + ${d} where id = ?`, [ms, ms, gameId]);
  await sql(ctx, `update game_participants set joined_at = joined_at + ${d}, checked_in_at = checked_in_at + ${d} where game_id = ?`, [ms, ms, gameId]);
  await sql(ctx, `update game_results set locked_at = locked_at + ${d}, recorded_at = recorded_at + ${d}, first_recorded_at = first_recorded_at + ${d}, created_at = created_at + ${d} where game_id = ?`, [ms, ms, ms, ms, gameId]);
  await sql(ctx, `update posts set created_at = created_at + ${d} where game_id = ?`, s);
  await sql(ctx, `update notifications set created_at = created_at + ${d} where game_id = ?`, s);
}

/** Move only when the result was recorded (and first recorded) by `ms`. */
export async function shiftRecorded(ctx: Ctx, gameId: string, ms: number): Promise<void> {
  const d = `(? * interval '1 millisecond')`;
  await sql(ctx, `update game_results set recorded_at = recorded_at + ${d}, first_recorded_at = first_recorded_at + ${d} where game_id = ?`, [ms, ms, gameId]);
  await sql(ctx, `update notifications set created_at = created_at + ${d} where game_id = ? and kind = 'result_settled'`, [ms, gameId]);
}

async function startsAtOf(ctx: Ctx, gameId: string): Promise<number> {
  const rows = await sql(ctx, `select starts_at from games where id = ?`, [gameId]);
  return new Date(rows[0].starts_at).getTime();
}

export async function moveStartTo(ctx: Ctx, gameId: string, at: number): Promise<void> {
  await shiftGame(ctx, gameId, at - (await startsAtOf(ctx, gameId)));
}

export function austinParts(ms: number) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return { y: Number(get("year")), m: Number(get("month")), d: Number(get("day")), h: Number(get("hour")), min: Number(get("minute")), weekday: get("weekday") };
}

/** The Austin day `ms` falls on, at hh:mm Austin time. */
export function atAustin(ms: number, hour: number, minute = 0): number {
  const p = austinParts(ms);
  const offset = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min) - (ms - (ms % MIN));
  return Date.UTC(p.y, p.m - 1, p.d, hour, minute) - offset;
}

/** When people play: weekend mornings, weekday evenings. */
export function playHour(ms: number, i: number): [number, number] {
  const weekend = ["Sat", "Sun"].includes(austinParts(ms).weekday);
  const slots: [number, number][] = weekend ? [[8, 0], [9, 30], [10, 0], [16, 0]] : [[18, 0], [18, 30], [19, 0], [19, 30]];
  return slots[i % slots.length];
}

// ── game steps, each through the domain functions ─────────────────────

interface NewGame {
  label: string;
  sport: string;
  venue: VenueKey;
  host: Who;
  hostPlays?: boolean;
  capacity?: number;
  duration?: number;
  skillLevel?: string;
  notes: string;
  inHours?: number;
}

let gamesMade = 0;

/** A game half a day out or more starts at a play hour on its day; nearer ones keep the exact offset (the time-bound states). */
function startFor(g: NewGame): number {
  const at = Date.now() + (g.inHours ?? 3) * HOUR;
  return (g.inHours ?? 3) >= 12 ? atAustin(at, ...playHour(at, gamesMade++)) : at;
}

async function newGame(ctx: Ctx, venues: Map<VenueKey, string>, g: NewGame): Promise<string> {
  const em = ctx.fork();
  const host = await userOf(em, ctx, g.host);
  const r = must(await createGame(em, host, {
    sport: g.sport,
    venueId: venues.get(g.venue),
    startsAt: new Date(startFor(g)).toISOString(),
    durationMinutes: g.duration ?? 90,
    capacity: g.capacity ?? 10,
    skillLevel: g.skillLevel ?? "any",
    notes: g.notes,
    hostPlays: g.hostPlays ?? true,
  }), `create ${g.label}`);
  return r.game.id;
}

export async function join(ctx: Ctx, gameId: string, who: Who[], expect: "joined" | "waitlist" = "joined") {
  for (const w of who) {
    const em = ctx.fork();
    const r = must(await joinGame(em, await gameOf(em, gameId), await userOf(em, ctx, w)), `join ${w}`);
    if (r.status !== expect) throw new Error(`join ${w}: expected ${expect}, got ${r.status}`);
  }
}

/** Put the start 30 minutes out, so check-in is open right now. */
export async function openCheckIn(ctx: Ctx, gameId: string, inMin = 30) {
  await moveStartTo(ctx, gameId, Date.now() + inMin * MIN);
}

export async function checkIn(ctx: Ctx, gameId: string, who: Who[]) {
  for (const w of who) {
    const em = ctx.fork();
    const game = await gameOf(em, gameId);
    must(await checkInToGame(em, game, await userOf(em, ctx, w), { lat: game.venue.lat, lng: game.venue.lng }), `check in ${w}`);
  }
}

/** The host puts each player on their side. */
export async function sides(ctx: Ctx, gameId: string, host: Who, side0: Who[], side1: Who[]) {
  for (const [side, who] of [[0, side0], [1, side1]] as const) {
    for (const w of who) {
      const em = ctx.fork();
      must(await setSide(em, await gameOf(em, gameId), await userOf(em, ctx, host), { userId: ctx.ids.get(w), side }), `side ${w}`);
    }
  }
}

export async function start(ctx: Ctx, gameId: string, who: Who) {
  const em = ctx.fork();
  must(await startGame(em, await gameOf(em, gameId), await userOf(em, ctx, who)), `start by ${who}`);
}

export async function record(ctx: Ctx, gameId: string, who: Who, body: { outcome: string; winningSide?: number; score?: [number, number] }) {
  const em = ctx.fork();
  must(await recordResult(em, await gameOf(em, gameId), await userOf(em, ctx, who), body), `record by ${who}`);
}

/**
 * A game that was played: join, check in and set sides "now", the host taps start,
 * run `during` (recording the result), then push the whole game back so it
 * started `agoMs` ago.
 */
async function played(
  ctx: Ctx,
  venues: Map<VenueKey, string>,
  g: NewGame & { side0: Who[]; side1: Who[]; sitOut?: Who[]; agoMs: number; lock?: "start" | "auto"; playedAt?: [number, number] },
  during?: (id: string) => Promise<void>,
): Promise<string> {
  const id = await newGame(ctx, venues, g);
  const everyone = [...g.side0, ...g.side1, ...(g.sitOut ?? [])];
  const hostSeated = g.hostPlays !== false;
  await join(ctx, id, everyone.filter((w) => !(hostSeated && w === g.host)));
  await openCheckIn(ctx, id);
  await checkIn(ctx, id, everyone);
  await sides(ctx, id, g.host, g.side0, g.side1);
  if ((g.lock ?? "start") === "start") await start(ctx, id, g.host);
  // Back into the past: the start moves to now - agoMs (at playedAt, Austin time, that day).
  const ago = Date.now() - g.agoMs;
  await moveStartTo(ctx, id, g.playedAt ? atAustin(ago, ...g.playedAt) : ago);
  // Auto lock: the first read after check-in closed locks the sides.
  if (g.lock === "auto") {
    const em = ctx.fork();
    await getResult(em, await gameOf(em, id));
  }
  if (during) await during(id);
  return id;
}

// ── reset ─────────────────────────────────────────────────────────────

const DEMO_GAMES_SQL = (demoUsers: string) => `(select id from games where host_id in ${demoUsers}
     or (exists (select 1 from game_participants p where p.game_id = games.id and p.user_id in ${demoUsers})
         and not exists (select 1 from game_participants p where p.game_id = games.id and p.user_id <> games.host_id and p.user_id not in ${demoUsers}))
     or (notes like ? and exists (select 1 from game_participants p where p.game_id = games.id and p.user_id in ${demoUsers})))`;

export async function resetDemo(fork: Fork): Promise<Record<string, number>> {
  const like = `%@${DEMO_DOMAIN}`;
  const demoUsers = `(select user_id from user_identifiers where kind = 'email' and value like ?)`;
  const demoGames = DEMO_GAMES_SQL(demoUsers);
  const gameParams = [like, like, like, `${DEMO_TAG}%`, like];
  const out: Record<string, number> = {};
  await fork().transactional(async (tx) => {
    const c = tx.getConnection();
    const count = async (q: string, p: unknown[]) => Number(((await c.execute(q, p, "get")) as { n?: unknown }).n ?? 0);
    out.users = await count(`select count(*) as n from user_identifiers where kind = 'email' and value like ?`, [like]);
    out.games = await count(`select count(*) as n from games where id in ${demoGames}`, gameParams);
    // Posts about demo games that outlive them otherwise (post.game is set null on delete).
    await c.execute(`delete from posts where kind in ('system', 'recap') and game_id in ${demoGames}`, gameParams);
    await c.execute(`delete from games where id in ${demoGames}`, gameParams);
    out.venues = await count(
      `select count(*) as n from venues v where created_by_id in ${demoUsers} and not exists (select 1 from games g where g.venue_id = v.id)`, [like]);
    await c.execute(
      `delete from venues v where created_by_id in ${demoUsers} and not exists (select 1 from games g where g.venue_id = v.id)`, [like]);
    await c.execute(`delete from users where id in ${demoUsers}`, [like]);
  });
  return out;
}

// ── seed ──────────────────────────────────────────────────────────────

export async function createAccount(em: EntityManager, email: string): Promise<User> {
  const user = new User();
  const ident = new UserIdentifier();
  ident.user = user;
  ident.kind = "email";
  ident.value = email;
  user.identifiers.add(ident);
  em.persist([user, ident]);
  await em.flush();
  return user;
}

async function seedPeople(ctx: Ctx, venueNames: Map<VenueKey, string>) {
  for (const p of PEOPLE) {
    const em = ctx.fork();
    const user = await createAccount(em, emailOf(p.key));
    const applied = applyProfile(user, { name: p.name, role: p.role, audience: p.audience });
    if (!applied.ok) throw new Error(`profile ${p.key}: ${applied.message}`);
    must(await applyProfileDetails(user, defined({
      bio: p.bio,
      location: VENUES[p.home].city,
      primarySport: p.sport,
      position: p.position,
      classYear: p.classYear,
      school: p.school,
      heightInches: p.heightInches,
      headline: p.role === "player" ? `${p.position ?? "Player"} · home court: ${venueNames.get(p.home)}` : `${p.position} · ${p.sport}`,
      // Placeholder video ids: they point at nothing, so no real person's clip is used.
      highlightUrl: p.highlight ? `https://www.youtube.com/watch?v=demo${p.key.padEnd(7, "0").slice(0, 7)}` : undefined,
      links: p.role !== "player" ? [{ label: "Club site", url: `https://example.com/${p.key}` }] : undefined,
    })), `profile details ${p.key}`);
    await em.flush();
    ctx.ids.set(p.key, user.id);
  }
}

async function ensureMe(ctx: Ctx, email: string): Promise<{ created: boolean; invited: boolean }> {
  const em = ctx.fork();
  const existing = await em.findOne(UserIdentifier, { kind: "email", value: email }, { populate: ["user"] });
  let created = false;
  let user: User;
  if (existing) user = existing.user;
  else {
    user = await createAccount(em, email);
    const local = email.split("@")[0].replace(/[^a-z0-9]+/gi, " ").trim() || "Owner";
    applyProfile(user, { name: local.replace(/\b\w/g, (c) => c.toUpperCase()), role: "player", audience: "adult" });
    must(await applyProfileDetails(user, {
      bio: "Seeded account for trying every flow.",
      location: "Austin, TX",
      primarySport: "basketball",
      position: "Wing",
    }), "owner profile");
    await em.flush();
    created = true;
  }
  let invited = false;
  if (inviteOnlyEnabled()) {
    must(await addInvite(em, { email, note: "demo seed (--me)" }, null), "invite owner");
    invited = true;
  }
  ctx.ids.set("ME", user.id);
  return { created, invited };
}

async function seedSocial(ctx: Ctx): Promise<{ posts: number; follows: number; likes: number }> {
  const keys = PEOPLE.map((p) => p.key);
  const bySport = (s: string) => PEOPLE.filter((p) => p.sport === s && p.role === "player").map((p) => p.key);
  let follows = 0;
  const follow = async (a: Who, b: Who) => {
    if (a === b) return;
    const em = ctx.fork();
    must(await followUser(em, await userOf(em, ctx, a), ctx.ids.get(b)!), `follow ${a}->${b}`);
    follows++;
  };
  // Players follow their sport's players and its coaches and scouts; coaches and scouts follow players.
  for (const p of PEOPLE) {
    const mates = bySport(p.sport).filter((k) => k !== p.key).slice(0, 5);
    const recruiters = PEOPLE.filter((q) => q.role !== "player" && q.sport === p.sport).map((q) => q.key);
    for (const m of p.role === "player" ? [...mates, ...recruiters] : bySport(p.sport)) await follow(p.key, m);
  }
  // The owner (or riley) follows a spread of people, and some follow back.
  const meFollows = ["darnell", "keisha", "sofia", "luis", "kai", "ruth", "trey", "ramos", "vance", "devon", "ava", "mia"];
  for (const k of meFollows) await follow("ME", k);
  for (const k of ["darnell", "mia", "luis", "ramos", "vance", "kai"]) await follow(k, "ME");

  const POSTS: [Who, string][] = [
    ["darnell", "8am full-court at Givens is back on this Saturday. Bring a white and a dark shirt."],
    ["darnell", "New handle drill I've been working on: https://www.youtube.com/watch?v=demodarnell"],
    ["keisha", "Anyone know if Healy-Murphy has the lights on past nine?"],
    ["tomas", "ARC open gym went to 21-19 in the last game. Legs are gone."],
    ["jalen", "Looking for a couple of bigs for a Thursday night run. Reply if you're in."],
    ["mia", "Fast break drill clinic at Givens next week, free, all levels."],
    ["devon", "Summer workouts paying off. Went 5 for 7 from deep today."],
    ["luis", "Sunday 7v7 at STAR is full, but join the waitlist, spots always open up."],
    ["sofia", "Hat trick at STAR. Highlights: https://www.youtube.com/watch?v=demosofiaaa"],
    ["hana", "Keepers wanted for a small-sided rotation on the Zilker Great Lawn."],
    ["ava", "Looking for weekday touches before club season starts."],
    ["kai", "Zilker sand was perfect this morning. No wind, and done before the heat."],
    ["brooke", "Setting clinic for beginners this weekend at Zilker."],
    ["marco", "Dove Springs doubles, king of the court, Saturday 9am."],
    ["ruth", "The South Austin ladder has 22 people on it now. Come get ranked."],
    ["gloria", "Third-shot drops: I will not stop talking about them."],
    ["trey", "Flag football at Olmos Basin, 7v7, Sunday afternoons. Need two rushers."],
    ["ramos", "Coaches: pickup is where I found my best guard last year. Watch the regulars."],
    ["vance", "Scouting tip for players: keep your profile's highlight link current."],
    ["ito", "Sand doubles scouting this month around Austin."],
    ["ME", "Trying out SportsArc. Who is playing this week?"],
  ];
  const ids: string[] = [];
  for (const [who, body] of POSTS) {
    const em = ctx.fork();
    ids.push(must(await createPost(em, await userOf(em, ctx, who), { body }), `post ${who}`).post.id);
  }
  // Replies.
  const REPLIES: [number, Who, string][] = [
    [0, "keisha", "I'm in. Dark shirt."],
    [0, "ME", "Count me in too."],
    [4, "nate", "I can play Thursday."],
    [7, "diego", "On the waitlist!"],
    [11, "brooke", "Best morning of the month."],
    [14, "sam", "Climbing it one match at a time."],
    [17, "devon", "Noted, coach."],
    [20, "darnell", "Givens, Saturday 8am. See you there."],
  ];
  for (const [i, who, body] of REPLIES) {
    const em = ctx.fork();
    must(await createPost(em, await userOf(em, ctx, who), { body, replyTo: ids[i] }), `reply ${who}`);
  }
  // Likes: a deterministic spread.
  let likes = 0;
  for (let i = 0; i < ids.length; i++) {
    for (let j = 0; j < 1 + ((i * 7) % 6); j++) {
      const who = [...keys, "ME"][(i * 5 + j * 3) % (keys.length + 1)];
      const em = ctx.fork();
      const author = POSTS[i][0];
      if (who === author) continue;
      const r = must(await toggleLike(em, await userOf(em, ctx, who), ids[i]), `like ${who}`);
      if (!r.liked) must(await toggleLike(em, await userOf(em, ctx, who), ids[i]), `relike ${who}`);
      likes++;
    }
  }
  // Spread posts over the last week rather than the last second.
  for (let i = 0; i < ids.length; i++) {
    const back = (ids.length - i) * 7 * HOUR;
    await sql(ctx, `update posts set created_at = now() - (? * interval '1 millisecond') where id = ? or reply_to_id = ?`, [back, ids[i], ids[i]]);
  }
  for (const id of ids) {
    await sql(ctx, `update posts set created_at = (select created_at from posts where id = ?) + interval '20 minutes' where reply_to_id = ?`, [id, id]);
  }

  // Profile views: coaches and scouts look at players (named to the player),
  // a minor looks at the owner (counted, never named).
  for (const [viewer, viewed] of [["ramos", "ME"], ["vance", "ME"], ["vance", "darnell"], ["ramos", "devon"], ["hughes", "sofia"], ["ito", "kai"], ["devon", "ME"], ["keisha", "ME"]] as [Who, Who][]) {
    const em = ctx.fork();
    await recordProfileView(em, await userOf(em, ctx, viewer), ctx.ids.get(viewed)!);
  }
  return { posts: ids.length + REPLIES.length, follows, likes };
}

export interface SeededGame {
  label: string;
  state: string;
  gameId: string;
  sport: string;
  venue: string;
  meRole: string;
  expect: Record<string, unknown>;
}

const HISTORY_NOTES: Record<string, string> = {
  basketball: "Regular run, first to 15, winners stay on.",
  soccer: "Small-sided rotation, 7-minute games.",
  pickleball: "Ladder doubles, games to 11.",
  volleyball: "Sand doubles, rally to 21.",
};

/** Open games through the coming week, so Games and the map look like a city that plays. */
const OPEN_GAMES: (NewGame & { joiners: Who[] })[] = [
  { label: "open: Givens run", sport: "basketball", venue: "givens", host: "darnell", capacity: 10, inHours: 30, notes: "Full-court, all levels. Bring a light and a dark shirt.", joiners: ["tomas", "andre", "nate"] },
  { label: "open: Great Lawn", sport: "soccer", venue: "zilker", host: "hana", capacity: 12, inHours: 54, notes: "Small-sided on the Great Lawn. Keepers especially welcome.", joiners: ["kwame", "priya", "diego"] },
  { label: "open: ladder doubles", sport: "pickleball", venue: "southaustin", host: "ruth", capacity: 8, inHours: 80, notes: "Ladder doubles, games to 11. Results count toward the South Austin ladder.", joiners: ["gloria", "ben"] },
  { label: "open: ARC indoor", sport: "basketball", venue: "arc", host: "tomas", capacity: 10, inHours: 104, notes: "Indoor full-court, games to 15. Gym closes at 9.", joiners: ["andre", "jalen", "mia"] },
  { label: "open: Dove Springs sand", sport: "volleyball", venue: "dovesprings", host: "marco", capacity: 4, inHours: 128, notes: "King of the court doubles. One spot left for a setter.", joiners: ["tess"] },
  { label: "open: Olmos flag", sport: "football", venue: "olmos", host: "trey", capacity: 14, inHours: 152, notes: "Flag football, 7v7. Need two rushers.", joiners: ["marcus", "chris", "nate"] },
];

async function seedGames(ctx: Ctx, venues: Map<VenueKey, string>): Promise<SeededGame[]> {
  const out: SeededGame[] = [];
  const add = (label: string, state: string, gameId: string, g: NewGame, meRole: string, expect: Record<string, unknown> = {}) =>
    out.push({ label, state, gameId, sport: g.sport, venue: VENUES[g.venue].name, meRole, expect });

  // ── upcoming ────────────────────────────────────────────────────────
  {
    const g: NewGame = { label: "upcoming, open", sport: "basketball", venue: "healy", host: "keisha", capacity: 10, inHours: 50, notes: "Full-court runs to 21, all levels. Bring a light and a dark shirt." };
    const id = await newGame(ctx, venues, g);
    await join(ctx, id, ["darnell", "tomas", "mia"]);
    add(g.label, "upcoming and open; you are not in it (Join)", id, g, "none (can join)", { gameStatus: "open", viewerStatus: null });
  }
  {
    const g: NewGame = { label: "upcoming, you host", sport: "pickleball", venue: "southaustin", host: "ME", capacity: 4, skillLevel: "intermediate", inHours: 74, notes: "Doubles round robin, games to 11. Spare paddles if you need one." };
    const id = await newGame(ctx, venues, g);
    await join(ctx, id, ["ruth", "sam"]);
    add(g.label, "upcoming and open; you host and play", id, g, "host (playing)", { viewerRole: "host", viewerStatus: "joined" });
  }
  {
    const g: NewGame = { label: "full, waitlist", sport: "soccer", venue: "star", host: "luis", capacity: 6, inHours: 26, notes: "6v6 small-sided, two 25-minute halves. Shin guards on." };
    const id = await newGame(ctx, venues, g);
    await join(ctx, id, ["sofia", "kwame", "ME", "hana", "diego"]);
    await join(ctx, id, ["priya", "ava"], "waitlist");
    const em = ctx.fork();
    must(await setCohost(em, await gameOf(em, id), await userOf(em, ctx, "luis"), { userId: ctx.ids.get("ME"), cohost: true }), "name cohost");
    add(g.label, "full with a waitlist (2); you are a co-host", id, g, "co-host (playing)", { gameStatus: "full", waitlistCount: 2, viewerRole: "cohost" });
  }
  {
    const g: NewGame = { label: "non-playing host, co-hosts", sport: "pickleball", venue: "southaustin", host: "ME", hostPlays: false, capacity: 8, inHours: 98, notes: "Open play night, all levels. Paddles rotate in every game." };
    const id = await newGame(ctx, venues, g);
    await join(ctx, id, ["gloria", "sam", "ben", "ruth"]);
    for (const k of ["gloria", "sam"]) {
      const em = ctx.fork();
      must(await setCohost(em, await gameOf(em, id), await userOf(em, ctx, "ME"), { userId: ctx.ids.get(k), cohost: true }), `cohost ${k}`);
    }
    add(g.label, "upcoming; you host without playing; two co-hosts", id, g, "host (not playing)", { viewerRole: "host", hostPlays: false, viewerStatus: null, cohosts: 2 });
  }
  {
    const g: NewGame = { label: "cancelled", sport: "volleyball", venue: "zilkersand", host: "brooke", capacity: 4, inHours: 146, notes: "Sand doubles, king of the court." };
    const id = await newGame(ctx, venues, g);
    await join(ctx, id, ["kai", "ME"]);
    const em = ctx.fork();
    must(await cancelGame(em, await gameOf(em, id), await userOf(em, ctx, "brooke")), "cancel");
    add(g.label, "cancelled by the host", id, g, "player", { gameStatus: "cancelled" });
  }

  for (const g of OPEN_GAMES) {
    const id = await newGame(ctx, venues, g);
    await join(ctx, id, g.joiners);
    add(g.label, "upcoming and open", id, g, "none (can join)", { gameStatus: "open" });
  }

  // ── today ───────────────────────────────────────────────────────────
  {
    const g: NewGame = { label: "check-in open now", sport: "basketball", venue: "givens", host: "darnell", capacity: 10, notes: "Full-court, first to 21. Winners stay on." };
    const id = await newGame(ctx, venues, g);
    await join(ctx, id, ["keisha", "ME", "jalen"]);
    await openCheckIn(ctx, id, 45);
    await checkIn(ctx, id, ["darnell", "keisha"]);
    add(g.label, "check-in open now (about 55 minutes after seeding)", id, g, "player (not checked in)", { checkInWindow: "open", viewerCheckedIn: false });
  }
  {
    const g: NewGame = { label: "sides being picked", sport: "volleyball", venue: "zilkersand", host: "ME", capacity: 6, notes: "Sand doubles, two a side, rally to 21." };
    const id = await newGame(ctx, venues, g);
    await join(ctx, id, ["kai", "brooke", "marco", "tess"]);
    await openCheckIn(ctx, id, 35);
    await checkIn(ctx, id, ["kai", "brooke", "marco", "tess", "ME"]);
    await sides(ctx, id, "ME", ["kai", "brooke"], ["marco", "tess"]);
    add(g.label, "sides being set (about 50 minutes after seeding)", id, g, "host (checked in, no side)", { result: "picking", canSetSides: true });
  }

  // ── results ─────────────────────────────────────────────────────────
  {
    const g = { label: "locked, not recorded", sport: "basketball", venue: "gregory" as VenueKey, host: "ME", capacity: 8, notes: "Half-court 3v3 after work, games to 15.", side0: ["ME", "jalen", "keisha"], side1: ["nate", "mia", "tomas"], agoMs: 3 * HOUR };
    const id = await played(ctx, venues, g);
    add(g.label, "locked, nothing recorded yet (Results waiting on you)", id, g, "host, side 0", { result: "locked", need: "record" });
  }
  {
    const g = { label: "recorded, correction open", sport: "soccer", venue: "star" as VenueKey, host: "ME", capacity: 10, notes: "8v8 on the big field. Bring water.", side0: ["sofia", "luis", "kwame", "hana"], side1: ["ME", "diego", "priya", "ava"], agoMs: 3 * HOUR };
    const id = await played(ctx, venues, g, async (id) => {
      await record(ctx, id, "ME", { outcome: "win", winningSide: 0, score: [3, 1] });
    });
    add(g.label, "recorded minutes ago; you can still correct it", id, g, "host, side 1", { result: "settled", outcome: "win" });
  }
  {
    const g = { label: "settled: win with a score", sport: "basketball", venue: "givens" as VenueKey, host: "darnell", capacity: 8, notes: "Full-court, first to 21.", side0: ["darnell", "ME", "mia", "keisha"], side1: ["jalen", "nate", "tomas", "andre"], agoMs: 26 * HOUR, playedAt: [19, 0] as [number, number] };
    const id = await played(ctx, venues, g, async (id) => {
      await record(ctx, id, "darnell", { outcome: "win", winningSide: 0, score: [21, 17] });
      await shiftRecorded(ctx, id, -24 * HOUR);
    });
    add(g.label, "settled: a win, 21-17, with a recap", id, g, "seat, winning side", { result: "settled", outcome: "win" });
  }
  {
    const g = { label: "settled: draw", sport: "soccer", venue: "zilker" as VenueKey, host: "kwame", capacity: 10, notes: "Small-sided on the Great Lawn, all levels.", side0: ["kwame", "hana", "ME", "luis"], side1: ["sofia", "diego", "priya", "ava"], agoMs: 44 * HOUR, playedAt: [18, 30] as [number, number] };
    const id = await played(ctx, venues, g, async (id) => {
      await record(ctx, id, "kwame", { outcome: "draw", score: [2, 2] });
      await shiftRecorded(ctx, id, -40 * HOUR);
    });
    add(g.label, "settled: a draw, 2-2, with a recap", id, g, "seat, side 0", { result: "settled", outcome: "draw" });
  }
  {
    const g = { label: "settled: not played", sport: "football", venue: "olmos" as VenueKey, host: "trey", capacity: 14, notes: "Flag football, 7v7. Need two rushers.", side0: [], side1: [], sitOut: ["trey", "marcus", "chris", "ME", "nate", "andre"], agoMs: 47 * HOUR, lock: "auto" as const, playedAt: [16, 0] as [number, number] };
    const id = await played(ctx, venues, g, async (id) => {
      await record(ctx, id, "trey", { outcome: "not_played" });
      await shiftRecorded(ctx, id, -44 * HOUR);
    });
    add(g.label, "settled: not played (sides locked automatically at check-in close)", id, g, "seat, no side", { result: "settled", outcome: "not_played" });
  }

  // ── history: settled games so the regulars ladders fill up ──────────
  const history: [VenueKey, string, Who[], Who[], number][] = [
    ["givens", "basketball", ["darnell", "keisha", "ME"], ["mia", "jalen", "nate"], 6],
    ["givens", "basketball", ["darnell", "mia", "tomas"], ["keisha", "nate", "ME"], 11],
    ["givens", "basketball", ["darnell", "keisha", "devon"], ["mia", "tomas", "andre"], 17],
    ["givens", "basketball", ["darnell", "jalen", "ME"], ["mia", "keisha", "nate"], 24],
    ["givens", "basketball", ["darnell", "mia"], ["keisha", "tomas"], 38],
    ["arc", "basketball", ["tomas", "andre", "devon"], ["nate", "jalen", "mia"], 9],
    ["healy", "basketball", ["keisha", "andre", "ME"], ["darnell", "nate", "tomas"], 4],
    ["healy", "basketball", ["keisha", "andre", "jalen"], ["mia", "nate", "riley"], 13],
    ["star", "soccer", ["luis", "sofia", "hana"], ["kwame", "diego", "priya"], 20],
    ["star", "soccer", ["luis", "sofia", "kwame"], ["hana", "diego", "ME"], 8],
    ["star", "soccer", ["luis", "sofia", "priya"], ["kwame", "hana", "ava"], 15],
    ["southaustin", "pickleball", ["ruth", "gloria"], ["sam", "ben"], 5],
    ["southaustin", "pickleball", ["ruth", "sam"], ["gloria", "ME"], 12],
    ["zilkersand", "volleyball", ["kai", "brooke"], ["marco", "tess"], 7],
  ];
  let h = 0;
  for (const [venue, sport, side0, side1, daysAgo] of history) {
    h++;
    const unique = (xs: Who[]) => xs.filter((w, i) => xs.findIndex((v) => ctx.ids.get(v) === ctx.ids.get(w)) === i);
    const s0 = unique(side0);
    const s1 = unique(side1).filter((w) => !s0.some((v) => ctx.ids.get(v) === ctx.ids.get(w)));
    const g = { label: `history ${h}`, sport, venue, host: s0[0], capacity: 10, notes: HISTORY_NOTES[sport] ?? "Regular run, all levels.", side0: s0, side1: s1, agoMs: daysAgo * DAY, playedAt: playHour(Date.now() - daysAgo * DAY, h) };
    const id = await played(ctx, venues, g, async (id) => {
      await record(ctx, id, s0[0], { outcome: "win", winningSide: h % 2, score: h % 2 ? [11, 15] : [15, 11] });
    });
    add(g.label, `settled history, ${daysAgo} days ago`, id, g, [...s0, ...s1].includes("ME") ? "seat" : "none", { result: "settled" });
  }
  return out;
}

async function finish(ctx: Ctx, gameIds: string[]): Promise<{ recaps: number }> {
  const recaps = await generateRecaps(ctx.fork());
  // Recaps land at the game's end, not at seeding time.
  await sql(ctx, `update posts set created_at = g.starts_at + (g.duration_minutes * interval '1 minute')
    from games g where posts.game_id = g.id and posts.kind = 'recap' and g.id in (${gameIds.map(() => "?").join(", ")})`, gameIds);
  return { recaps };
}

// ── main ──────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  guardProduction();
  let meEmail: string | null = null;
  if (args.me !== null) {
    meEmail = normalizeEmail(args.me);
    if (!meEmail) { console.error(`--me: "${args.me}" is not an email address`); return 2; }
    if (meEmail.endsWith(`@${DEMO_DOMAIN}`)) { console.error(`--me must be a real account, not @${DEMO_DOMAIN}`); return 2; }
  }

  const bar = "=".repeat(72);
  console.log(`${bar}\n  SportsArc DEMO SEED  ${args.reset ? "(reset only)" : ""}\n  database: ${dbLabel()}\n  NODE_ENV: ${process.env.NODE_ENV ?? "(unset)"}\n  ${args.reset ? "Removes" : "Replaces"} demo accounts (@${DEMO_DOMAIN}) and the games they play in.\n${bar}`);

  const orm = await initDb();
  const fork: Fork = () => orm.em.fork();
  try {
    const removed = await resetDemo(fork);
    console.log(`removed earlier demo data: ${removed.users} accounts, ${removed.games} games, ${removed.venues} venues`);
    if (args.reset) return 0;

    const ctx: Ctx = { fork, ids: new Map(), meIsOwner: Boolean(meEmail) };

    // A curator account owns the venues the seed creates, so reset can find them.
    const venues = new Map<VenueKey, string>();
    await seedPeople(ctx, new Map(Object.entries(VENUES).map(([k, v]) => [k as VenueKey, v.name])));
    const curator = await fork().findOneOrFail(User, { id: ctx.ids.get("ruth")! });
    for (const [key, v] of Object.entries(VENUES) as [VenueKey, (typeof VENUES)[VenueKey]][]) {
      const em = fork();
      let venue = await em.findOne(Venue, { name: v.name });
      if (!venue) {
        const built = buildVenue(v, em.getReference(User, curator.id));
        if ("ok" in built) throw new Error(`venue ${key}: ${built.error.message}`);
        venue = built;
        await em.persistAndFlush(venue);
      }
      venues.set(key, venue.id);
    }
    console.log(`people: ${PEOPLE.length}, venues: ${venues.size}`);

    let me = { created: false, invited: false };
    if (meEmail) me = await ensureMe(ctx, meEmail);
    else ctx.ids.set("ME", ctx.ids.get("riley")!);

    const social = await seedSocial(ctx);
    console.log(`social: ${social.posts} posts and replies, ${social.follows} follows, ${social.likes} likes`);
    const games = await seedGames(ctx, venues);
    const extra = await finish(ctx, games.map((g) => g.gameId));
    console.log(`recaps written: ${extra.recaps}`);

    // Summary.
    const who = meEmail ? `${meEmail}${me.created ? " (created)" : " (existing account)"}${me.invited ? ", invited" : ""}` : "no --me: Riley Ellis (riley@demo.sportsarc.test) holds those seats";
    console.log(`\n${bar}\n  Seeded games  (you = ${who})\n  In the app: Games tab (#/games); a game's API record: GET /api/games/<id>\n${bar}`);
    for (const g of games.filter((x) => !x.label.startsWith("history"))) {
      console.log(`  ${g.label.padEnd(34)} ${g.gameId}\n      ${g.state}\n      ${g.sport} at ${g.venue}; you: ${g.meRole}\n      /api/games/${g.gameId}  (result: /api/games/${g.gameId}/result)`);
    }
    const hist = games.filter((x) => x.label.startsWith("history"));
    console.log(`  plus ${hist.length} settled history games (regulars ladders at Givens, ARC, Healy-Murphy, STAR, South Austin, Zilker)`);
    const stamp = new Date(Date.now() + 45 * MIN).toLocaleTimeString();
    console.log(`\n  Time-bound: "check-in open now" and "sides being picked" hold until about ${stamp}; re-run the seed to refresh.\n${bar}`);

    return 0;
  } finally {
    await orm.close();
  }
}

// Import-safe: only runs when executed directly.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("scripts/seed.ts")) {
  main().then((code) => process.exit(code), (err) => {
    console.error("seed failed:", err instanceof Error ? err.stack ?? err.message : err);
    process.exit(1);
  });
}
