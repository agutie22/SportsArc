/**
 * The social half of the product: profiles, follows, posts, and the feed.
 *
 * Profiles stay professional (LinkedIn-shaped: role, school, position,
 * measurables, highlight links, activity record). The feed is fast and
 * conversational (X-shaped: short posts, replies, likes, reverse-chron).
 */

import type { EntityManager } from "@mikro-orm/postgresql";
import { Follow } from "../entities/Follow.js";
import { Game } from "../entities/Game.js";
import { GameParticipant } from "../entities/GameParticipant.js";
import { Post, POST_MAX_IMAGES, POST_MAX_LEN } from "../entities/Post.js";
import { PostLike } from "../entities/PostLike.js";
import { User } from "../entities/User.js";
import { isSport } from "../entities/Game.js";
import { AthleteRecord } from "../entities/AthleteRecord.js";
import { toPublicGame, toPublicGames } from "../games/views.js";
import { isStoredUpload } from "./uploads.js";
import { notify } from "./notifications.js";
import { reliabilityOf } from "./reliability.js";
import { recapPayload } from "../games/recaps.js";
import { fail, type Failure } from "../failure.js";
import { teamByKey } from "../teams/catalog.js";
import { canTradeMarkets } from "../markets/access.js";
import { catalog } from "../markets/catalog.js";
import { resultOf } from "../markets/picks.js";

const MAX_LINKS = 5;
const FEED_PAGE = 30;

// ── profile ───────────────────────────────────────────────────────────

const str = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
};

const int = (v: unknown, lo: number, hi: number): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  if (!Number.isFinite(n)) return null;
  const i = Math.trunc(n);
  return i >= lo && i <= hi ? i : null;
};

function parseLinks(v: unknown): { label: string; url: string }[] | null | Failure {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v)) return fail("VALIDATION_ERROR", "Links must be a list.");
  const out: { label: string; url: string }[] = [];
  for (const raw of v.slice(0, MAX_LINKS)) {
    if (!raw || typeof raw !== "object") continue;
    const label = str((raw as Record<string, unknown>).label, 40);
    const url = str((raw as Record<string, unknown>).url, 300);
    if (!url) continue;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return fail("VALIDATION_ERROR", `"${url}" is not a valid URL.`);
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return fail("VALIDATION_ERROR", "Links must be http or https.");
    }
    out.push({ label: label ?? parsed.hostname.replace(/^www\./, ""), url: parsed.toString() });
  }
  return out;
}

export interface ProfileInput {
  bio?: unknown;
  location?: unknown;
  primarySport?: unknown;
  position?: unknown;
  classYear?: unknown;
  school?: unknown;
  heightInches?: unknown;
  weightLbs?: unknown;
  links?: unknown;
  headline?: unknown;
  avatarUrl?: unknown;
  coverUrl?: unknown;
  highlightUrl?: unknown;
  teamKey?: unknown;
}

/** Patch semantics: only keys present in the body are touched. */
export async function applyProfileDetails(user: User, body: ProfileInput): Promise<{ ok: true } | Failure> {
  for (const key of ["avatarUrl", "coverUrl"] as const) {
    if (!(key in body)) continue;
    const v = body[key];
    if (v === null || v === "") user[key] = null;
    else if (await isStoredUpload(v)) user[key] = v as string;
    else return fail("VALIDATION_ERROR", "Upload the image first.");
  }
  if ("highlightUrl" in body) {
    const raw = str(body.highlightUrl, 300);
    if (!raw) user.highlightUrl = null;
    else {
      let ok = false;
      try { ok = new URL(raw).protocol === "https:"; } catch { /* not a URL */ }
      if (!ok) return fail("VALIDATION_ERROR", "Highlight must be an https:// link.");
      user.highlightUrl = raw;
    }
  }
  if ("bio" in body) user.bio = str(body.bio, 600);
  if ("location" in body) user.location = str(body.location, 120);
  if ("position" in body) user.position = str(body.position, 32);
  if ("classYear" in body) user.classYear = str(body.classYear, 16);
  if ("school" in body) user.school = str(body.school, 160);
  if ("headline" in body) user.headline = str(body.headline, 255);
  if ("teamKey" in body) {
    if (body.teamKey === null || body.teamKey === "") user.teamKey = null;
    else if (teamByKey(body.teamKey)) user.teamKey = body.teamKey as string;
    else return fail("VALIDATION_ERROR", "Unknown team.");
  }

  if ("primarySport" in body) {
    const sport = str(body.primarySport, 24)?.toLowerCase() ?? null;
    if (sport && !isSport(sport)) return fail("VALIDATION_ERROR", "Unknown sport.");
    user.primarySport = sport;
  }
  if ("heightInches" in body) {
    if (body.heightInches === null || body.heightInches === "") user.heightInches = null;
    else {
      const h = int(body.heightInches, 36, 96);
      if (h === null) return fail("VALIDATION_ERROR", "Height must be between 36 and 96 inches.");
      user.heightInches = h;
    }
  }
  if ("weightLbs" in body) {
    if (body.weightLbs === null || body.weightLbs === "") user.weightLbs = null;
    else {
      const w = int(body.weightLbs, 50, 500);
      if (w === null) return fail("VALIDATION_ERROR", "Weight must be between 50 and 500 lbs.");
      user.weightLbs = w;
    }
  }
  if ("links" in body) {
    const links = parseLinks(body.links);
    if (links && "ok" in links) return links;
    user.links = links;
  }
  return { ok: true };
}

