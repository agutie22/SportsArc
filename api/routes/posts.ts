/**
 * The feed: posts, replies, likes and stories.
 */

import { em } from "../db.js";
import { authed, errorJson, json, parseJsonBody, viewerOf } from "../http.js";
import { del, get, post } from "../router.js";
import { createPost, deletePost, getPost, listFeed, listReplies, listStories, toggleLike } from "../social/social.js";
import { gameStatus } from "./status.js";

get("/api/feed", async (ctx) => {
  const { query } = ctx;
  const fork = em();
  const viewer = await viewerOf(ctx, fork);
  const feed = await listFeed(
    fork,
    {
      scope: query.get("scope") ?? undefined,
      before: query.get("before") ?? undefined,
      limit: query.get("limit") ?? undefined,
      sport: query.get("sport") ?? undefined,
    },
    viewer,
  );
  json(ctx.res, 200, { ok: true, ...feed });
});

post("/api/posts", authed(async ({ req, res }, { user, fork }) => {
  const body = await parseJsonBody<Record<string, unknown>>(req, res);
  if (body === null) return;
  const result = await createPost(fork, user, body);
  if (!result.ok) {
    json(res, gameStatus(result), result);
    return;
  }
  json(res, 201, { ok: true, id: result.post.id });
}));

get("/api/posts/:id", async (ctx) => {
  const fork = em();
  const found = await getPost(fork, ctx.params.id, await viewerOf(ctx, fork));
  if (!found) {
    errorJson(ctx.res, 404, "POST_NOT_FOUND", "That post does not exist.");
    return;
  }
  json(ctx.res, 200, { ok: true, ...found });
});

get("/api/posts/:id/replies", async (ctx) => {
  const fork = em();
  json(ctx.res, 200, { ok: true, replies: await listReplies(fork, ctx.params.id, await viewerOf(ctx, fork)) });
});

post("/api/posts/:id/like", authed(async ({ res, params }, { user, fork }) => {
  const result = await toggleLike(fork, user, params.id);
  json(res, gameStatus(result), result);
}));

del("/api/posts/:id", authed(async ({ res, params }, { user, fork }) => {
  const result = await deletePost(fork, user, params.id);
  json(res, gameStatus(result), result);
}));

get("/api/stories", authed(async ({ res }, { user, fork }) => {
  json(res, 200, { ok: true, stories: await listStories(fork, user) });
}));
