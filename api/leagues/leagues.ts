/**
 * Leagues: a league org's seasons, teams and fixtures.
 *
 * Teams come in two ways, both open at once:
 *   - staff add a team directly (a name, optionally a captain), and add
 *     players or place free agents on it;
 *   - while a season is open, a captain registers a team, players claim a
 *     spot with the team's join link (#/join/<code>), and players with no
 *     team sign up alone for staff to place.
 * Then staff generate a round robin (rules.ts) across chosen venues. Each
 * fixture is an ordinary Game of kind "league", seated from the two
 * rosters (home side 0, away side 1), so check-in, results, recaps and the
 * record work unchanged. Standings are computed on read from results.
 *
 * League play is for adults: every player and captain is checked, so the
 * season, team and join pages may name them.
 */

import type { EntityManager } from "@mikro-orm/postgresql";
import { randomBytes } from "node:crypto";
import { fail, type Failure } from "../failure.js";
import { isUuid } from "../validate.js";
import { Game, isSport } from "../entities/Game.js";
import { GameParticipant } from "../entities/GameParticipant.js";
import { GameResult } from "../entities/GameResult.js";
import { User } from "../entities/User.js";
import { Venue } from "../entities/Venue.js";
import { checkInWindow } from "../games/checkin.js";
import { canRecord } from "../games/results.js";
import { notify } from "../social/notifications.js";
import { mayTransact } from "../web3/wallet/service.js";
import { findOrg, personOf, type OrgPerson } from "../orgs/orgs.js";
import { mayOrg, orgRole, requireOrg } from "../orgs/roles.js";
import type { OrgRole } from "../orgs/OrgMember.js";
import { League } from "./League.js";
import { Registration } from "./Registration.js";
import { Season, type SeasonStatus } from "./Season.js";
import { Team } from "./Team.js";
import { TeamMember } from "./TeamMember.js";
import { addDays, schedule, standings, zonedTime, type FixtureOutcome, type StandingRow } from "./rules.js";
import { seasonSponsors, sponsorFor } from "../orgs/sponsors.js";
import { prizeSummary } from "../web3/events/events.js";

const isFailure = (v: unknown): v is Failure => typeof v === "object" && v !== null && (v as Failure).ok === false;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ROSTER = 15;
const MAX_VENUES = 8;

const seasonGone = (): Failure => fail("SEASON_NOT_FOUND", "That season does not exist.");
const teamGone = (): Failure => fail("TEAM_NOT_FOUND", "That team does not exist.");

function cleanName(raw: unknown, max: number, what: string): string | Failure {
  const v = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
  if (v.length < 2) return fail("VALIDATION_ERROR", `Give the ${what} a name.`);
  if (v.length > max) return fail("VALIDATION_ERROR", `Keep the ${what}'s name under ${max} characters.`);
  return v;
}

function intIn(raw: unknown, fallback: number, lo: number, hi: number): number | null {
  const n = raw === undefined || raw === null || raw === "" ? fallback : Math.trunc(Number(raw));
  return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
}

async function loadSeason(em: EntityManager, id: string): Promise<Season | null> {
  return isUuid(id) ? em.findOne(Season, { id }, { populate: ["league", "league.org"] }) : null;
}

async function loadTeam(em: EntityManager, id: string): Promise<Team | null> {
  return isUuid(id) ? em.findOne(Team, { id }, { populate: ["season", "season.league", "season.league.org", "captain"] }) : null;
}

const staffRole = (em: EntityManager, userId: string | undefined, season: Season) => orgRole(em, userId, season.league.org.id);
const isStaff = (role: OrgRole | null) => mayOrg(role, "run");

/** Seasons that still take roster changes. */
const rostersOpen = (s: SeasonStatus) => s === "draft" || s === "open" || s === "running";

// ── leagues and seasons ───────────────────────────────────────────────

export async function createLeague(em: EntityManager, user: User, orgRef: string, body: Record<string, unknown>) {
  const org = await findOrg(em, orgRef);
  if (!org) return fail("ORG_NOT_FOUND", "That organization does not exist.");
  const denied = await requireOrg(em, user.id, org.id, "run");
  if (denied) return denied;
  if (org.kind !== "league") return fail("ORG_KIND", "Only a league organization runs leagues.");
  const name = cleanName(body.name, 120, "league");
  if (isFailure(name)) return name;
  const sport = typeof body.sport === "string" ? body.sport.trim().toLowerCase() : "";
  if (!isSport(sport)) return fail("VALIDATION_ERROR", "Pick a sport.");
  const format = typeof body.format === "string" ? body.format.trim().slice(0, 40) || null : null;
  const league = new League();
  league.org = org;
  league.name = name;
  league.sport = sport;
  league.format = format;
  await em.persistAndFlush(league);
  return { ok: true as const, league: { id: league.id, name: league.name, sport: league.sport, format: league.format ?? null } };
}

