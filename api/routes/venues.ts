/**
 * Venues: list and create, and the regulars ladder at one venue.
 */

import { em } from "../db.js";
import { venueRegulars } from "../social/discovery.js";
import { authed, errorJson, json, parseJsonBody, viewerOf } from "../http.js";
import { get, post } from "../router.js";
import { buildVenue, listVenues, toPublicVenue } from "../games/venues.js";
import { gameStatus } from "./status.js";

get("/api/venues", async ({ res, query }) => {
  const venues = await listVenues(em(), {
    lat: query.get("lat") ?? undefined,
    lng: query.get("lng") ?? undefined,
    radiusKm: query.get("radiusKm") ?? undefined,
    q: query.get("q") ?? undefined,
  });
  json(res, 200, { ok: true, venues });
});

post("/api/venues", authed(async ({ req, res }, { user, fork }) => {
  const body = await parseJsonBody<Record<string, unknown>>(req, res);
  if (body === null) return;
  const built = buildVenue(body, user);
  if ("ok" in built) {
    json(res, gameStatus(built), built);
    return;
  }
  await fork.persistAndFlush(built);
  json(res, 201, { ok: true, venue: toPublicVenue(built) });
}));

get("/api/venues/:id/regulars", async (ctx) => {
  const fork = em();
  const board = await venueRegulars(fork, ctx.params.id, await viewerOf(ctx, fork));
  if (!board) {
    errorJson(ctx.res, 404, "VENUE_NOT_FOUND", "That venue does not exist.");
    return;
  }
  json(ctx.res, 200, { ok: true, ...board });
});
