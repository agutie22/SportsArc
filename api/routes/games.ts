/**
 * Games and everything done to one: join, leave, check in, cancel, the host's
 * actions and the result flow.
 */

import { em } from "../db.js";
import type { Game } from "../entities/Game.js";
import type { User } from "../entities/User.js";
import { checkInToGame } from "../games/checkin.js";
import { editGame, removePlayer, setCohost } from "../games/hosting.js";
import { cancelGame, createGame, findGame, joinGame, leaveGame } from "../games/lifecycle.js";
import { listGames, listHostAgain, listMyGames, listOpenResults, toPublicGame } from "../games/views.js";
import { authed, errorJson, json, parseJsonBody, type Auth } from "../http.js";
import { getResult, recordResult, setSide, startGame } from "../games/results.js";
import { confirmRoster } from "../games/roster.js";
import { get, patch, post, type RouteContext } from "../router.js";
import { readSession } from "../auth/session.js";
import { gameReliability } from "../social/reliability.js";
import { gameRoster } from "../social/discovery.js";
import { gameStatus } from "./status.js";

type Fork = ReturnType<typeof em>;
type Body = Record<string, unknown>;
type Outcome = { ok: boolean; error?: { code: string } };

/** Resolve :id, or answer 404 and return null. */
async function gameOr404(fork: Fork, ctx: RouteContext) {
  const game = await findGame(fork, ctx.params.id);
  if (!game) errorJson(ctx.res, 404, "GAME_NOT_FOUND", "That game does not exist.");
  return game;
}

/**
 * Shared body of an action on one game: auth, body (unless `noBody`), load,
 * act, then `answer` with the fresh state. A failed action answers its error.
 */
function gameAction<R extends Outcome>(
  act: (fork: Fork, game: Game, user: User, body: Body) => Promise<R>,
  answer: (ctx: RouteContext, auth: Auth, game: Game, result: R) => Promise<void>,
  { noBody = false } = {},
) {
  return authed(async (ctx, auth) => {
    const body = noBody ? {} : await parseJsonBody<Body>(ctx.req, ctx.res);
    if (body === null) return;
    const game = await gameOr404(auth.fork, ctx);
    if (!game) return;
    const result = await act(auth.fork, game, auth.user, body);
    if (!result.ok) {
      json(ctx.res, gameStatus(result), result);
      return;
    }
    await answer(ctx, auth, game, result);
  });
}

/** Answers with whatever the action returned, plus the game as the viewer sees it. */
async function withGame<R extends Outcome>(ctx: RouteContext, { user, fork }: Auth, game: Game, result: R) {
  json(ctx.res, 200, { ...result, game: await toPublicGame(fork, game, user.id) });
}

/** Answers with the result as the viewer sees it. */
async function withResult(ctx: RouteContext, { user, fork }: Auth, game: Game) {
  json(ctx.res, 200, { ok: true, result: await getResult(fork, game, user.id) });
}

// ── games ─────────────────────────────────────────────────────────────

get("/api/games", async ({ req, res, query }) => {
  const session = readSession(req);
  const games = await listGames(
    em(),
    {
      lat: query.get("lat") ?? undefined,
      lng: query.get("lng") ?? undefined,
      radiusKm: query.get("radiusKm") ?? undefined,
      sport: query.get("sport") ?? undefined,
      skillLevel: query.get("skillLevel") ?? undefined,
      venueId: query.get("venueId") ?? undefined,
      limit: query.get("limit") ?? undefined,
    },
    session?.userId,
  );
  json(res, 200, { ok: true, games });
});

post("/api/games", authed(async ({ req, res }, { user, fork }) => {
  const body = await parseJsonBody<Body>(req, res);
  if (body === null) return;
  const result = await createGame(fork, user, body);
  if (!result.ok) {
    json(res, gameStatus(result), result);
    return;
  }
  json(res, 201, { ok: true, game: await toPublicGame(fork, result.game, user.id) });
}));

get("/api/games/:id", async (ctx) => {
  const session = readSession(ctx.req);
  const fork = em();
  const game = await gameOr404(fork, ctx);
  if (!game) return;
  json(ctx.res, 200, { ok: true, game: await toPublicGame(fork, game, session?.userId) });
});

post("/api/games/:id/join", gameAction((fork, game, user) => joinGame(fork, game, user), withGame, { noBody: true }));
post("/api/games/:id/leave", gameAction((fork, game, user) => leaveGame(fork, game, user), withGame, { noBody: true }));
post("/api/games/:id/cancel", gameAction((fork, game, user) => cancelGame(fork, game, user), withGame, { noBody: true }));
post("/api/games/:id/checkin", gameAction((fork, game, user, body) => checkInToGame(fork, game, user, body), withGame));

// ── host powers ───────────────────────────────────────────

patch("/api/games/:id", gameAction((fork, game, user, body) => editGame(fork, game, user, body), withGame));
post("/api/games/:id/remove", gameAction((fork, game, user, body) => removePlayer(fork, game, user, body), withGame));
post("/api/games/:id/cohosts", gameAction((fork, game, user, body) => setCohost(fork, game, user, body), withGame));

// How often each joined player shows up, beside their name in the Manage sheet.
get("/api/games/:id/reliability", authed(async (ctx, { fork }) => {
  const game = await gameOr404(fork, ctx);
  if (!game) return;
  json(ctx.res, 200, { ok: true, players: await gameReliability(fork, game) });
}));

// Who is playing, as someone deciding whether to join sees it (the game sheet).
get("/api/games/:id/roster", authed(async (ctx, { user, fork }) => {
  const game = await gameOr404(fork, ctx);
  if (!game) return;
  json(ctx.res, 200, { ok: true, players: await gameRoster(fork, game, user) });
}));

// ── results ──────────────────────────────────────

get("/api/games/:id/result", async (ctx) => {
  const session = readSession(ctx.req);
  const fork = em();
  const game = await gameOr404(fork, ctx);
  if (!game) return;
  json(ctx.res, 200, { ok: true, result: await getResult(fork, game, session?.userId) });
});

post("/api/games/:id/side", gameAction((fork, game, user, body) => setSide(fork, game, user, body), withResult));
post("/api/games/:id/start", gameAction((fork, game, user) => startGame(fork, game, user), withResult));
post("/api/games/:id/result", gameAction((fork, game, user, body) => recordResult(fork, game, user, body), withResult));
// The host confirms who was there, after check-in closes (games/roster.ts).
post("/api/games/:id/roster", gameAction((fork, game, user, body) => confirmRoster(fork, game, user, body), withResult));

// ── mine ──────────────────────────────────────────────────────────────

// Deliberately /api/my/... rather than /api/games/mine: a literal segment
// under /api/games/:id would depend on registration order to win the match.
get("/api/my/games", authed(async ({ res, query }, { user, fork }) => {
  json(res, 200, { ok: true, games: await listMyGames(fork, user, query.get("limit") ?? undefined) });
}));

// What the viewer hosted recently, for "Host again" on the host form.
get("/api/my/hosted", authed(async ({ res }, { user, fork }) => {
  json(res, 200, { ok: true, games: await listHostAgain(fork, user) });
}));

// Games where the viewer can still record the result.
get("/api/my/results/open", authed(async ({ res }, { user, fork }) => {
  json(res, 200, { ok: true, games: await listOpenResults(fork, user) });
}));