/** An org's leagues and their seasons, newest season first. Public. */
export async function orgLeagues(em: EntityManager, orgRef: string) {
  const org = await findOrg(em, orgRef);
  if (!org) return fail("ORG_NOT_FOUND", "That organization does not exist.");
  const leagues = await em.find(League, { org }, { orderBy: { createdAt: "ASC" } });
  const seasons = leagues.length
    ? await em.find(Season, { league: { $in: leagues } }, { orderBy: { startsOn: "DESC" } })
    : [];
  const teamCounts = new Map<string, number>();
  if (seasons.length) {
    const rows = await em.execute<{ season_id: string; n: number }[]>(
      `select season_id, count(*)::int as n from teams where season_id in (${seasons.map(() => "?").join(",")}) group by season_id`,
      seasons.map((s) => s.id),
    );
    for (const r of rows) teamCounts.set(r.season_id, r.n);
  }
  return {
    ok: true as const,
    leagues: leagues.map((l) => ({
      id: l.id, name: l.name, sport: l.sport, format: l.format ?? null,
      seasons: seasons.filter((s) => s.league.id === l.id).map((s) => ({
        id: s.id, name: s.name, status: s.status, startsOn: s.startsOn, endsOn: s.endsOn, teams: teamCounts.get(s.id) ?? 0,
      })),
    })),
  };
}

export async function createSeason(em: EntityManager, user: User, leagueId: string, body: Record<string, unknown>) {
  const league = isUuid(leagueId) ? await em.findOne(League, { id: leagueId }, { populate: ["org"] }) : null;
  if (!league) return fail("LEAGUE_NOT_FOUND", "That league does not exist.");
  const denied = await requireOrg(em, user.id, league.org.id, "run");
  if (denied) return denied;
  const name = cleanName(body.name, 120, "season");
  if (isFailure(name)) return name;
  const startsOn = typeof body.startsOn === "string" ? body.startsOn : "";
  const endsOn = typeof body.endsOn === "string" ? body.endsOn : "";
  if (!DATE.test(startsOn) || !DATE.test(endsOn) || endsOn < startsOn) {
    return fail("VALIDATION_ERROR", "Give the season a start date and an end date after it.");
  }
  const rosterMin = intIn(body.rosterMin, 3, 1, MAX_ROSTER);
  const rosterMax = intIn(body.rosterMax, 5, 1, MAX_ROSTER);
  if (rosterMin === null || rosterMax === null || rosterMin > rosterMax) {
    return fail("VALIDATION_ERROR", `Rosters run from 1 to ${MAX_ROSTER} players, the minimum no more than the maximum.`);
  }
  const teamsMax = body.teamsMax === undefined || body.teamsMax === null || body.teamsMax === "" ? null : intIn(body.teamsMax, 0, 2, 64);
  if (teamsMax === null && body.teamsMax !== undefined && body.teamsMax !== null && body.teamsMax !== "") {
    return fail("VALIDATION_ERROR", "A season takes between 2 and 64 teams.");
  }
  const season = new Season();
  season.league = league;
  season.name = name;
  season.startsOn = startsOn;
  season.endsOn = endsOn;
  season.rosterMin = rosterMin;
  season.rosterMax = rosterMax;
  season.teamsMax = teamsMax;
  await em.persistAndFlush(season);
  return { ok: true as const, season: { id: season.id } };
}

const MOVES: Record<SeasonStatus, SeasonStatus[]> = {
  draft: ["open", "cancelled"],
  open: ["draft", "cancelled"],
  running: ["final", "cancelled"],
  final: [],
  cancelled: [],
};

/** Open or close registration, finish or cancel. The schedule moves a season to running. */
export async function setSeasonStatus(em: EntityManager, user: User, seasonId: string, body: { status?: unknown }) {
  const season = await loadSeason(em, seasonId);
  if (!season) return seasonGone();
  const denied = await requireOrg(em, user.id, season.league.org.id, "run");
  if (denied) return denied;
  const to = body.status as SeasonStatus;
  if (!MOVES[season.status]?.includes(to)) {
    return fail("SEASON_STATUS", `A season that is ${season.status} cannot become ${String(body.status)}.`);
  }
  if (to === "cancelled") {
    const ahead = await em.find(Game, { season, status: { $in: ["open", "full"] }, startsAt: { $gt: new Date() } });
    for (const g of ahead) g.status = "cancelled";
  }
  season.status = to;
  if (to === "final") season.finalAt = new Date();
  await em.flush();
  return { ok: true as const };
}

