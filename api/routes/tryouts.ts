/**
 * Tryouts (api/tryouts/): a club's tryout page (public), creating one,
 * invites, the player's consent, the scout board and camp invites.
 */

import { em } from "../db.js";
import { authed, json, parseJsonBody, viewerOf } from "../http.js";
import { get, post } from "../router.js";
import {
  createTryout, giveConsent, inviteFromSeason, invitePlayer, orgTryouts, scoutBoard, setCamp, tryoutView,
} from "../tryouts/tryouts.js";
import { leagueStatus } from "./status.js";

type Body = Record<string, unknown>;

get("/api/orgs/:id/tryouts", async ({ res, params }) => {
  const result = await orgTryouts(em(), params.id);
  json(res, leagueStatus(result), result);
});

post("/api/orgs/:id/tryouts", authed(async ({ req, res, params }, { user, fork }) => {
  const body = await parseJsonBody<Body>(req, res);
  if (body === null) return;
  const result = await createTryout(fork, user, params.id, body);
  json(res, result.ok ? 201 : leagueStatus(result), result);
}));

get("/api/tryouts/:id", async (ctx) => {
  const fork = em();
  const viewer = await viewerOf(ctx, fork);
  const result = await tryoutView(fork, ctx.params.id, viewer);
  json(ctx.res, leagueStatus(result), result);
});

post("/api/tryouts/:id/invite-season", authed(async ({ req, res, params }, { user, fork }) => {
  const body = await parseJsonBody<Body>(req, res);
  if (body === null) return;
  const result = await inviteFromSeason(fork, user, params.id, body);
  json(res, leagueStatus(result), result);
}));

post("/api/tryouts/:id/invite", authed(async ({ req, res, params }, { user, fork }) => {
  const body = await parseJsonBody<Body>(req, res);
  if (body === null) return;
  const result = await invitePlayer(fork, user, params.id, body);
  json(res, leagueStatus(result), result);
}));

post("/api/tryouts/:id/consent", authed(async ({ res, params }, { user, fork }) => {
  const result = await giveConsent(fork, user, params.id);
  json(res, leagueStatus(result), result);
}));

get("/api/tryouts/:id/board", authed(async ({ res, params }, { user, fork }) => {
  const result = await scoutBoard(fork, user, params.id);
  json(res, leagueStatus(result), result);
}));

post("/api/tryouts/:id/camp", authed(async ({ req, res, params }, { user, fork }) => {
  const body = await parseJsonBody<Body>(req, res);
  if (body === null) return;
  const result = await setCamp(fork, user, params.id, body);
  json(res, leagueStatus(result), result);
}));
