/**
 * Leagues: an org's leagues, seasons, teams, sign-ups, join links and the
 * schedule (api/leagues/). Reads are public; league play is adults only,
 * so they may name players.
 */

import { em } from "../db.js";
import { authed, json, parseJsonBody, viewerOf } from "../http.js";
import { del, get, patch, post } from "../router.js";
import {
  addPlayer, addTeam, createLeague, createSeason, generateSchedule, joinByCode, joinPreview, myTeams, orgLeagues,
  placeFreeAgent, register, removePlayer, searchSeasons, seasonView, setCaptain, setFinals, setSeasonStatus, teamView, withdraw,
} from "../leagues/leagues.js";
import { answerSeasonSponsor, endSponsorship, orgSponsorships, proposeSeason, sponsorVenue } from "../orgs/sponsors.js";
import { leagueStatus } from "./status.js";

type Body = Record<string, unknown>;

get("/api/orgs/:id/leagues", async ({ res, params }) => {
  const result = await orgLeagues(em(), params.id);
  json(res, leagueStatus(result), result);
});

post("/api/orgs/:id/leagues", authed(async ({ req, res, params }, { user, fork }) => {
  const body = await parseJsonBody<Body>(req, res);
  if (body === null) return;
  const result = await createLeague(fork, user, params.id, body);
  json(res, result.ok ? 201 : leagueStatus(result), result);
}));

post("/api/leagues/:id/seasons", authed(async ({ req, res, params }, { user, fork }) => {
  const body = await parseJsonBody<Body>(req, res);
  if (body === null) return;
  const result = await createSeason(fork, user, params.id, body);
  json(res, result.ok ? 201 : leagueStatus(result), result);
}));

get("/api/seasons/:id", async (ctx) => {
  const fork = em();
  const viewer = await viewerOf(ctx, fork);
  const result = await seasonView(fork, ctx.params.id, viewer?.id);
  json(ctx.res, leagueStatus(result), result);
});

patch("/api/seasons/:id", authed(async ({ req, res, params }, { user, fork }) => {
  const body = await parseJsonBody<Body>(req, res);
  if (body === null) return;
  const result = await setSeasonStatus(fork, user, params.id, body);
  json(res, leagueStatus(result), result);
}));

post("/api/seasons/:id/teams", authed(async ({ req, res, params }, { user, fork }) => {
  const body = await parseJsonBody<Body>(req, res);
  if (body === null) return;
  const result = await addTeam(fork, user, params.id, body);
  json(res, result.ok ? 201 : leagueStatus(result), result);
}));

post("/api/seasons/:id/register", authed(async ({ req, res, params }, { user, fork }) => {
  const body = await parseJsonBody<Body>(req, res);
  if (body === null) return;
  const result = await register(fork, user, params.id, body);
  json(res, result.ok ? 201 : leagueStatus(result), result);
}));

del("/api/seasons/:id/register", authed(async ({ res, params }, { user, fork }) => {
  const result = await withdraw(fork, user, params.id);
  json(res, leagueStatus(result), result);
}));

post("/api/seasons/:id/schedule", authed(async ({ req, res, params }, { user, fork }) => {
  const body = await parseJsonBody<Body>(req, res);
  if (body === null) return;
  const result = await generateSchedule(fork, user, params.id, body);
  json(res, result.ok ? 201 : leagueStatus(result), result);
}));

post("/api/registrations/:id/place", authed(async ({ req, res, params }, { user, fork }) => {
  const body = await parseJsonBody<Body>(req, res);
  if (body === null) return;
  const result = await placeFreeAgent(fork, user, params.id, body);
  json(res, leagueStatus(result), result);
}));

get("/api/teams/:id", async (ctx) => {
  const fork = em();
  const viewer = await viewerOf(ctx, fork);
  const result = await teamView(fork, ctx.params.id, viewer?.id);
  json(ctx.res, leagueStatus(result), result);
});

post("/api/teams/:id/members", authed(async ({ req, res, params }, { user, fork }) => {
  const body = await parseJsonBody<Body>(req, res);
  if (body === null) return;
  const result = await addPlayer(fork, user, params.id, body);
  json(res, result.ok ? 201 : leagueStatus(result), result);
}));

del("/api/teams/:id/members/:userId", authed(async ({ res, params }, { user, fork }) => {
  const result = await removePlayer(fork, user, params.id, params.userId);
  json(res, leagueStatus(result), result);
}));

post("/api/teams/:id/captain", authed(async ({ req, res, params }, { user, fork }) => {
  const body = await parseJsonBody<Body>(req, res);
  if (body === null) return;
  const result = await setCaptain(fork, user, params.id, body);
  json(res, leagueStatus(result), result);
}));

get("/api/teams/join/:code", async (ctx) => {
  const fork = em();
  const viewer = await viewerOf(ctx, fork);
  const result = await joinPreview(fork, ctx.params.code, viewer?.id);
  json(ctx.res, leagueStatus(result), result);
});

post("/api/teams/join/:code", authed(async ({ res, params }, { user, fork }) => {
  const result = await joinByCode(fork, user, params.code);
  json(res, leagueStatus(result), result);
}));

get("/api/my/teams", authed(async ({ res }, { user, fork }) => {
  json(res, 200, { ok: true, teams: await myTeams(fork, user) });
}));

get("/api/seasons", async ({ res, query }) => {
  json(res, 200, { ok: true, seasons: await searchSeasons(em(), query.get("q") ?? "", { finished: query.get("finished") === "1" }) });
});

post("/api/seasons/:id/finals", authed(async ({ req, res, params }, { user, fork }) => {
  const body = await parseJsonBody<Body>(req, res);
  if (body === null) return;
  const result = await setFinals(fork, user, params.id, body);
  json(res, leagueStatus(result), result);
}));

// ── sponsorships (api/orgs/sponsors.ts) ───────────────────────────────

get("/api/orgs/:id/sponsorships", async (ctx) => {
  const fork = em();
  const viewer = await viewerOf(ctx, fork);
  const result = await orgSponsorships(fork, ctx.params.id, viewer?.id);
  json(ctx.res, leagueStatus(result), result);
});

post("/api/orgs/:id/sponsorships", authed(async ({ req, res, params }, { user, fork }) => {
  const body = await parseJsonBody<Body>(req, res);
  if (body === null) return;
  const result = body.kind === "season" ? await proposeSeason(fork, user, params.id, body) : await sponsorVenue(fork, user, params.id, body);
  json(res, result.ok ? 201 : leagueStatus(result), result);
}));

post("/api/sponsorships/:id/accept", authed(async ({ res, params }, { user, fork }) => {
  const result = await answerSeasonSponsor(fork, user, params.id, true);
  json(res, leagueStatus(result), result);
}));

post("/api/sponsorships/:id/decline", authed(async ({ res, params }, { user, fork }) => {
  const result = await answerSeasonSponsor(fork, user, params.id, false);
  json(res, leagueStatus(result), result);
}));

del("/api/sponsorships/:id", authed(async ({ res, params }, { user, fork }) => {
  const result = await endSponsorship(fork, user, params.id);
  json(res, leagueStatus(result), result);
}));
