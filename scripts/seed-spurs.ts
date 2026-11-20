/**
 * The Spurs Sports & Entertainment case-study seed (step 8 of the plan).
 *
 *   node --env-file=.env --import=tsx scripts/seed-spurs.ts [--reset]
 *
 * What it builds, through the real service functions:
 *   - three verified orgs with invented staff: Spurs Sports & Entertainment
 *     (sponsor), Austin Spurs (club), I-35 3v3 League (league). The orgs use
 *     real names; every person is fictional and no real SS&E employee appears.
 *   - SS&E partner courts at Givens and Healy-Murphy, active 30 days ago, so
 *     Insights has four weeks before and four after.
 *   - the league "I-35 3v3" and its season "Fall 2026": 4 teams, a two-leg
 *     round robin across the partner courts, every game checked in, played,
 *     recorded and confirmed, the season sponsored by SS&E and finished.
 *   - eight weeks of basketball pickup history on eight courts, more at the
 *     partner courts once the sponsorship starts.
 *   - the Austin Spurs "2027 Local Tryout" (a future paid event), invites for
 *     the top two teams, and consent from a few invited players.
 *
 * Not seeded, on purpose: the tryout's $200 entry terms and any entry
 * (they need the club signer's and players' Circle PIN signatures; do them
 * live in the demo), and the finals prize funding.
 *
 * Everything past-dated is written the day you run this, so records and
 * receipts carry today's date. Demo accounts end in @spurs.demo.sportsarc.test.
 * --reset removes this seed and the earlier "qa-" orgs; running it twice
 * does the same first, then seeds afresh.
 *
 * WARNING: a running dev server with TESTNET_PRIVATE_KEY and
 * RECORD_CONTRACT_ADDRESS writes every closed game and the finished season to
 * Arc testnet within about a minute of the seed (roughly 1,700 records, about
 * $2 of testnet USDC). Check the relayer balance first, test on a scratch
 * database, and seed the shared one once.
 */

import type { EntityManager } from "@mikro-orm/postgresql";
import { initDb } from "../api/db.js";
import { User } from "../api/entities/User.js";
import { Venue } from "../api/entities/Venue.js";
import { applyProfile } from "../api/social/users.js";
import { applyProfileDetails } from "../api/social/social.js";
import { buildVenue } from "../api/games/venues.js";
import { createGame } from "../api/games/lifecycle.js";
import { confirmRoster } from "../api/games/roster.js";
import { generateRecaps } from "../api/games/recaps.js";
import { createOrg, setVerified, inviteStaff, answerInvite } from "../api/orgs/orgs.js";
import { sponsorVenue, proposeSeason, answerSeasonSponsor } from "../api/orgs/sponsors.js";
import { addPlayer, addTeam, createLeague, createSeason, generateSchedule, setFinals, setSeasonStatus } from "../api/leagues/leagues.js";
import { createTryout, giveConsent, inviteFromSeason } from "../api/tryouts/tryouts.js";
import {
  DAY, HOUR, MIN, VENUES, atAustin, austinParts, checkIn, createAccount, defined, gameOf, join, moveStartTo, must, openCheckIn,
  playHour, record, shiftGame, shiftRecorded, sides, sql, start, userOf,
  type Ctx, type VenueKey, type Who,
} from "./seed.js";

export const SPURS_DOMAIN = "spurs.demo.sportsarc.test";
const ORG_SLUGS = ["spurs-sports-entertainment", "austin-spurs", "i-35-3v3-league"];
const QA_SLUGS = ["qa-spurs-sports-entertainment", "qa-i-35-3v3-league"];
const WEEKS = 8;
const PARTNER_DAYS_AGO = 30;
/** The first of the eight weeks starts this many days back; the last game is at least 3 days old (past the correction window). */
const BASE_DAYS_AGO = 58;

