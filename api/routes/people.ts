/**
 * Profiles and people: search, suggestions, follows, a person's games,
 * records and venues, and who viewed your profile.
 */

import { em } from "../db.js";
import { playedWith, profileViewSummary, recordProfileView, userVenueRanks } from "../social/discovery.js";
import { User } from "../entities/User.js";
import { authed, errorJson, json, parseJsonBody, viewerOf } from "../http.js";
import { get, patch, post } from "../router.js";
import { readSession } from "../auth/session.js";
import {
  applyProfileDetails,
  followUser,
  listUserGames,
  listUserPosts,
  listUserRecords,
  searchPeople,
  suggestedPeople,
  toPublicProfile,
  unfollowUser,
} from "../social/social.js";
import { gameStatus } from "./status.js";

get("/api/people", async ({ req, res, query }) => {
  const session = readSession(req);
  const people = await searchPeople(
    em(),
    {
      q: query.get("q") ?? undefined,
      role: query.get("role") ?? undefined,
      sport: query.get("sport") ?? undefined,
      limit: query.get("limit") ?? undefined,
    },
    session?.userId,
  );
  json(res, 200, { ok: true, people });
});

get("/api/users/:id", async (ctx) => {
  const session = readSession(ctx.req);
  const fork = em();
  const user = await fork.findOne(User, { id: ctx.params.id });
  if (!user) {
    errorJson(ctx.res, 404, "USER_NOT_FOUND", "That person does not exist.");
    return;
  }
  // The viewer is whoever is signed in, not the profile's owner: it decides
  // isAuthor and likedByViewer on each post.
  const viewer = await viewerOf(ctx, fork);
  if (viewer) await recordProfileView(fork, viewer, user.id);
  json(ctx.res, 200, {
    ok: true,
    profile: await toPublicProfile(fork, user, session?.userId),
    posts: await listUserPosts(fork, user.id, viewer),
  });
});

get("/api/users/:id/games", async (ctx) => {
  const fork = em();
  json(ctx.res, 200, { ok: true, games: await listUserGames(fork, ctx.params.id, await viewerOf(ctx, fork)) });
});

get("/api/users/:id/records", async ({ res, params }) => {
  json(res, 200, { ok: true, records: await listUserRecords(em(), params.id) });
});

get("/api/users/:id/venues", async ({ res, params }) => {
  json(res, 200, { ok: true, venues: await userVenueRanks(em(), params.id) });
});

get("/api/people/played-with", authed(async ({ res }, { user, fork }) => {
  json(res, 200, { ok: true, people: await playedWith(fork, user) });
}));

get("/api/people/suggested", authed(async ({ res }, { user, fork }) => {
  json(res, 200, { ok: true, people: await suggestedPeople(fork, user) });
}));

get("/api/my/profile-views", authed(async ({ res }, { user, fork }) => {
  json(res, 200, { ok: true, ...(await profileViewSummary(fork, user)) });
}));

patch("/api/profile", authed(async ({ req, res }, { user, fork }) => {
  const body = await parseJsonBody<Record<string, unknown>>(req, res);
  if (body === null) return;
  const applied = await applyProfileDetails(user, body);
  if (!applied.ok) {
    json(res, 400, applied);
    return;
  }
  await fork.flush();
  json(res, 200, { ok: true, profile: await toPublicProfile(fork, user, user.id) });
}));

post("/api/users/:id/follow", authed(async ({ res, params }, { user, fork }) => {
  const result = await followUser(fork, user, params.id);
  json(res, gameStatus(result), result);
}));

post("/api/users/:id/unfollow", authed(async ({ res, params }, { user, fork }) => {
  const result = await unfollowUser(fork, user, params.id);
  json(res, gameStatus(result), result);
}));