// ── who may join ──────────────────────────────────────────────────────

async function teamOf(em: EntityManager, season: Season, userId: string): Promise<Team | null> {
  const m = await em.findOne(TeamMember, { user: userId, team: { season } }, { populate: ["team"] });
  return m?.team ?? null;
}

async function mayJoinSeason(em: EntityManager, season: Season, user: User): Promise<Failure | null> {
  if (!rostersOpen(season.status)) return fail("SEASON_CLOSED", "This season is over.");
  if (!mayTransact(user)) return fail("ADULTS_ONLY", "League play is for adults.");
  if (await teamOf(em, season, user.id)) return fail("ALREADY_ON_TEAM", `${user.name ?? "That player"} is already on a team this season.`);
  return null;
}

async function roomOn(em: EntityManager, team: Team): Promise<Failure | null> {
  const n = await em.count(TeamMember, { team });
  return n >= team.season.rosterMax ? fail("TEAM_FULL", `${team.name} has a full roster (${team.season.rosterMax}).`) : null;
}

async function upsertRegistration(em: EntityManager, season: Season, user: User, kind: "team" | "individual", team: Team | null, status: "waiting" | "placed") {
  let reg = await em.findOne(Registration, { season, user });
  if (!reg) {
    reg = new Registration();
    reg.season = season;
    reg.user = user;
    em.persist(reg);
  }
  reg.kind = kind;
  reg.team = team;
  reg.status = status;
  return reg;
}

async function addMember(em: EntityManager, team: Team, user: User, actor: User) {
  const m = new TeamMember();
  m.team = team;
  m.user = user;
  m.addedBy = actor;
  em.persist(m);
  await upsertRegistration(em, team.season, user, team.captain?.id === user.id ? "team" : "individual", team, "placed");
  await em.flush();
  await syncSeats(em, team);
  if (actor.id !== user.id) {
    await notify(em, { recipient: user, actor, kind: "team_added", detail: `${team.name} · ${team.season.name}`.slice(0, 120) });
  }
}

const newJoinCode = () => randomBytes(9).toString("base64url");

async function makeTeam(em: EntityManager, season: Season, name: string, captain: User | null, actor: User): Promise<Team | Failure> {
  if (season.teamsMax && (await em.count(Team, { season })) >= season.teamsMax) {
    return fail("SEASON_FULL", `This season is full (${season.teamsMax} teams).`);
  }
  if (await em.count(Team, { season, name })) return fail("TEAM_NAME_TAKEN", "A team in this season already has that name.");
  const team = new Team();
  team.season = season;
  team.name = name;
  team.captain = captain;
  team.joinCode = newJoinCode();
  team.createdBy = actor;
  em.persist(team);
  await em.flush();
  if (captain) await addMember(em, team, captain, actor);
  return team;
}

// ── teams: staff add, captains register, players join ─────────────────

/** Staff add a team directly, with an optional captain picked from SportsArc. */
export async function addTeam(em: EntityManager, user: User, seasonId: string, body: { name?: unknown; captainId?: unknown }) {
  const season = await loadSeason(em, seasonId);
  if (!season) return seasonGone();
  const denied = await requireOrg(em, user.id, season.league.org.id, "run");
  if (denied) return denied;
  if (!rostersOpen(season.status)) return fail("SEASON_CLOSED", "This season is over.");
  const name = cleanName(body.name, 60, "team");
  if (isFailure(name)) return name;
  let captain: User | null = null;
  if (typeof body.captainId === "string" && body.captainId) {
    captain = isUuid(body.captainId) ? await em.findOne(User, { id: body.captainId }) : null;
    if (!captain) return fail("USER_NOT_FOUND", "That person is not on SportsArc.");
    const no = await mayJoinSeason(em, season, captain);
    if (no) return no;
  }
  const team = await makeTeam(em, season, name, captain, user);
  if (isFailure(team)) return team;
  return { ok: true as const, team: { id: team.id, name: team.name } };
}