export interface ProfileStats {
  gamesPlayed: number;
  gamesHosted: number;
  followers: number;
  following: number;
}

/** Activity record. "Played" means checked in — an attested appearance. */
export async function profileStats(em: EntityManager, user: User): Promise<ProfileStats> {
  const [gamesPlayed, gamesHosted, followers, following] = await Promise.all([
    em.count(GameParticipant, { user, status: "joined", checkedInAt: { $ne: null } }),
    em.count(Game, { host: user }),
    em.count(Follow, { followee: user }),
    em.count(Follow, { follower: user }),
  ]);
  return {
    gamesPlayed,
    gamesHosted,
    followers,
    following,
  };
}

export async function toPublicProfile(em: EntityManager, user: User, viewerId?: string) {
  // A minor's profile, opened signed out, names them and nothing more.
  if (user.audience === "minor" && !viewerId) return limitedProfile(user);
  const stats = await profileStats(em, user);
  const isFollowing = viewerId && viewerId !== user.id
    ? (await em.count(Follow, { follower: viewerId, followee: user })) > 0
    : false;
  return {
    id: user.id,
    name: user.name ?? null,
    role: user.role ?? null,
    headline: user.headline ?? null,
    bio: user.bio ?? null,
    location: user.location ?? null,
    primarySport: user.primarySport ?? null,
    position: user.position ?? null,
    classYear: user.classYear ?? null,
    school: user.school ?? null,
    heightInches: user.heightInches ?? null,
    weightLbs: user.weightLbs ?? null,
    links: user.links ?? [],
    avatarUrl: user.avatarUrl ?? null,
    coverUrl: user.coverUrl ?? null,
    highlightUrl: user.highlightUrl ?? null,
    team: teamByKey(user.teamKey),
    stats,
    reliability: await reliabilityOf(em, user.id),
    isSelf: viewerId === user.id,
    isFollowing,
  };
}

/** What a signed-out visitor sees of a minor: name, role and photo; every other field empty. */
function limitedProfile(user: User) {
  return {
    id: user.id,
    name: user.name ?? null,
    role: user.role ?? null,
    headline: null,
    bio: null,
    location: null,
    primarySport: null,
    position: null,
    classYear: null,
    school: null,
    heightInches: null,
    weightLbs: null,
    links: [],
    avatarUrl: user.avatarUrl ?? null,
    coverUrl: null,
    highlightUrl: null,
    team: null,
    stats: null,
    reliability: null,
    isSelf: false,
    isFollowing: false,
    limited: true,
  };
}

// ── follows ───────────────────────────────────────────────────────────

export async function followUser(
  em: EntityManager,
  follower: User,
  followeeId: string,
): Promise<{ ok: true; following: boolean } | Failure> {
  if (follower.id === followeeId) return fail("VALIDATION_ERROR", "You cannot follow yourself.");
  const followee = await em.findOne(User, { id: followeeId });
  if (!followee) return fail("USER_NOT_FOUND", "That person does not exist.");
  const existing = await em.findOne(Follow, { follower, followee });
  if (existing) return { ok: true, following: true };
  const f = new Follow();
  f.follower = follower;
  f.followee = followee;
  await em.persistAndFlush(f);
  await notify(em, { recipient: followee, actor: follower, kind: "follow" });
  return { ok: true, following: true };
}

