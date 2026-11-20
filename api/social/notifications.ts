/**
 * Notifications: who liked, replied, followed, joined or left your game, which of
 * your games got a recap, which results were recorded, which
 * coaches and scouts looked at you, game roles: details
 * changed, removed, or named co-host, and
 * money: payments, payment requests and event payouts, and a
 * check-in becoming a verified record.
 *
 * notify() is fire-and-forget from the caller's point of view — a failed
 * notification must never fail the like or follow that caused it — and it
 * de-duplicates, so liking, unliking and liking again sends one, not three.
 */

import type { EntityManager } from "@mikro-orm/postgresql";
import { Game } from "../entities/Game.js";
import { Notification, type NotificationKind } from "../entities/Notification.js";
import { Post } from "../entities/Post.js";
import { User } from "../entities/User.js";

const PAGE = 30;

/** Kinds where one notification per (actor, subject) is enough, ever. */
const ONCE: ReadonlySet<NotificationKind> = new Set([
  "like", "follow", "join", "recap", "result_settled", "verified",
]);

/** Send a notification. Kinds in ONCE go out at most once per actor and subject. */
export async function notify(
  em: EntityManager,
  n: {
    recipient: User | string;
    actor?: User | null;
    kind: NotificationKind;
    post?: Post | null;
    game?: Game | null;
    detail?: string | null;
  },
): Promise<void> {
  const recipientId = typeof n.recipient === "string" ? n.recipient : n.recipient.id;
  if (n.actor && n.actor.id === recipientId) return;
  try {
    if (ONCE.has(n.kind)) {
      const dupe = await em.count(Notification, {
        recipient: recipientId,
        actor: n.actor ?? null,
        kind: n.kind,
        post: n.post ?? null,
        game: n.game ?? null,
      });
      if (dupe > 0) return;
    }
    const row = new Notification();
    row.recipient = em.getReference(User, recipientId);
    row.actor = n.actor ?? null;
    row.kind = n.kind;
    row.post = n.post ?? null;
    row.game = n.game ?? null;
    row.detail = n.detail?.slice(0, 120) ?? null;
    await em.persistAndFlush(row);
  } catch (err) {
    console.warn("[notify] dropped a notification:", err instanceof Error ? err.message : err);
  }
}

export async function unreadCount(em: EntityManager, user: User): Promise<number> {
  return em.count(Notification, { recipient: user, readAt: null });
}

export async function markAllRead(em: EntityManager, user: User): Promise<void> {
  await em.nativeUpdate(Notification, { recipient: user, readAt: null }, { readAt: new Date() });
}

export async function listNotifications(
  em: EntityManager,
  user: User,
  opts: { before?: unknown },
) {
  const where: Record<string, unknown> = { recipient: user };
  if (typeof opts.before === "string" && opts.before) {
    const cursor = new Date(opts.before);
    if (!Number.isNaN(cursor.getTime())) where.createdAt = { $lt: cursor };
  }
  const rows = await em.find(Notification, where, {
    populate: ["actor", "post", "post.replyTo", "game", "game.venue"],
    orderBy: { createdAt: "DESC" },
    limit: PAGE,
  });

  return {
    notifications: rows.map((n) => ({
      id: n.id,
      kind: n.kind,
      createdAt: n.createdAt.toISOString(),
      read: Boolean(n.readAt),
      detail: n.detail ?? null,
      actor: n.actor
        ? {
            id: n.actor.id,
            name: n.actor.name ?? null,
            role: n.actor.role ?? null,
            avatarUrl: n.actor.avatarUrl ?? null,
          }
        : null,
      post: n.post
        ? {
            id: n.post.id,
            // A reply notification links to the conversation, not the reply.
            threadId: n.post.replyTo?.id ?? n.post.id,
            body: n.post.body.slice(0, 140),
            image: n.post.images?.[0] ?? null,
          }
        : null,
      game: n.game
        ? {
            id: n.game.id,
            sport: n.game.sport,
            startsAt: n.game.startsAt.toISOString(),
            venueName: n.game.venue.name,
          }
        : null,
    })),
    nextBefore: rows.length === PAGE ? rows[rows.length - 1].createdAt.toISOString() : null,
  };
}
