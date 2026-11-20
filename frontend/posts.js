/**
 * Posts: one renderer and one set of interactions shared by Home and
 * Profile, so a post looks and behaves the same wherever it appears.
 *
 * Interactions are delegated from a root element, which means lists can
 * append pages without re-binding anything.
 */

import { $, main, getUser, toast, haptic, ICON, shareLink, confirmSheet } from "./shared.js";
import {
  apiGet, apiSend, api, esc, titleCase, timeAgo, whenLabel, sportIcon, avatar,
} from "./api.js";
import { recapCard, animateRecaps, shareRecap, openVerifiedSheet } from "./recap.js";
import { openVenueSheet } from "./venue.js";
import { firstVideoIn, liteVideo, bindVideos } from "./video.js";
import { gameGlance } from "./game-card.js";

// ── rendering ─────────────────────────────────────────────────────────

export function postCard(p) {
  const isSystem = p.kind === "system";
  const isRecap = p.kind === "recap" && p.recap;
  const video = !isRecap && !(p.images ?? []).length ? firstVideoIn(p.body) : null;
  const sub = [p.author.headline, p.author.primarySport && titleCase(p.author.primarySport)]
    .filter(Boolean).join(" · ");
  const images = p.images ?? [];

  return `
    <article class="post" data-post="${esc(p.id)}">
      ${avatar(p.author, "sm", { href: `#/u/${p.author.id}` })}
      <div class="post-body">
        <div class="post-head">
          <a class="post-author" href="#/u/${esc(p.author.id)}">${esc(p.author.name ?? "Someone")}</a>
          <span class="post-role" data-role="${esc(p.author.role ?? "")}" title="${esc(titleCase(p.author.role ?? ""))}"></span>
          ${sub ? `<span class="post-sub">${esc(sub)}</span>` : ""}
          <span class="post-dot">·</span>
          <time class="post-time" datetime="${esc(p.createdAt)}"
                title="${esc(new Date(p.createdAt).toLocaleString())}">${esc(timeAgo(p.createdAt))}</time>
          ${p.isAuthor ? `<button class="icon-btn post-del" data-del="${esc(p.id)}" aria-label="Delete post">${ICON.trash}</button>` : ""}
        </div>
        ${isRecap
          ? recapCard(p)
          : `<p class="post-text ${isSystem ? "post-text-system" : ""}">${esc(p.body)}</p>
             ${images.length ? mediaGrid(p.id, images) : ""}
             ${video ? `<div class="post-video">${liteVideo(video)}</div>` : ""}
             ${p.game ? postGame(p.game) : ""}
             ${p.market ? marketCard(p.market) : ""}`}
        <div class="post-actions">
          <button class="post-act" data-replies="${esc(p.id)}" aria-label="Replies">
            <span class="post-act-icon">${ICON.reply}</span><span data-replycount>${p.replyCount || ""}</span>
          </button>
          <button class="post-act ${p.likedByViewer ? "post-act-on" : ""}" data-like="${esc(p.id)}"
                  aria-pressed="${p.likedByViewer}" aria-label="Like">
            <span class="post-act-icon">${ICON.heart}</span><span data-likecount>${p.likeCount || ""}</span>
          </button>
          <button class="post-act" data-share="${esc(p.id)}" data-sharetext="${esc(p.body.slice(0, 140))}" aria-label="Share">
            <span class="post-act-icon">${ICON.share}</span>
          </button>
        </div>
        <div class="post-replies" id="replies-${esc(p.id)}"></div>
      </div>
    </article>`;
}

function mediaGrid(postId, images) {
  const n = Math.min(images.length, 4);
  return `
    <div class="post-media" data-n="${n}" data-dbl="${esc(postId)}">
      ${images.slice(0, 4).map((src) =>
        `<img class="post-media-img" src="${esc(src)}" alt="" loading="lazy" decoding="async">`).join("")}
    </div>`;
}

/** The game a post links to; its state and call to action follow game-card.js. */
function postGame(g) {
  const { state, cta } = gameGlance(g);
  return `
    <a class="post-game" href="#/games/${esc(g.id)}">
      <span class="post-game-icon">${sportIcon(g.sport)}</span>
      <span class="post-game-body">
        <strong>${esc(titleCase(g.sport))} · ${esc(g.venue.name)}</strong>
        <span class="post-game-meta">${esc(whenLabel(g.startsAt))} · ${esc(state)}</span>
      </span>
      ${cta ? `<span class="post-game-cta">${esc(cta)}</span>` : ""}
    </a>`;
}

/**
 * A Pro market the author shared. The server only sends it to adults, and
 * the price is the one when the post was written. A pick shared after
 * Gemini settled it carries its result and opens no trade.
 */
function marketCard(m) {
  const cents = m.price ? `${Math.round(Number(m.price) * 100)}¢` : "";
  const inner = `
      <span class="post-market-icon" aria-hidden="true">${ICON.trendUp}</span>
      <span class="post-market-body">
        <strong>${esc(m.outcome === "no" ? `Not ${m.label}` : m.label)}${cents ? ` · ${esc(cents)}` : ""}</strong>
        <span class="post-market-meta">${esc(m.title)} · ${esc(m.league)} · on Gemini</span>
      </span>`;
  if (m.result === "won" || m.result === "lost") {
    return `
    <div class="post-market post-market-settled">${inner}
      <span class="post-market-result post-market-${m.result}">${m.result === "won" ? "Won" : "Lost"}</span>
    </div>`;
  }
  return `
    <button type="button" class="post-market" data-post-market="${esc(m.symbol)}" data-outcome="${esc(m.outcome)}">${inner}
      <span class="post-market-cta">Trade</span>
    </button>`;
}

/** Open the trade sheet for a shared market; the markets module loads only when needed. */
async function openSharedMarket(symbol, outcome) {
  try {
    const trade = await import("./markets/trade.js");
    await trade.openTradeBySymbol(symbol, outcome === "no" ? "no" : "yes");
  } catch (err) {
    toast(err?.message || "Pro markets are not available right now.");
  }
}

export function skeletonPosts(n = 4) {
  return Array.from({ length: n }, (_, i) => `
    <div class="skel-post" aria-hidden="true">
      <div class="skel skel-circle" style="width:44px;height:44px"></div>
      <div>
        <div class="skel skel-line" style="width:${38 + (i * 13) % 30}%"></div>
        <div class="skel skel-line" style="width:${70 + (i * 7) % 25}%"></div>
        <div class="skel skel-line" style="width:${45 + (i * 11) % 35}%"></div>
      </div>
    </div>`).join("");
}

// ── interactions ──────────────────────────────────────────────────────

/** Attach once per list root; handles every post inside it, now and later. */
export function bindPostList(root) {
  if (!root || root.dataset.postsBound) return;
  root.dataset.postsBound = "1";
  bindVideos(root);

  root.addEventListener("click", (e) => {
    const verified = e.target.closest("[data-recapverified]");
    if (verified) { openVerifiedSheet(verified.dataset.recapverified); return; }
    const rs = e.target.closest("[data-recapshare]");
    if (rs) { void shareRecap(rs.dataset.recapshare); return; }
    const venue = e.target.closest("[data-venue]");
    if (venue) { void openVenueSheet(venue.dataset.venue); return; }
    const mk = e.target.closest("[data-post-market]");
    if (mk) { void openSharedMarket(mk.dataset.postMarket, mk.dataset.outcome); return; }
    const like = e.target.closest("[data-like]");
    if (like) { void toggleLike(like); return; }
    const rep = e.target.closest("[data-replies]");
    if (rep) { void toggleReplies(rep.dataset.replies); return; }
    const share = e.target.closest("[data-share]");
    if (share) { void sharePost(share); return; }
    const del = e.target.closest("[data-del]");
    if (del) { void deletePost(del.dataset.del); return; }
    const img = e.target.closest(".post-media-img");
    if (img) onImageTap(img);
  });
}

// Single tap opens the image, double tap likes it — the Instagram gesture.
// The first tap waits briefly to see whether a second is coming.
let tapTimer = null;
let lastTap = { el: null, at: 0 };

function onImageTap(img) {
  const now = Date.now();
  if (lastTap.el === img && now - lastTap.at < 300) {
    clearTimeout(tapTimer);
    lastTap = { el: null, at: 0 };
    const grid = img.closest("[data-dbl]");
    burstHeart(grid);
    const btn = grid.closest(".post")?.querySelector("[data-like]");
    if (btn && !btn.classList.contains("post-act-on")) void toggleLike(btn);
    return;
  }
  lastTap = { el: img, at: now };
  clearTimeout(tapTimer);
  tapTimer = setTimeout(() => openLightbox(img.src), 300);
}

function burstHeart(grid) {
  if (!grid) return;
  haptic(12);
  const el = document.createElement("div");
  el.className = "heart-burst";
  el.innerHTML = ICON.heart;
  grid.appendChild(el);
  setTimeout(() => el.remove(), 850);
}

export function openLightbox(src) {
  const box = document.createElement("div");
  box.className = "lightbox";
  box.innerHTML = `<img src="${esc(src)}" alt="">
    <button class="icon-btn" aria-label="Close">${ICON.close}</button>`;
  const close = () => { box.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  box.addEventListener("click", close);
  document.addEventListener("keydown", onKey);
  document.body.appendChild(box);
}

function setCount(el, n) {
  el.textContent = n || "";
  el.classList.remove("count-roll");
  void el.offsetWidth;
  el.classList.add("count-roll");
}

/** Optimistic: flip immediately, reconcile with the server, undo on error. */
async function toggleLike(btn) {
  if (btn.dataset.busy) return;
  btn.dataset.busy = "1";
  const countEl = btn.querySelector("[data-likecount]");
  const wasOn = btn.classList.contains("post-act-on");
  const before = Number(countEl.textContent) || 0;

  btn.classList.toggle("post-act-on", !wasOn);
  btn.setAttribute("aria-pressed", String(!wasOn));
  setCount(countEl, Math.max(0, before + (wasOn ? -1 : 1)));
  if (!wasOn) {
    haptic();
    btn.classList.remove("pop");
    void btn.offsetWidth;
    btn.classList.add("pop");
  }

  try {
    const r = await apiSend(`/api/posts/${btn.dataset.like}/like`, "POST");
    btn.classList.toggle("post-act-on", r.liked);
    btn.setAttribute("aria-pressed", String(r.liked));
    if (Number(countEl.textContent || 0) !== r.likeCount) setCount(countEl, r.likeCount);
  } catch (err) {
    btn.classList.toggle("post-act-on", wasOn);
    btn.setAttribute("aria-pressed", String(wasOn));
    setCount(countEl, before);
    toast(err.message);
  } finally {
    delete btn.dataset.busy;
  }
}

/** After new posts land in the DOM: start recap count-ups in view. */
export function hydratePosts(root) {
  if (root) animateRecaps(root);
}

const sharePost = (btn) => shareLink({ text: btn.dataset.sharetext, url: `${location.origin}/#/p/${btn.dataset.share}` });

async function deletePost(id) {
  if (!(await confirmSheet({ title: "Delete this post?", text: "It's removed from the feed and your profile for good.", yes: "Delete" }))) return;
  try {
    await api(`/api/posts/${id}`, { method: "DELETE" });
    const el = $(`[data-post="${CSS.escape(id)}"]`);
    if (el) {
      el.style.transition = "opacity .2s, transform .2s";
      el.style.opacity = "0";
      el.style.transform = "translateX(-12px)";
      setTimeout(() => el.remove(), 200);
    }
    toast("Post deleted");
  } catch (err) { toast(err.message); }
}

async function toggleReplies(id, { keepOpen = false } = {}) {
  const box = document.getElementById(`replies-${id}`);
  if (!box) return;
  if (box.innerHTML && !keepOpen) { box.innerHTML = ""; return; }
  if (!box.innerHTML) box.innerHTML = `<p class="feed-loading">Loading…</p>`;
  try {
    const { replies } = await apiGet(`/api/posts/${id}/replies`);
    const me = getUser();
    box.innerHTML =
      replies.map((r) => `
        <div class="reply">
          ${avatar(r.author, "xs", { href: `#/u/${r.author.id}` })}
          <div>
            <a class="reply-author" href="#/u/${esc(r.author.id)}">${esc(r.author.name ?? "Someone")}</a>
            <span class="post-time">${esc(timeAgo(r.createdAt))}</span>
            <p class="reply-text">${esc(r.body)}</p>
          </div>
        </div>`).join("") +
      `<form class="reply-form" data-replyform="${esc(id)}">
         ${me ? avatar(me, "xs") : ""}
         <input class="reply-input" placeholder="Post your reply" maxlength="500" required
                aria-label="Reply" enterkeyhint="send">
         <button class="btn-post btn-post-sm">Reply</button>
       </form>`;

    const form = box.querySelector("[data-replyform]");
    const input = form.querySelector(".reply-input");
    if (!keepOpen) input.focus({ preventScroll: true });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const body = input.value.trim();
      if (!body) return;
      const btn = form.querySelector("button");
      btn.disabled = true;
      try {
        await apiSend("/api/posts", "POST", { body, replyTo: id });
        const counter = document.querySelector(`[data-replies="${CSS.escape(id)}"] [data-replycount]`);
        if (counter) setCount(counter, (Number(counter.textContent) || 0) + 1);
        await toggleReplies(id, { keepOpen: true });
      } catch (err) {
        toast(err.message);
        btn.disabled = false;
      }
    });
  } catch (err) {
    box.innerHTML = `<p class="feed-loading">${esc(err.message)}</p>`;
  }
}

// ── follow buttons ────────────────────────────────────────────────────
//
// Shared by the rail, the inline suggestions and profiles. "Following"
// turns into "Unfollow" on hover, the way X does it, so the destructive
// action is never a surprise.

export function followButton(userId, following, { large = false } = {}) {
  return `<button class="btn-follow${large ? " btn-follow-lg" : ""}${following ? " is-following" : ""}"
    data-follow="${esc(userId)}" aria-pressed="${following}">
    <span class="lbl-on">${following ? "Following" : "Follow"}</span><span class="lbl-off">Unfollow</span>
  </button>`;
}

export function bindFollowButtons(root, { onChange } = {}) {
  if (!root || root.dataset.followBound) return;
  root.dataset.followBound = "1";
  root.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-follow]");
    if (!btn || btn.disabled) return;
    e.preventDefault();
    const following = btn.classList.contains("is-following");
    btn.disabled = true;
    try {
      const r = await apiSend(`/api/users/${btn.dataset.follow}/${following ? "unfollow" : "follow"}`, "POST");
      const now = r.following ?? !following;
      // Every button for this person on screen agrees.
      document.querySelectorAll(`[data-follow="${CSS.escape(btn.dataset.follow)}"]`).forEach((b) => {
        b.classList.toggle("is-following", now);
        b.setAttribute("aria-pressed", String(now));
        b.querySelector(".lbl-on").textContent = now ? "Following" : "Follow";
      });
      if (now) {
        haptic();
        btn.classList.remove("just-followed");
        void btn.offsetWidth;
        btn.classList.add("just-followed");
      }
      onChange?.(btn.dataset.follow, now);
      // Kept pages showing follow counts (Profile, People) are stale now.
      document.dispatchEvent(new CustomEvent("sportsarc:follow-changed", { detail: { userId: btn.dataset.follow, following: now } }));
    } catch (err) {
      toast(err.message);
    } finally {
      btn.disabled = false;
    }
  });
}

// ── single post page ──────────────────────────────────────────────────

/** #/p/<id>: the post (under its parent, if a reply) with replies open. */
export async function renderPostPage(id) {
  main().innerHTML = `
    <div class="profile-page">
      <div class="notif-panel">
        <div class="notif-head">
          <button class="icon-btn" id="post-back" aria-label="Back">${ICON.back}</button>
          <h3>Post</h3>
        </div>
        <div id="post-page" class="feed-list">${skeletonPosts(1)}</div>
      </div>
    </div>`;
  $("#post-back").addEventListener("click", () => {
    if (history.length > 1) history.back(); else location.hash = "#/";
  });
  const box = $("#post-page");
  bindPostList(box);
  try {
    const { post, parent } = await apiGet(`/api/posts/${id}`);
    box.innerHTML = (parent ? postCard(parent) : "") + postCard(post);
    hydratePosts(box);
    await toggleReplies(post.id, { keepOpen: true });
  } catch (err) {
    box.innerHTML = `<div class="empty"><p>${esc(err.message)}</p></div>`;
  }
}