export async function unfollowUser(
  em: EntityManager,
  follower: User,
  followeeId: string,
): Promise<{ ok: true; following: boolean } | Failure> {
  const existing = await em.findOne(Follow, { follower, followee: followeeId });
  if (existing) await em.removeAndFlush(existing);
  return { ok: true, following: false };
}

// ── posts ─────────────────────────────────────────────────────────────

export async function createPost(
  em: EntityManager,
  author: User,
  body: { body?: unknown; gameId?: unknown; replyTo?: unknown; images?: unknown; sport?: unknown; market?: unknown },
): Promise<{ ok: true; post: Post } | Failure> {
  const text = typeof body.body === "string" ? body.body.trim() : "";

  let images: string[] = [];
  if (body.images !== undefined && body.images !== null) {
    if (!Array.isArray(body.images)) return fail("VALIDATION_ERROR", "Images must be a list.");
    if (body.images.length > POST_MAX_IMAGES) {
      return fail("VALIDATION_ERROR", `Posts can carry at most ${POST_MAX_IMAGES} images.`);
    }
    for (const url of body.images) {
      if (!(await isStoredUpload(url))) return fail("VALIDATION_ERROR", "Upload each image first.");
    }
    images = [...new Set(body.images as string[])];
  }

  if (!text && images.length === 0) return fail("VALIDATION_ERROR", "Write something first.");
  if (text.length > POST_MAX_LEN) {
    return fail("VALIDATION_ERROR", `Posts are limited to ${POST_MAX_LEN} characters.`);
  }

  const post = new Post();
  post.author = author;
  post.body = text;
  post.images = images;
  post.kind = "user";

  if (typeof body.gameId === "string" && body.gameId.trim()) {
    const game = await em.findOne(Game, { id: body.gameId.trim() });
    if (!game) return fail("GAME_NOT_FOUND", "That game does not exist.");
    post.game = game;
  }

  if (typeof body.replyTo === "string" && body.replyTo.trim()) {
    const parent = await em.findOne(Post, { id: body.replyTo.trim() });
    if (!parent) return fail("POST_NOT_FOUND", "That post does not exist.");
    post.replyTo = parent;
    parent.replyCount += 1;
  }

  if (body.market !== undefined && body.market !== null) {
    const m = body.market as { symbol?: unknown; outcome?: unknown };
    if (!canTradeMarkets(author)) return fail("MARKETS_NOT_ALLOWED", "Pro markets are for adults only.");
    if (typeof m.symbol !== "string" || (m.outcome !== "yes" && m.outcome !== "no")) {
      return fail("VALIDATION_ERROR", "Name the market and the side.");
    }
    const found = await catalog().contract(m.symbol);
    if (!found.ok) return fail("MARKET_NOT_FOUND", "That market is not available.");
    post.market = {
      ticker: found.event.parentTicker ?? found.event.ticker,
      symbol: found.contract.symbol,
      title: found.event.title,
      label: found.contract.short,
      outcome: m.outcome,
      price: found.contract[m.outcome].buy,
      league: found.event.league,
      sport: found.event.sport,
      result: resultOf(found.contract.resolutionSide, m.outcome),
    };
  }

  // What sport the post is about: its game's, its market's, or the one it was posted under.
  post.sport = post.game?.sport
    ?? post.market?.sport
    ?? (typeof body.sport === "string" && isSport(body.sport) ? body.sport : null);

  await em.persistAndFlush(post);
  if (post.replyTo) await notify(em, { recipient: post.replyTo.author.id, actor: author, kind: "reply", post });
  return { ok: true, post };
}

export async function deletePost(
  em: EntityManager,
  user: User,
  postId: string,
): Promise<{ ok: true } | Failure> {
  const post = await em.findOne(Post, { id: postId }, { populate: ["author", "replyTo"] });
  if (!post) return fail("POST_NOT_FOUND", "That post does not exist.");
  if (post.author.id !== user.id) return fail("NOT_AUTHOR", "You can only delete your own posts.");
  if (post.replyTo) post.replyTo.replyCount = Math.max(0, post.replyTo.replyCount - 1);
  await em.removeAndFlush(post);
  return { ok: true };
}