/** While registration is open: register a team as its captain, or sign up alone. */
export async function register(em: EntityManager, user: User, seasonId: string, body: { kind?: unknown; name?: unknown; note?: unknown }) {
  const season = await loadSeason(em, seasonId);
  if (!season) return seasonGone();
  if (season.status !== "open") return fail("REGISTRATION_CLOSED", "Registration for this season is not open.");
  const no = await mayJoinSeason(em, season, user);
  if (no) return no;
  if (body.kind === "team") {
    const name = cleanName(body.name, 60, "team");
    if (isFailure(name)) return name;
    const team = await makeTeam(em, season, name, user, user);
    if (isFailure(team)) return team;
    return { ok: true as const, team: { id: team.id, name: team.name, joinCode: team.joinCode } };
  }
  if (body.kind !== "individual") return fail("VALIDATION_ERROR", "Register a team, or sign up on your own.");
  const existing = await em.findOne(Registration, { season, user });
  if (existing && existing.status === "waiting") return fail("ALREADY_REGISTERED", "You're already signed up; staff will place you on a team.");
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 200) || null : null;
  const reg = await upsertRegistration(em, season, user, "individual", null, "waiting");
  reg.note = note;
  await em.flush();
  return { ok: true as const, registration: { id: reg.id, status: reg.status } };
}

/** A player who signed up alone withdraws before being placed. */
export async function withdraw(em: EntityManager, user: User, seasonId: string) {
  const season = await loadSeason(em, seasonId);
  if (!season) return seasonGone();
  const reg = await em.findOne(Registration, { season, user, status: "waiting" });
  if (!reg) return fail("NOT_REGISTERED", "You're not waiting for a team in this season.");
  reg.status = "withdrawn";
  await em.flush();
  return { ok: true as const };
}

/** Staff place a free agent on a team. */
export async function placeFreeAgent(em: EntityManager, user: User, registrationId: string, body: { teamId?: unknown }) {
  const reg = isUuid(registrationId)
    ? await em.findOne(Registration, { id: registrationId }, { populate: ["user", "season", "season.league", "season.league.org"] })
    : null;
  if (!reg || reg.status !== "waiting") return fail("REGISTRATION_NOT_FOUND", "No one is waiting with that sign-up.");
  const denied = await requireOrg(em, user.id, reg.season.league.org.id, "run");
  if (denied) return denied;
  const team = typeof body.teamId === "string" ? await loadTeam(em, body.teamId) : null;
  if (!team || team.season.id !== reg.season.id) return teamGone();
  const no = (await mayJoinSeason(em, reg.season, reg.user)) ?? (await roomOn(em, team));
  if (no) return no;
  await addMember(em, team, reg.user, user);
  return { ok: true as const };
}

/** Staff or the captain add a player picked from SportsArc. */
export async function addPlayer(em: EntityManager, user: User, teamId: string, body: { userId?: unknown }) {
  const team = await loadTeam(em, teamId);
  if (!team) return teamGone();
  const role = await staffRole(em, user.id, team.season);
  if (!isStaff(role) && team.captain?.id !== user.id) return fail("NOT_TEAM_CAPTAIN", "Only the captain or league staff add players.");
  const player = typeof body.userId === "string" && isUuid(body.userId) ? await em.findOne(User, { id: body.userId }) : null;
  if (!player) return fail("USER_NOT_FOUND", "That person is not on SportsArc.");
  const no = (await mayJoinSeason(em, team.season, player)) ?? (await roomOn(em, team));
  if (no) return no;
  await addMember(em, team, player, user);
  return { ok: true as const };
}

/** What the join link shows, signed out too. */
export async function joinPreview(em: EntityManager, code: string, viewerId?: string) {
  const team = await em.findOne(Team, { joinCode: code }, { populate: ["season", "season.league", "season.league.org", "captain"] });
  if (!team) return fail("JOIN_LINK_INVALID", "That join link doesn't work. Ask the captain for a new one.");
  const view = await teamView(em, team.id, viewerId);
  if (isFailure(view)) return view;
  return { ok: true as const, team: view.team, open: rostersOpen(team.season.status), full: view.team.members.length >= team.season.rosterMax };
}

export async function joinByCode(em: EntityManager, user: User, code: string) {
  const team = typeof code === "string" && code.length <= 24
    ? await em.findOne(Team, { joinCode: code }, { populate: ["season", "season.league", "season.league.org", "captain"] })
    : null;
  if (!team) return fail("JOIN_LINK_INVALID", "That join link doesn't work. Ask the captain for a new one.");
  if (await em.count(TeamMember, { team, user })) return { ok: true as const, team: { id: team.id } };
  const no = (await mayJoinSeason(em, team.season, user)) ?? (await roomOn(em, team));
  if (no) return no;
  await addMember(em, team, user, user);
  return { ok: true as const, team: { id: team.id } };
}

