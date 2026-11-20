/**
 * Paid events: entry fees that pay the host, a prize the host puts up that
 * pays the winners, and nobody but the platform paying gas.
 *
 * Routes for the `events` workstream. All need a session. Every step a
 * person takes is two calls: the first answers with a Circle challenge for
 * the browser to sign with the PIN, the second (…/confirm) takes the
 * signature it got back ({ signature }) and has the relayer send the call.
 * A confirm with no signature only reports how a call already sent ended.
 * Handlers live in events.ts.
 *
 *   GET  /api/web3/events/games/:id                   terms, fee, prize, result, my entry, what I can do
 *   GET  /api/web3/events/terms?ids=a,b,c             which of these games are events, what they cost, mine
 *
 *   host
 *   POST /api/web3/events/games/:id/terms             { entryFee?, minPlayers?, minAttendees?, prize? } -> challenge
 *   POST /api/web3/events/games/:id/result            { placements: [userId, …] } (none: "it ran") -> challenge
 *   POST /api/web3/events/games/:id/cancel            -> challenge (an event not yet open is cancelled at once)
 *   POST /api/web3/events/games/:id/confirm           { signature? } for whichever of the three is waiting
 *
 *   player
 *   POST /api/web3/events/games/:id/register          { payout? } -> challenge. payout: "wallet" (default),
 *                                                     { destinationId } or { chain, address } to be paid on another chain
 *   POST /api/web3/events/games/:id/register/confirm  { signature? }
 *   POST /api/web3/events/games/:id/leave             -> challenge (while registration is open; the fee comes back)
 *   POST /api/web3/events/games/:id/leave/confirm     { signature? }
 *
 *   host: the prize
 *   POST /api/web3/events/games/:id/prize             { amount: "200" } -> challenge
 *   POST /api/web3/events/prizes/:id/confirm          { signature? }
 */

import type { Game } from "../../entities/Game.js";
import { findGame } from "../../games/lifecycle.js";
import { json, parseJsonBody, requireUser, statusFor, type Auth, type ErrorResponse } from "../../http.js";
import { get, post, type RouteContext } from "../../router.js";
import { isUuid } from "../../validate.js";
import { resolveChoice } from "../gateway/destinations.js";
import {
  EVENT_STATUS, cancelEvent, confirmAction, confirmEntry, confirmLeave, confirmPrize, eventActivity, eventStatus,
  postEventResult, setEventTerms, startEntry, startLeave, startPrize, termsForGames,
} from "./events.js";

type Body = Record<string, unknown>;
type Outcome = { ok: boolean; error?: { code: string } };

function reply(ctx: RouteContext, result: Outcome): void {
  json(ctx.res, statusFor(result, EVENT_STATUS), result);
}

/** Signed-in user and the game at :id, or null after answering 401/404. */
async function load(ctx: RouteContext): Promise<(Auth & { game: Game }) | null> {
  const auth = await requireUser(ctx);
  if (!auth) return null;
  const id = ctx.params.id ?? "";
  const game: Game | null = isUuid(id) ? await findGame(auth.fork, id) : null;
  if (!game) {
    json(ctx.res, 404, {
      ok: false,
      error: { code: "GAME_NOT_FOUND", message: "That game does not exist." },
    } satisfies ErrorResponse);
    return null;
  }
  return { ...auth, game };
}

/** A POST on one game: session, game, JSON body, then the handler's result. */
function gamePost(act: (hit: Auth & { game: Game }, body: Body) => Promise<Outcome>) {
  return async (ctx: RouteContext) => {
    const hit = await load(ctx);
    if (!hit) return;
    const body = await parseJsonBody<Body>(ctx.req, ctx.res);
    if (!body) return;
    reply(ctx, await act(hit, body));
  };
}

get("/api/web3/events/games/:id", async (ctx) => {
  const hit = await load(ctx);
  if (!hit) return;
  reply(ctx, await eventStatus(hit.fork, hit.game, hit.user));
});

const MAX_IDS = 50;

get("/api/web3/events/activity", async (ctx) => {
  const auth = await requireUser(ctx);
  if (!auth) return;
  reply(ctx, await eventActivity(auth.fork, auth.user));
});

get("/api/web3/events/terms", async (ctx) => {
  const auth = await requireUser(ctx);
  if (!auth) return;
  const ids = (ctx.query.get("ids") ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(isUuid);
  reply(ctx, await termsForGames(auth.fork, [...new Set(ids)].slice(0, MAX_IDS), auth.user));
});

// ── host ──────────────────────────────────────────────────────────────

post("/api/web3/events/games/:id/terms", gamePost(({ fork, user, game }, body) => setEventTerms(fork, user, game, body)));
post("/api/web3/events/games/:id/result", gamePost(({ fork, user, game }, body) => postEventResult(fork, user, game, body)));
post("/api/web3/events/games/:id/cancel", gamePost(({ fork, user, game }) => cancelEvent(fork, user, game)));
post("/api/web3/events/games/:id/confirm", gamePost(({ fork, user, game }, body) => confirmAction(fork, user, game, body)));

// ── player ────────────────────────────────────────────────────────────

post("/api/web3/events/games/:id/register", gamePost(async ({ fork, user, game }, body) => {
  const choice = await resolveChoice(fork, user, body.payout);
  if (!choice.ok) return choice;
  return startEntry(fork, user, game, choice.choice);
}));
post("/api/web3/events/games/:id/register/confirm", gamePost(({ fork, user, game }, body) => confirmEntry(fork, user, game, body)));
post("/api/web3/events/games/:id/leave", gamePost(({ fork, user, game }) => startLeave(fork, user, game)));
post("/api/web3/events/games/:id/leave/confirm", gamePost(({ fork, user, game }, body) => confirmLeave(fork, user, game, body)));

// ── host: the prize ───────────────────────────────────────────────────

post("/api/web3/events/games/:id/prize", gamePost(({ fork, user, game }, body) => startPrize(fork, user, game, body)));

post("/api/web3/events/prizes/:id/confirm", async (ctx) => {
  const auth = await requireUser(ctx);
  if (!auth) return;
  const body = await parseJsonBody<Body>(ctx.req, ctx.res);
  if (!body) return;
  reply(ctx, await confirmPrize(auth.fork, auth.user, ctx.params.id ?? "", body));
});