export async function toggleLike(
  em: EntityManager,
  user: User,
  postId: string,
): Promise<{ ok: true; liked: boolean; likeCount: number } | Failure> {
  const post = await em.findOne(Post, { id: postId });
  if (!post) return fail("POST_NOT_FOUND", "That post does not exist.");

  const result = await em.transactional(async (tx) => {
    const existing = await tx.findOne(PostLike, { post, user });
    if (existing) {
      tx.remove(existing);
      post.likeCount = Math.max(0, post.likeCount - 1);
      await tx.flush();
      return { ok: true as const, liked: false, likeCount: post.likeCount };
    }
    const like = new PostLike();
    like.post = post;
    like.user = user;
    tx.persist(like);
    post.likeCount += 1;
    await tx.flush();
    return { ok: true as const, liked: true, likeCount: post.likeCount };
  });
  if (result.liked) await notify(em, { recipient: post.author.id, actor: user, kind: "like", post });
  return result;
}

async function toPublicPost(
  em: EntityManager,
  post: Post,
  likedIds: Set<string>,
  viewer?: User,
  games?: Map<string, Awaited<ReturnType<typeof toPublicGame>>>,
) {
  const viewerId = viewer?.id;
  return {
    id: post.id,
    kind: post.kind,
    body: post.body,
    images: post.images ?? [],
    createdAt: post.createdAt.toISOString(),
    likeCount: post.likeCount,
    replyCount: post.replyCount,
    likedByViewer: likedIds.has(post.id),
    isAuthor: viewerId ? post.author.id === viewerId : false,
    author: {
      id: post.author.id,
      name: post.author.name ?? null,
      role: post.author.role ?? null,
      headline: post.author.headline ?? null,
      primarySport: post.author.primarySport ?? null,
      avatarUrl: post.author.avatarUrl ?? null,
    },
    game: post.game ? games?.get(post.game.id) ?? await toPublicGame(em, post.game, viewerId) : null,
    recap: post.kind === "recap" && post.game ? await recapPayload(em, post.game, viewerId) : null,
    sport: post.sport ?? null,
    // Market cards are for adults (markets/access.ts): others see the text only.
    market: post.market && canTradeMarkets(viewer) ? post.market : null,
  };
}

async function decorate(em: EntityManager, posts: Post[], viewer?: User) {
  if (posts.length === 0) return [];
  let likedIds = new Set<string>();
  if (viewer) {
    const likes = await em.find(PostLike, { user: viewer.id, post: { $in: posts.map((p) => p.id) } });
    likedIds = new Set(likes.map((l) => l.post.id));
  }
  // Every attached game in one pass (games/views.ts toPublicGames).
  const attached = [...new Map(posts.filter((p) => p.game).map((p) => [p.game!.id, p.game!])).values()];
  const games = new Map((await toPublicGames(em, attached, viewer?.id)).map((g) => [g.id, g]));
  return Promise.all(posts.map((p) => toPublicPost(em, p, likedIds, viewer, games)));
}

export type FeedScope = "home" | "latest";

/**
 * Home is you plus the people you follow. Following nobody would mean an
 * empty app on day one, so home falls back to latest until the graph exists.
 */
export async function listFeed(
  em: EntityManager,
  opts: { scope?: unknown; before?: unknown; limit?: unknown; sport?: unknown },
  viewer?: User,
) {
  const scope: FeedScope = opts.scope === "latest" ? "latest" : "home";
  const limit = Math.min(Math.trunc(Number(opts.limit) || FEED_PAGE), 50);

  const where: Record<string, unknown> = { replyTo: null };
  if (typeof opts.before === "string" && opts.before) {
    const cursor = new Date(opts.before);
    if (!Number.isNaN(cursor.getTime())) where.createdAt = { $lt: cursor };
  }
  // A sport page: posts tagged with the sport, or about a game of it (posts
  // from before the tag existed carry only their game).
  // A cancelled game's "is hosting" announcement leaves the feed with it.
  const and: Record<string, unknown>[] = [{ $or: [{ kind: { $ne: "system" } }, { game: { status: { $ne: "cancelled" } } }] }];
  if (typeof opts.sport === "string" && isSport(opts.sport)) {
    and.push({ $or: [{ sport: opts.sport }, { game: { sport: opts.sport } }] });
  }
  where.$and = and;

  let usedFallback = false;
  if (scope === "home" && viewer) {
    const follows = await em.find(Follow, { follower: viewer });
    const ids = follows.map((f) => f.followee.id);
    if (ids.length > 0) {
      // A recap of a game you played is yours, whoever hosted it.
      const played = await em.find(GameParticipant, { user: viewer, status: "joined", checkedInAt: { $ne: null } });
      where.$or = [
        { author: { $in: [...ids, viewer.id] } },
        ...(played.length ? [{ kind: "recap", game: { $in: played.map((p) => p.game.id) } }] : []),
      ];
    } else {
      usedFallback = true;
    }
  }

  const posts = await em.find(Post, where, {
    populate: ["author", "game", "game.venue", "game.host", "replyTo"],
    orderBy: { createdAt: "DESC" },
    limit,
  });

  return {
    posts: await decorate(em, posts, viewer),
    scope,
    usedFallback,
    nextBefore: posts.length === limit ? posts[posts.length - 1].createdAt.toISOString() : null,
  };
}