/** Staff or the captain remove a player; anyone may leave their team. */
export async function removePlayer(em: EntityManager, user: User, teamId: string, playerId: string) {
  const team = await loadTeam(em, teamId);
  if (!team) return teamGone();
  if (!rostersOpen(team.season.status)) return fail("SEASON_CLOSED", "This season is over; its rosters are fixed.");
  const self = playerId === user.id;
  const role = await staffRole(em, user.id, team.season);
  if (!self && !isStaff(role) && team.captain?.id !== user.id) return fail("NOT_TEAM_CAPTAIN", "Only the captain or league staff remove players.");
  const m = isUuid(playerId) ? await em.findOne(TeamMember, { team, user: playerId }) : null;
  if (!m) return fail("NOT_ON_TEAM", "That player is not on this team.");
  em.remove(m);
  if (team.captain?.id === playerId) team.captain = null;
  const reg = await em.findOne(Registration, { season: team.season, user: playerId });
  if (reg) reg.status = "withdrawn";
  await em.flush();
  await syncSeats(em, team);
  return { ok: true as const };
}

/** Staff name a team's captain from its roster. */
export async function setCaptain(em: EntityManager, user: User, teamId: string, body: { userId?: unknown }) {
  const team = await loadTeam(em, teamId);
  if (!team) return teamGone();
  const denied = await requireOrg(em, user.id, team.season.league.org.id, "run");
  if (denied) return denied;
  const id = typeof body.userId === "string" ? body.userId : "";
  const m = isUuid(id) ? await em.findOne(TeamMember, { team, user: id }, { populate: ["user"] }) : null;
  if (!m) return fail("NOT_ON_TEAM", "The captain must be on the team.");
  team.captain = m.user;
  await em.flush();
  return { ok: true as const };
}

/**
 * Keep a team's seats in its upcoming fixtures equal to its roster: add a
 * seat for a new player, drop one for a player who left. Only fixtures
 * whose check-in has not opened and that have no result are touched, so
 * the record of a game already played never changes.
 */
async function syncSeats(em: EntityManager, team: Team) {
  const games = await em.find(Game, {
    kind: "league", status: { $in: ["open", "full"] }, $or: [{ homeTeam: team }, { awayTeam: team }],
  });
  const upcoming = games.filter((g) => checkInWindow(g) === "early");
  if (!upcoming.length) return;
  const resulted = new Set((await em.find(GameResult, { game: { $in: upcoming } })).map((r) => r.game.id));
  const roster = await em.find(TeamMember, { team }, { populate: ["user"] });
  const want = new Set(roster.map((m) => m.user.id));
  for (const g of upcoming) {
    if (resulted.has(g.id)) continue;
    const side = g.homeTeam?.id === team.id ? 0 : 1;
    const seats = await em.find(GameParticipant, { game: g });
    for (const s of seats.filter((x) => x.side === side && x.status === "joined" && !want.has(x.user.id))) {
      s.status = "cancelled";
    }
    for (const m of roster) {
      const s = seats.find((x) => x.user.id === m.user.id);
      if (s) { s.status = "joined"; s.side = side; continue; }
      const seat = new GameParticipant();
      seat.game = g;
      seat.user = m.user;
      seat.status = "joined";
      seat.side = side;
      em.persist(seat);
    }
    await em.flush();
    const joined = await em.count(GameParticipant, { game: g, status: "joined" });
    g.capacity = Math.max(2, joined);
    g.status = "full";
  }
  await em.flush();
}

// ── schedule ──────────────────────────────────────────────────────────

/**
 * Generate the season's fixtures: a round robin (one or two legs), a round
 * every `everyDays` from `firstDate`, starting at `time` local time; each
 * round at the next venue in turn, its games one after another. The season
 * moves to running. Once made, the schedule is not regenerated.
 */