// ── small helpers ─────────────────────────────────────────────────────

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = rng(20261120);
const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
function shuffled<T>(xs: T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const FIRST = ["Aaliyah", "Marcus", "Camila", "Devin", "Priscilla", "Terrance", "Lucia", "Andre", "Noelle", "Cedric", "Imani", "Rafael", "Joanna", "Malik", "Esperanza", "Trevor",
  "Simone", "Gabriel", "Delilah", "Omar", "Brenda", "Julian", "Tamara", "Mateo", "Renata", "Isaiah", "Colette", "Xavier", "Yolanda", "Dominic", "Nadia", "Elijah",
  "Marisol", "Caleb", "Phoebe", "Santiago", "Latoya", "Roman", "Bianca", "Quincy"];
const LAST = ["Alvarado", "Bishop", "Castañeda", "Dawson", "Escobedo", "Fontenot", "Gallegos", "Hargrove", "Ibarra", "Jennings", "Kimura", "Lockhart", "Maldonado", "Nolan",
  "Ortiz", "Pruitt", "Quintero", "Rutledge", "Salazar", "Tolliver", "Underwood", "Villarreal", "Whitaker", "Yarbrough", "Zamora", "Ashworth", "Beltran", "Crawley",
  "Delgadillo", "Eastman"];

/** A fake but well-formed wallet address (signers need one on the user row; nothing is sent from it). */
const walletFor = (n: number) => `0x${(0xdecaf000 + n).toString(16).padStart(8, "0").repeat(5)}`;

const BASKETBALL = "basketball";
const COURTS: VenueKey[] = ["givens", "arc", "gregory", "healy", "southaustin", "dovesprings", "montopolis", "star"];
const PARTNER_COURTS: VenueKey[] = ["givens", "healy"];

// ── reset ─────────────────────────────────────────────────────────────

async function reset(fork: () => EntityManager): Promise<Record<string, number>> {
  const like = `%@${SPURS_DOMAIN}`;
  const slugs = [...ORG_SLUGS, ...QA_SLUGS];
  const ph = slugs.map(() => "?").join(", ");
  const out: Record<string, number> = {};
  await fork().transactional(async (tx) => {
    const c = tx.getConnection();
    const orgIds = `(select id from organizations where slug in (${ph}))`;
    const seasonIds = `(select s.id from seasons s join leagues l on l.id = s.league_id where l.org_id in ${orgIds})`;
    const users = `(select user_id from user_identifiers where kind = 'email' and value like ?)`;
    const games = `(select id from games where season_id in ${seasonIds} or host_id in ${users})`;
    const count = async (q: string, p: unknown[]) => Number(((await c.execute(q, p, "get")) as { n?: unknown }).n ?? 0);
    out.games = await count(`select count(*) as n from games where id in ${games}`, [...slugs, like]);
    out.orgs = await count(`select count(*) as n from organizations where slug in (${ph})`, slugs);
    out.users = await count(`select count(*) as n from user_identifiers where kind = 'email' and value like ?`, [like]);
    await c.execute(`delete from posts where kind in ('system', 'recap') and game_id in ${games}`, [...slugs, like]);
    // A season holds its finals event; let go of it before the games go.
    await c.execute(`update seasons set finals_id = null where id in ${seasonIds}`, slugs);
    await c.execute(`delete from games where id in ${games}`, [...slugs, like]);
    await c.execute(`delete from organizations where slug in (${ph})`, slugs);
    await c.execute(`delete from venues v where created_by_id in ${users} and not exists (select 1 from games g where g.venue_id = v.id)`, [like]);
    await c.execute(`delete from users where id in ${users}`, [like]);
  });
  return out;
}

// ── people ────────────────────────────────────────────────────────────

interface Player { key: string; id: string; home: number; alt: number }

async function makeUser(ctx: Ctx, key: string, name: string, extra: { role?: "player" | "coach" | "scout"; position?: string; bio?: string; wallet?: number } = {}) {
  const em = ctx.fork();
  const user = await createAccount(em, `${key}@${SPURS_DOMAIN}`);
  const applied = applyProfile(user, { name, role: extra.role ?? "player", audience: "adult" });
  if (!applied.ok) throw new Error(`profile ${key}: ${applied.message}`);
  must(await applyProfileDetails(user, defined({
    bio: extra.bio,
    location: "Austin, TX",
    primarySport: BASKETBALL,
    position: extra.position,
  })), `profile details ${key}`);
  if (extra.wallet !== undefined) user.walletAddress = walletFor(extra.wallet);
  await em.flush();
  ctx.ids.set(key, user.id);
  return user.id;
}

async function venueIds(ctx: Ctx, curator: string): Promise<Map<VenueKey, string>> {
  const out = new Map<VenueKey, string>();
  for (const key of COURTS) {
    const em = ctx.fork();
    const spec = VENUES[key];
    let v = await em.findOne(Venue, { name: spec.name });
    if (!v) {
      const built = buildVenue(spec, em.getReference(User, curator));
      if ("ok" in built) throw new Error(`venue ${key}: ${built.error.message}`);
      v = built;
      await em.persistAndFlush(v);
    }
    out.set(key, v.id);
  }
  return out;
}

// ── a played game ─────────────────────────────────────────────────────

interface PlayedGame {
  venue: VenueKey;
  host: Who;
  side0: Who[];
  side1: Who[];
  /** The Austin day it was played, and the local start hour/minute. */
  at: number;
  /** A result and the host's "who was here". Without it, check-ins only. */
  result?: { winningSide: 0 | 1; score: [number, number] };
  confirm?: boolean;
  /** Existing game (league fixtures) or a new pickup game. */
  gameId?: string;
  hostPlays?: boolean;
  notes?: string;
}

let gamesPlayed = 0;

async function play(ctx: Ctx, venues: Map<VenueKey, string>, g: PlayedGame): Promise<string> {
  const everyone = [...g.side0, ...g.side1];
  let id = g.gameId;
  if (!id) {
    const em = ctx.fork();
    const host = await userOf(em, ctx, g.host);
    id = must(await createGame(em, host, {
      sport: BASKETBALL,
      venueId: venues.get(g.venue),
      startsAt: new Date(Date.now() + 3 * HOUR).toISOString(),
      durationMinutes: 90,
      capacity: everyone.length + 2,
      skillLevel: "any",
      notes: g.notes ?? "Full-court pickup, winners stay on.",
      hostPlays: g.hostPlays ?? true,
    }), "create pickup").game.id;
    await join(ctx, id, everyone.filter((w) => w !== g.host));
    await openCheckIn(ctx, id);
    await checkIn(ctx, id, everyone);
    await sides(ctx, id, g.host, g.side0, g.side1);
  } else {
    await openCheckIn(ctx, id);
    await checkIn(ctx, id, everyone);
  }
  await start(ctx, id, g.host);
  // Three hours back: check-in has closed, the result and the roster can be written.
  await moveStartTo(ctx, id, Date.now() - 3 * HOUR);
  if (g.result) {
    await record(ctx, id, g.host, { outcome: "win", winningSide: g.result.winningSide, score: g.result.score });
    if (g.confirm) {
      const em = ctx.fork();
      const game = await gameOf(em, id);
      const present: Record<string, boolean> = {};
      for (const w of everyone) present[ctx.ids.get(w)!] = true;
      must(await confirmRoster(em, game, await userOf(em, ctx, g.host), { present }), "confirm roster");
    }
  }
  // Then the whole game back to its day, and the result and roster to just after it ended.
  const from = Date.now() - 3 * HOUR;
  const delta = g.at - from;
  await shiftGame(ctx, id, delta);
  await sql(ctx, `update roster_checks set first_confirmed_at = first_confirmed_at + (? * interval '1 millisecond'),
    confirmed_at = confirmed_at + (? * interval '1 millisecond') where game_id = ?`, [delta, delta, id]);
  gamesPlayed += 1;
  return id;
}

// ── main ──────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const resetOnly = process.argv.includes("--reset");
  if (process.env.NODE_ENV === "production" && process.env.SEED_ALLOW_PRODUCTION !== "1") {
    console.error("refusing to seed with NODE_ENV=production (set SEED_ALLOW_PRODUCTION=1 to override)");
    return 2;
  }
  const bar = "=".repeat(72);
  let label = "(DATABASE_URL unreadable)";
  try { const u = new URL(process.env.DATABASE_URL ?? ""); label = `${u.hostname}:${u.port || 5432}${u.pathname}`; } catch { /* keep the label */ }
  console.log(`${bar}\n  SPURS CASE-STUDY SEED ${resetOnly ? "(reset only)" : ""}\n  database: ${label}\n  anchoring: ${process.env.RECORD_CONTRACT_ADDRESS && process.env.TESTNET_PRIVATE_KEY ? "a running server WILL write these to testnet" : "off here (no key or contract in this env)"}\n${bar}`);

  const orm = await initDb();
  const fork = () => orm.em.fork();
  try {
    const removed = await reset(fork);
    console.log(`removed: ${removed.orgs} orgs, ${removed.users} accounts, ${removed.games} games`);
    if (resetOnly) return 0;

    const ctx: Ctx = { fork, ids: new Map(), meIsOwner: false };
    const now = Date.now();

    // People: staff first, then about 120 players, all adults.
    let wallet = 1;
    await makeUser(ctx, "dana", "Dana Ruiz", { role: "coach", position: "Partnerships, SS&E (fictional)", wallet: wallet++, bio: "Runs community partnerships for the sponsor account. A fictional person." });
    await makeUser(ctx, "omar", "Omar Bellamy", { role: "coach", position: "League director (fictional)", wallet: wallet++, bio: "Runs the I-35 3v3 League. A fictional person." });
    await makeUser(ctx, "tessa", "Tessa Moreno", { role: "coach", position: "Basketball operations, Austin Spurs (fictional)", wallet: wallet++, bio: "Runs the club's tryout. A fictional person." });
    await makeUser(ctx, "rob", "Robert Vance", { role: "scout", position: "Austin Spurs scout (fictional)", bio: "Central Texas scout. A fictional person." });
    const players: Player[] = [];
    const seen = new Set<string>();
    for (let i = 0; players.length < 120; i++) {
      const name = `${FIRST[i % FIRST.length]} ${LAST[(i * 7 + Math.floor(i / FIRST.length)) % LAST.length]}`;
      if (seen.has(name)) continue;
      seen.add(name);
      const key = `p${String(players.length + 1).padStart(3, "0")}`;
      const id = await makeUser(ctx, key, name, { position: pick(["PG", "SG", "SF", "PF", "C", "G", "F"]) });
      players.push({ key, id, home: players.length % COURTS.length, alt: (players.length * 3 + 1) % COURTS.length });
    }
    console.log(`people: 4 staff, ${players.length} players`);

    const curator = ctx.ids.get("dana")!;
    const venues = await venueIds(ctx, curator);
    const heb = await (async () => {
      const em = fork();
      let v = await em.findOne(Venue, { name: "H-E-B Center at Cedar Park" });
      if (!v) {
        // Approximate position: this is a demo seed, not a map survey.
        const built = buildVenue({ name: "H-E-B Center at Cedar Park", address: "2100 Avenue of the Stars, Cedar Park, TX 78613", lat: 30.5036, lng: -97.8225, kind: "gym", indoor: true }, em.getReference(User, curator));
        if ("ok" in built) throw new Error(`venue heb: ${built.error.message}`);
        v = built;
        await em.persistAndFlush(v);
      }
      return v.id;
    })();

    // Orgs.
    const dana = await userOf(fork(), ctx, "dana");
    const omar = await userOf(fork(), ctx, "omar");
    const tessa = await userOf(fork(), ctx, "tessa");
    const rob = await userOf(fork(), ctx, "rob");
    {
      const em = fork();
      must(await createOrg(em, await em.findOneOrFail(User, { id: dana.id }), { name: "Spurs Sports & Entertainment", kind: "sponsor", slug: "spurs-sports-entertainment", city: "San Antonio, TX", bio: "Sponsor account for the case study. Names the partner courts and backs the I-35 3v3 League's finals." }), "org SS&E");
      must(await createOrg(fork(), await fork().findOneOrFail(User, { id: omar.id }), { name: "I-35 3v3 League", kind: "league", slug: "i-35-3v3-league", city: "Austin, TX", bio: "Three-on-three basketball along I-35, staffed by SS&E people." }), "org league");
      must(await createOrg(fork(), await fork().findOneOrFail(User, { id: tessa.id }), { name: "Austin Spurs", kind: "club", slug: "austin-spurs", city: "Cedar Park, TX", bio: "Runs the 2027 Local Tryout." }), "org club");
      for (const slug of ORG_SLUGS) must(await setVerified(fork(), slug, true), `verify ${slug}`);
      must(await inviteStaff(fork(), await fork().findOneOrFail(User, { id: omar.id }), "i-35-3v3-league", { userId: dana.id, role: "admin" }), "invite Dana to the league");
      must(await inviteStaff(fork(), await fork().findOneOrFail(User, { id: tessa.id }), "austin-spurs", { userId: rob.id, role: "staff" }), "invite Rob");
      const invites = await fork().getConnection().execute(`select id, user_id from org_invites`);
      for (const inv of invites) {
        if (inv.user_id === dana.id || inv.user_id === rob.id) {
          const em2 = fork();
          must(await answerInvite(em2, await em2.findOneOrFail(User, { id: inv.user_id }), inv.id, true), "accept invite");
        }
      }
    }
    console.log("orgs: SS&E (sponsor), I-35 3v3 League, Austin Spurs, all verified");

    // Partner courts, active 30 days ago.
    for (const k of PARTNER_COURTS) {
      const em = fork();
      must(await sponsorVenue(em, await em.findOneOrFail(User, { id: dana.id }), "spurs-sports-entertainment", { venueId: venues.get(k), offer: "Free water and a new rim on league night" }), `partner ${k}`);
    }
    await sql(ctx, `update sponsorships set starts_at = ? where kind = 'venue' and sponsor_id = (select id from organizations where slug = 'spurs-sports-entertainment')`,
      [new Date(now - PARTNER_DAYS_AGO * DAY).toISOString()]);

    // League, season, teams.
    const tomorrow = austinParts(now + DAY);
    const iso = (p: { y: number; m: number; d: number }) => `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
    const farEnd = austinParts(now + 70 * DAY);
    const league = must(await createLeague(fork(), await fork().findOneOrFail(User, { id: omar.id }), "i-35-3v3-league", { name: "I-35 3v3", sport: BASKETBALL, format: "3v3 round robin" }), "league").league;
    const season = must(await createSeason(fork(), await fork().findOneOrFail(User, { id: omar.id }), league.id, {
      name: "Fall 2026", startsOn: iso(tomorrow), endsOn: iso(farEnd), rosterMin: 3, rosterMax: 5,
    }), "season").season;
    const leaguePlayers = players.slice(0, 16);
    const teamNames = ["Eastside Kings", "Hill Country Heat", "River City Rim", "I-35 Express"];
    const rosters: Player[][] = [];
    const omarEm = () => fork().findOneOrFail(User, { id: omar.id });
    for (let t = 0; t < 4; t++) {
      const roster = leaguePlayers.slice(t * 4, t * 4 + 4);
      rosters.push(roster);
      const team = must(await addTeam(fork(), await omarEm(), season.id, { name: teamNames[t], captainId: roster[0].id }), `team ${teamNames[t]}`).team;
      for (const p of roster.slice(1)) must(await addPlayer(fork(), await omarEm(), team.id, { userId: p.id }), `add ${p.key}`);
    }
    // Round robin, two legs, every ten days from tomorrow; a round at the next partner court in turn.
    const sched = must(await generateSchedule(fork(), await omarEm(), season.id, {
      firstDate: iso(tomorrow), time: "19:00", everyDays: 10, durationMinutes: 60, legs: 2,
      venueIds: PARTNER_COURTS.map((k) => venues.get(k)),
    }), "schedule");
    console.log(`league: ${teamNames.length} teams, ${sched.fixtures} fixtures over ${sched.rounds} rounds`);

    // Play every fixture, moving each back so the last is three days ago.
    // Round r is tomorrow + 10r days; the last one lands three days ago.
    const pastShiftDays = 1 + (sched.rounds - 1) * 10 + 3;
    const fixtures = (await sql(ctx, `select g.id, g.starts_at, g.home_team_id, g.away_team_id from games g where g.season_id = ? order by g.starts_at`, [season.id])) as
      { id: string; starts_at: string; home_team_id: string; away_team_id: string }[];
    const teamRows = (await sql(ctx, `select id, name from teams where season_id = ?`, [season.id])) as { id: string; name: string }[];
    const strength = new Map(teamRows.map((t) => [t.id, 4 - teamNames.indexOf(t.name)]));
    const rosterOf = new Map(teamRows.map((t) => [t.id, rosters[teamNames.indexOf(t.name)].map((p) => p.key)]));
    for (const f of fixtures) {
      const orig = new Date(f.starts_at).getTime();
      const p = austinParts(orig);
      const at = atAustin(orig - pastShiftDays * DAY, p.h, p.min);
      const hs = strength.get(f.home_team_id)!;
      const as = strength.get(f.away_team_id)!;
      const homeWins = rand() < 0.5 + (hs - as) * 0.12;
      const loser = 10 + Math.floor(rand() * 9);
      ctx.ids.set("host:league", omar.id);
      await play(ctx, venues, {
        gameId: f.id, venue: "givens", host: "host:league", at,
        side0: rosterOf.get(f.home_team_id)!, side1: rosterOf.get(f.away_team_id)!,
        result: { winningSide: homeWins ? 0 : 1, score: homeWins ? [21, loser] : [loser, 21] }, confirm: true,
      });
    }
    // The season's real dates, the sponsorship and the finish.
    const firstAt = austinParts(Math.min(...fixtures.map((f) => new Date(f.starts_at).getTime())) - pastShiftDays * DAY);
    const lastAt = austinParts(Math.max(...fixtures.map((f) => new Date(f.starts_at).getTime())) - pastShiftDays * DAY);
    await sql(ctx, `update seasons set starts_on = ?, ends_on = ? where id = ?`, [iso(firstAt), iso(lastAt), season.id]);
    {
      const sp = must(await proposeSeason(fork(), await fork().findOneOrFail(User, { id: dana.id }), "spurs-sports-entertainment", { seasonId: season.id, offer: "Finals prize" }), "propose season");
      must(await answerSeasonSponsor(fork(), await omarEm(), sp.sponsorship.id, true), "accept season sponsor");
      await sql(ctx, `update sponsorships set starts_at = ? where id = ?`, [new Date(now - 56 * DAY).toISOString(), sp.sponsorship.id]);
    }
    // The finals: a paid event the league hosts, still ahead (its terms and prize are set live).
    {
      const finalsAt = atAustin(now + 24 * DAY, 18, 0);
      const em = fork();
      const finals = must(await createGame(em, await omarEm(), {
        kind: "event", sport: BASKETBALL, venueId: venues.get("givens"), startsAt: new Date(finalsAt).toISOString(),
        durationMinutes: 120, capacity: 16, skillLevel: "any", notes: "I-35 3v3 finals, Fall 2026. Top two teams.", hostPlays: false,
      }), "finals event").game;
      must(await setFinals(fork(), await omarEm(), season.id, { gameId: finals.id }), "link finals");
    }
    must(await setSeasonStatus(fork(), await omarEm(), season.id, { status: "final" }), "finish season");
    console.log(`league: ${fixtures.length} games played and confirmed; season Fall 2026 final, backed by SS&E`);

    // Pickup history: eight weeks, eight courts, about two games a court a week.
    const pool = players.slice(16);
    const leagueKeys = new Set(leaguePlayers.map((p) => p.key));
    const byCourt = COURTS.map((_, c) => players.filter((p) => (p.home === c || p.alt === c) && (pool.includes(p) || !leagueKeys.has(p.key) || rand() < 0.5)));
    const baseDay = now - BASE_DAYS_AGO * DAY;
    let pickups = 0;
    for (let w = 0; w < WEEKS; w++) {
      for (let c = 0; c < COURTS.length; c++) {
        const afterStart = baseDay + w * 7 * DAY >= now - PARTNER_DAYS_AGO * DAY;
        const partner = PARTNER_COURTS.includes(COURTS[c]);
        const n = partner && afterStart ? 5 : 2;
        for (let j = 0; j < n; j++) {
          const day = baseDay + (w * 7 + Math.min(6, Math.floor(rand() * 7))) * DAY;
          const dayClamped = Math.min(day, now - 3 * DAY);
          const [hh, mm] = playHour(dayClamped, pickups);
          const per = partner && afterStart ? 4 : rand() < 0.5 ? 3 : 4;
          const chosen = shuffled(byCourt[c]).slice(0, per * 2).map((p) => p.key);
          const withResult = rand() < 0.3;
          const winner: 0 | 1 = rand() < 0.5 ? 0 : 1;
          const low = 8 + Math.floor(rand() * 6);
          await play(ctx, venues, {
            venue: COURTS[c], host: chosen[0], side0: chosen.slice(0, per), side1: chosen.slice(per), at: atAustin(dayClamped, hh, mm),
            notes: per === 3 ? "Half-court 3v3, games to 15." : "4v4 full court, first to 21.",
            result: withResult ? { winningSide: winner, score: winner === 0 ? [15, low] : [low, 15] } : undefined,
            confirm: withResult,
          });
          pickups += 1;
        }
      }
    }
    console.log(`pickup: ${pickups} games over ${WEEKS} weeks`);

    // Recaps land at the game's end.
    const recaps = await generateRecaps(fork());
    await sql(ctx, `update posts set created_at = g.starts_at + (g.duration_minutes * interval '1 minute')
      from games g where posts.game_id = g.id and posts.kind = 'recap' and posts.created_at > now() - interval '1 hour'`);
    console.log(`recaps written: ${recaps}`);

    // The tryout: a future paid event hosted by the club's signer; invites from the top two teams.
    {
      const em = fork();
      const tryoutAt = atAustin(now + 45 * DAY, 10, 0);
      const ev = must(await createGame(em, await em.findOneOrFail(User, { id: tessa.id }), {
        kind: "event", sport: BASKETBALL, venueId: heb, startsAt: new Date(tryoutAt).toISOString(), durationMinutes: 180, capacity: 60,
        skillLevel: "any", notes: "Austin Spurs 2027 Local Tryout. Up to three camp invites.", hostPlays: false,
      }), "tryout event").game;
      const tryout = must(await createTryout(fork(), await em.findOneOrFail(User, { id: tessa.id }), "austin-spurs", { gameId: ev.id, name: "2027 Local Tryout", campSpots: 3 }), "tryout").tryout;
      const inv = must(await inviteFromSeason(fork(), await fork().findOneOrFail(User, { id: tessa.id }), tryout.id, { seasonId: season.id, teams: 2 }), "invite from standings");
      // A few invited players say yes to showing their record.
      const invited = (await sql(ctx, `select user_id from tryout_marks where tryout_id = ? and kind = 'invited' order by created_at limit 3`, [tryout.id])) as { user_id: string }[];
      for (const row of invited) {
        const e2 = fork();
        must(await giveConsent(e2, await e2.findOneOrFail(User, { id: row.user_id }), tryout.id), "consent");
      }
      console.log(`tryout: ${inv.invited} invited from ${inv.teams} teams, ${invited.length} consented; entry terms left for the live demo`);
    }

    const total = gamesPlayed;
    console.log(`\n${bar}\n  ${total} games played in all. Wait about a minute with the dev server up; Insights and the map read the data now,\n  the chain follows. Demo data: labeled by the ${SPURS_DOMAIN} accounts.\n${bar}`);
    return 0;
  } finally {
    await orm.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("scripts/seed-spurs.ts")) {
  main().then((code) => process.exit(code), (err) => {
    console.error("seed failed:", err instanceof Error ? err.stack ?? err.message : err);
    process.exit(1);
  });
}