export async function listReplies(em: EntityManager, postId: string, viewer?: User) {
  const replies = await em.find(
    Post,
    { replyTo: postId },
    {
      populate: ["author", "game", "game.venue", "game.host", "replyTo"],
      orderBy: { createdAt: "ASC" },
      limit: 100,
    },
  );
  return decorate(em, replies, viewer);
}

/** One post, plus the post it replies to when it is a reply. */
export async function getPost(em: EntityManager, postId: string, viewer?: User) {
  const post = await em.findOne(
    Post,
    { id: postId },
    { populate: ["author", "game", "game.venue", "game.host", "replyTo", "replyTo.author"] },
  );
  if (!post) return null;
  const [pub] = await decorate(em, [post], viewer);
  let parent = null;
  if (post.replyTo) {
    await em.populate(post.replyTo, ["author", "game", "game.venue", "game.host"]);
    [parent] = await decorate(em, [post.replyTo], viewer);
  }
  return { post: pub, parent };
}

export async function listUserPosts(em: EntityManager, userId: string, viewer?: User) {
  const posts = await em.find(
    Post,
    { author: userId, replyTo: null },
    {
      populate: ["author", "game", "game.venue", "game.host", "replyTo"],
      orderBy: { createdAt: "DESC" },
      limit: 50,
    },
  );
  return decorate(em, posts, viewer);
}

/**
 * People worth following: never yourself, never someone you already follow.
 * Players are pointed at coaches and scouts, and coaches and scouts at
 * players, since that is the connection the product exists to make.
 */
export async function suggestedPeople(em: EntityManager, viewer: User, limit = 5) {
  const following = await em.find(Follow, { follower: viewer });
  const exclude = [viewer.id, ...following.map((f) => f.followee.id)];

  const wantRoles =
    viewer.role === "player" ? ["coach", "scout"] : viewer.role ? ["player"] : [];

  const pick = async (where: Record<string, unknown>, take: number) =>
    take <= 0 ? [] : em.find(User, { ...where, id: { $nin: exclude }, name: { $ne: null } },
      { orderBy: { createdAt: "DESC" }, limit: take });

  // Complementary roles first, then anyone in the same sport, then anyone.
  const primary = await pick(wantRoles.length ? { role: { $in: wantRoles } } : {}, limit);
  const seen = new Set(primary.map((u) => u.id));

  let rest: User[] = [];
  if (primary.length < limit && viewer.primarySport) {
    rest = (await pick({ primarySport: viewer.primarySport }, limit - primary.length))
      .filter((u) => !seen.has(u.id));
    rest.forEach((u) => seen.add(u.id));
  }
  let filler: User[] = [];
  if (primary.length + rest.length < limit) {
    filler = (await pick({}, limit - primary.length - rest.length))
      .filter((u) => !seen.has(u.id));
  }

  return Promise.all(
    [...primary, ...rest, ...filler].slice(0, limit).map((u) => toPublicProfile(em, u, viewer.id)),
  );
}