export async function generateSchedule(em: EntityManager, user: User, seasonId: string, body: Record<string, unknown>) {
  const season = await loadSeason(em, seasonId);
  if (!season) return seasonGone();
  const denied = await requireOrg(em, user.id, season.league.org.id, "run");
  if (denied) return denied;
  if (season.status !== "draft" && season.status !== "open") {
    return fail("SCHEDULE_EXISTS", "This season already has its schedule.");
  }
  if (await em.count(Game, { season })) return fail("SCHEDULE_EXISTS", "This season already has its schedule.");

  const firstDate = typeof body.firstDate === "string" ? body.firstDate : "";
  const time = typeof body.time === "string" ? body.time : "";
  const everyDays = intIn(body.everyDays, 7, 1, 28);
  const duration = intIn(body.durationMinutes, 60, 20, 240);
  const legs = intIn(body.legs, 1, 1, 2);
  if (!DATE.test(firstDate) || !zonedTime(firstDate, time)) return fail("VALIDATION_ERROR", "Pick the first game day and a start time.");
  if (everyDays === null || duration === null || legs === null) return fail("VALIDATION_ERROR", "Check the schedule's settings.");
  const venueIds = Array.isArray(body.venueIds) ? body.venueIds.filter((v): v is string => typeof v === "string" && isUuid(v)) : [];
  if (venueIds.length < 1 || venueIds.length > MAX_VENUES) return fail("VALIDATION_ERROR", `Pick 1 to ${MAX_VENUES} venues.`);
  const found = await em.find(Venue, { id: { $in: venueIds } });
  const venues = venueIds.map((id) => found.find((v) => v.id === id)).filter((v): v is Venue => Boolean(v));
  if (venues.length !== venueIds.length) return fail("VENUE_NOT_FOUND", "One of those venues does not exist.");

  const teams = await em.find(Team, { season }, { orderBy: { name: "ASC" } });
  if (teams.length < 2) return fail("NOT_ENOUGH_TEAMS", "A schedule needs at least two teams.");
  const rosters = new Map<string, TeamMember[]>();
  for (const t of teams) rosters.set(t.id, await em.find(TeamMember, { team: t }, { populate: ["user"] }));
  const short = teams.filter((t) => (rosters.get(t.id)?.length ?? 0) < season.rosterMin);
  if (short.length) {
    return fail("ROSTER_SHORT", `${short.map((t) => t.name).join(", ")} need${short.length === 1 ? "s" : ""} at least ${season.rosterMin} players first.`);
  }

  const rounds = schedule(teams, legs);
  const lastDay = addDays(firstDate, (rounds.length - 1) * everyDays);
  if (lastDay > season.endsOn) {
    return fail("SCHEDULE_TOO_LONG", `${rounds.length} rounds every ${everyDays} days run to ${lastDay}, past the season's end (${season.endsOn}).`);
  }
  if (zonedTime(firstDate, time)!.getTime() < Date.now()) return fail("VALIDATION_ERROR", "The first game is in the past.");

  let made = 0;
  rounds.forEach((pairs, r) => {
    const day = addDays(firstDate, r * everyDays);
    const venue = venues[r % venues.length];
    pairs.forEach(([home, away], j) => {
      const g = new Game();
      g.host = user;
      g.hostPlays = false;
      g.venue = venue;
      g.sport = season.league.sport as Game["sport"];
      g.kind = "league";
      g.startsAt = new Date(zonedTime(day, time)!.getTime() + j * duration * 60_000);
      g.durationMinutes = duration;
      g.skillLevel = "any";
      g.visibility = "public";
      g.notes = `${season.league.name} · ${season.name} · Round ${r + 1}`.slice(0, 500);
      g.season = season;
      g.homeTeam = home;
      g.awayTeam = away;
      let seats = 0;
      for (const [team, side] of [[home, 0], [away, 1]] as const) {
        for (const m of rosters.get(team.id) ?? []) {
          const seat = new GameParticipant();
          seat.game = g;
          seat.user = m.user;
          seat.status = "joined";
          seat.side = side;
          em.persist(seat);
          seats += 1;
        }
      }
      g.capacity = Math.max(2, seats);
      g.status = "full";
      em.persist(g);
      made += 1;
    });
  });
  season.status = "running";
  await em.flush();
  return { ok: true as const, fixtures: made, rounds: rounds.length, lastDay };
}

// ── finals ────────────────────────────────────────────────────────────

/**
 * Link the season's finals: a paid event (kind "event") a member of the
 * league's staff hosts, still ahead. null unlinks it. The event keeps its
 * own entries, result and prize; the season page shows it and its
 * sponsor may fund the prize (web3/events startPrize).
 */
export async function setFinals(em: EntityManager, user: User, seasonId: string, body: { gameId?: unknown }) {
  const season = await loadSeason(em, seasonId);
  if (!season) return seasonGone();
  const denied = await requireOrg(em, user.id, season.league.org.id, "run");
  if (denied) return denied;
  if (body.gameId === null) {
    if (season.finals) {
      const old = await em.findOne(Game, { id: season.finals.id });
      if (old && old.kind === "event") old.season = null;
    }
    season.finals = null;
    await em.flush();
    return { ok: true as const };
  }
  const game = typeof body.gameId === "string" && isUuid(body.gameId)
    ? await em.findOne(Game, { id: body.gameId }, { populate: ["host"] })
    : null;
  if (!game) return fail("GAME_NOT_FOUND", "That game does not exist.");
  if (game.kind !== "event") return fail("NOT_EVENT", "The finals is a paid event: host one (it can be free to enter), then link it.");
  if (game.status === "cancelled" || game.startsAt.getTime() < Date.now()) return fail("GAME_CLOSED", "Pick an event that is still ahead.");
  if (!isStaff(await staffRole(em, game.host.id, season))) return fail("NOT_ORG_STAFF", "The finals must be hosted by the league's staff.");
  season.finals = game;
  game.season = season;
  await em.flush();
  return { ok: true as const };
}

