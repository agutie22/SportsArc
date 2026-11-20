/**
 * The signed-in user's notifications.
 */

import { authed, json } from "../http.js";
import { listNotifications, markAllRead, unreadCount } from "../social/notifications.js";
import { get, post } from "../router.js";

get("/api/notifications", authed(async ({ res, query }, { user, fork }) => {
  json(res, 200, {
    ok: true,
    ...(await listNotifications(fork, user, { before: query.get("before") ?? undefined })),
  });
}));

get("/api/notifications/unread", authed(async ({ res }, { user, fork }) => {
  json(res, 200, { ok: true, count: await unreadCount(fork, user) });
}));

post("/api/notifications/read", authed(async ({ res }, { user, fork }) => {
  await markAllRead(fork, user);
  json(res, 200, { ok: true });
}));