/** Directory search backing the "find people" half of the product. */
export async function searchPeople(
  em: EntityManager,
  opts: { q?: unknown; role?: unknown; sport?: unknown; limit?: unknown },
  viewerId?: string,
) {
  const where: Record<string, unknown> = {};
  const q = typeof opts.q === "string" ? opts.q.trim() : "";
  if (q) {
    where.$or = [
      { name: { $ilike: `%${q}%` } },
      { school: { $ilike: `%${q}%` } },
      { location: { $ilike: `%${q}%` } },
    ];
  }
  const role = typeof opts.role === "string" ? opts.role.trim() : "";
  if (role) where.role = role;
  const sport = typeof opts.sport === "string" ? opts.sport.trim().toLowerCase() : "";
  if (sport && isSport(sport)) where.primarySport = sport;

  // Signed out, minors are not listed at all (their profiles are signed-in only).
  const filter = viewerId ? where : { $and: [where, { $or: [{ audience: null }, { audience: { $ne: "minor" } }] }] };
  const users = await em.find(User, filter, {
    orderBy: { createdAt: "DESC" },
    limit: Math.min(Math.trunc(Number(opts.limit) || 25), 50),
  });
  return Promise.all(users.map((u) => toPublicProfile(em, u, viewerId)));
}

// ── profile tabs and stories ──────────────────────────────────────────

/**
 * Games on someone's profile: ones they host or hold a seat in, newest
 * first. Invite-only games stay off other people's view of the profile.
 */
export async function listUserGames(em: EntityManager, userId: string, viewer?: User, limit = 30) {
  const isSelf = viewer?.id === userId;
  const seats = await em.find(
    GameParticipant,
    { user: userId, status: "joined" },
    { populate: ["game", "game.venue", "game.host"] },
  );
  const hosted = await em.find(Game, { host: userId }, { populate: ["venue", "host"] });
  const byId = new Map<string, Game>();
  for (const g of [...seats.map((s) => s.game), ...hosted]) byId.set(g.id, g);
  const games = [...byId.values()]
    .filter((g) => g.status !== "cancelled" && (isSelf || g.visibility === "public"))
    .sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime())
    .slice(0, limit);
  return toPublicGames(em, games, viewer?.id);
}

/** Imported stat lines this person has claimed. Unverified — see CLAUDE.md. */
export async function listUserRecords(em: EntityManager, userId: string) {
  const records = await em.find(
    AthleteRecord,
    { claimedBy: userId },
    { populate: ["school"], orderBy: { lastSeenAt: "DESC" }, limit: 20 },
  );
  return records.map((r) => ({
    id: r.id,
    sport: r.sport,
    position: r.position ?? null,
    classYear: r.classYear ?? null,
    stats: r.stats ?? {},
    school: r.school ? { name: r.school.name, state: r.school.state } : null,
    source: r.source,
    sourceUrl: r.sourceUrl ?? null,
  }));
}

/**
 * The stories row: people you follow who are in a game that is live now or
 * starts within the next 24 hours. Live games sort first, then soonest.
 */
export async function listStories(em: EntityManager, viewer: User) {
  const follows = await em.find(Follow, { follower: viewer });
  const ids = follows.map((f) => f.followee.id);
  if (ids.length === 0) return [];

  const now = Date.now();
  const seats = await em.find(
    GameParticipant,
    {
      user: { $in: ids },
      status: "joined",
      game: {
        status: { $ne: "cancelled" },
        visibility: "public",
        startsAt: { $gte: new Date(now - 4 * 3600_000), $lte: new Date(now + 24 * 3600_000) },
      },
    },
    { populate: ["user", "game", "game.venue"] },
  );

  const best = new Map<string, { seat: GameParticipant; live: boolean; startsAt: number }>();
  for (const seat of seats) {
    const start = seat.game.startsAt.getTime();
    const end = start + seat.game.durationMinutes * 60_000;
    if (end < now) continue;
    const live = start <= now;
    const prev = best.get(seat.user.id);
    if (!prev || (live && !prev.live) || (live === prev.live && start < prev.startsAt)) {
      best.set(seat.user.id, { seat, live, startsAt: start });
    }
  }

  return [...best.values()]
    .sort((a, b) => Number(b.live) - Number(a.live) || a.startsAt - b.startsAt)
    .slice(0, 20)
    .map(({ seat, live }) => ({
      user: {
        id: seat.user.id,
        name: seat.user.name ?? null,
        role: seat.user.role ?? null,
        avatarUrl: seat.user.avatarUrl ?? null,
      },
      live,
      game: {
        id: seat.game.id,
        sport: seat.game.sport,
        startsAt: seat.game.startsAt.toISOString(),
        venueName: seat.game.venue.name,
      },
    }));
}