/**
 * Seasons by name, league or org: not over (a sponsor backing one), or
 * with `finished` the finished ones too (a club inviting from standings).
 * Public.
 */
export async function searchSeasons(em: EntityManager, q: string, { finished = false } = {}) {
  const term = q.trim().slice(0, 60);
  const like = `%${term.replace(/[%_\\]/g, "")}%`;
  const rows = await em.find(
    Season,
    {
      status: { $in: finished ? ["running", "final"] : ["draft", "open", "running"] },
      ...(term ? { $or: [{ name: { $ilike: like } }, { league: { name: { $ilike: like } } }, { league: { org: { name: { $ilike: like } } } }] } : {}),
    },
    { populate: ["league", "league.org"], orderBy: { startsOn: "DESC" }, limit: 12 },
  );
  return rows.map((x) => ({
    id: x.id, name: x.name, status: x.status, league: x.league.name,
    org: { slug: x.league.org.slug, name: x.league.org.name, verified: Boolean(x.league.org.verifiedAt) },
  }));
}

// ── reading ───────────────────────────────────────────────────────────

export interface FixtureView {
  gameId: string;
  startsAt: string;
  status: string;
  venue: { id: string; name: string };
  home: { id: string; name: string } | null;
  away: { id: string; name: string } | null;
  result: { outcome: string | null; winningSide: number | null; score0: number | null; score1: number | null; final: boolean } | null;
}

async function fixturesOf(em: EntityManager, where: Record<string, unknown>): Promise<{ list: FixtureView[]; outcomes: FixtureOutcome[] }> {
  const games = await em.find(Game, { kind: "league", ...where }, { populate: ["venue", "homeTeam", "awayTeam"], orderBy: { startsAt: "ASC" } });
  const results = games.length ? await em.find(GameResult, { game: { $in: games } }) : [];
  const byGame = new Map(results.map((r) => [r.game.id, r]));
  const list: FixtureView[] = [];
  const outcomes: FixtureOutcome[] = [];
  for (const g of games) {
    const r = byGame.get(g.id);
    const settled = r?.status === "settled";
    list.push({
      gameId: g.id,
      startsAt: g.startsAt.toISOString(),
      status: g.status,
      venue: { id: g.venue.id, name: g.venue.name },
      home: g.homeTeam ? { id: g.homeTeam.id, name: g.homeTeam.name } : null,
      away: g.awayTeam ? { id: g.awayTeam.id, name: g.awayTeam.name } : null,
      result: settled ? {
        outcome: r!.outcome ?? null, winningSide: r!.winningSide ?? null, score0: r!.score0 ?? null, score1: r!.score1 ?? null,
        final: !canRecord(r!.status, r!.firstRecordedAt),
      } : null,
    });
    if (settled && g.homeTeam && g.awayTeam && g.status !== "cancelled") {
      outcomes.push({
        home: g.homeTeam.id, away: g.awayTeam.id, outcome: (r!.outcome ?? null) as FixtureOutcome["outcome"],
        winningSide: r!.winningSide ?? null, score0: r!.score0 ?? null, score1: r!.score1 ?? null,
      });
    }
  }
  return { list, outcomes };
}

interface TeamBrief {
  id: string;
  name: string;
  captainId: string | null;
  members: OrgPerson[];
  /** Only for the org's staff and the team's captain. */
  joinCode: string | null;
}

export async function seasonView(em: EntityManager, seasonId: string, viewerId?: string) {
  const season = await loadSeason(em, seasonId);
  if (!season) return seasonGone();
  const role = await staffRole(em, viewerId, season);
  const staff = isStaff(role);
  const teams = await em.find(Team, { season }, { populate: ["captain"], orderBy: { name: "ASC" } });
  const members = teams.length ? await em.find(TeamMember, { team: { $in: teams } }, { populate: ["user"], orderBy: { createdAt: "ASC" } }) : [];
  const briefs: TeamBrief[] = teams.map((t) => ({
    id: t.id,
    name: t.name,
    captainId: t.captain?.id ?? null,
    members: members.filter((m) => m.team.id === t.id).map((m) => personOf(m.user)),
    joinCode: staff || (viewerId && t.captain?.id === viewerId) ? t.joinCode : null,
  }));
  const { list, outcomes } = await fixturesOf(em, { season });
  const table: StandingRow[] = standings(teams.map((t) => t.id), outcomes);
  const reg = viewerId ? await em.findOne(Registration, { season, user: viewerId }) : null;
  const waiting = staff
    ? await em.find(Registration, { season, kind: "individual", status: "waiting" }, { populate: ["user"], orderBy: { createdAt: "ASC" } })
    : [];
  const org = season.league.org;
  const viewer = viewerId ? await em.findOne(User, { id: viewerId }) : null;
  const finalsGame = season.finals ? await em.findOne(Game, { id: season.finals.id }, { populate: ["venue"] }) : null;
  const finals = finalsGame ? {
    gameId: finalsGame.id,
    startsAt: finalsGame.startsAt.toISOString(),
    status: finalsGame.status,
    venue: { id: finalsGame.venue.id, name: finalsGame.venue.name },
    prize: await prizeSummary(em, finalsGame),
    /** The sponsor org the viewer may fund the finals prize for. */
    sponsorAs: viewer ? await sponsorFor(em, viewer, finalsGame).then((o) => (o ? { name: o.name, slug: o.slug } : null)) : null,
  } : null;
  return {
    ok: true as const,
    season: {
      id: season.id, name: season.name, status: season.status, startsOn: season.startsOn, endsOn: season.endsOn,
      sponsors: await seasonSponsors(em, season, staff),
      finals,
      rosterMin: season.rosterMin, rosterMax: season.rosterMax, teamsMax: season.teamsMax ?? null,
      league: { id: season.league.id, name: season.league.name, sport: season.league.sport, format: season.league.format ?? null },
      org: { id: org.id, slug: org.slug, name: org.name, verified: Boolean(org.verifiedAt) },
      teams: briefs,
      fixtures: list,
      standings: table.map((r) => ({ ...r, name: teams.find((t) => t.id === r.team)?.name ?? "" })),
      freeAgents: staff ? waiting.map((r) => ({ id: r.id, person: personOf(r.user), note: r.note ?? null, since: r.createdAt.toISOString() })) : null,
      viewer: {
        orgRole: role,
        staff,
        teamId: briefs.find((t) => viewerId && t.members.some((m) => m.id === viewerId))?.id ?? null,
        registration: reg ? { kind: reg.kind, status: reg.status } : null,
      },
    },
  };
}

export async function teamView(em: EntityManager, teamId: string, viewerId?: string) {
  const team = await loadTeam(em, teamId);
  if (!team) return teamGone();
  const role = await staffRole(em, viewerId, team.season);
  const members = await em.find(TeamMember, { team }, { populate: ["user"], orderBy: { createdAt: "ASC" } });
  const { list } = await fixturesOf(em, { $or: [{ homeTeam: team }, { awayTeam: team }] });
  const seasonTeams = await em.find(Team, { season: team.season }, { orderBy: { name: "ASC" } });
  const { outcomes } = await fixturesOf(em, { season: team.season });
  const row = standings(seasonTeams.map((t) => t.id), outcomes).find((r) => r.team === team.id) ?? null;
  const captain = viewerId !== undefined && team.captain?.id === viewerId;
  const org = team.season.league.org;
  return {
    ok: true as const,
    team: {
      id: team.id,
      name: team.name,
      captainId: team.captain?.id ?? null,
      members: members.map((m) => personOf(m.user)),
      joinCode: isStaff(role) || captain ? team.joinCode : null,
      standing: row,
      fixtures: list,
      season: { id: team.season.id, name: team.season.name, status: team.season.status, rosterMax: team.season.rosterMax },
      league: { id: team.season.league.id, name: team.season.league.name, sport: team.season.league.sport },
      org: { slug: org.slug, name: org.name },
      viewer: { staff: isStaff(role), captain, member: members.some((m) => m.user.id === viewerId) },
    },
  };
}

/** The signed-in player's teams, newest season first. */
export async function myTeams(em: EntityManager, user: User) {
  const rows = await em.find(TeamMember, { user }, { populate: ["team", "team.season", "team.season.league", "team.season.league.org"] });
  rows.sort((a, b) => b.team.season.startsOn.localeCompare(a.team.season.startsOn));
  return rows.map((m) => ({
    team: { id: m.team.id, name: m.team.name },
    season: { id: m.team.season.id, name: m.team.season.name, status: m.team.season.status },
    league: { name: m.team.season.league.name },
    org: { slug: m.team.season.league.org.slug, name: m.team.season.league.org.name },
  }));
}

