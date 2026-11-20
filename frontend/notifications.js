/**
 * Notifications page and the unread badge on the bell.
 *
 * Adjacent notifications of the same kind about the same thing collapse
 * into one row — "Maya and 2 others liked your post", or joined or left
 * your game —
 * the way Instagram and X do it, so ten likes are one line and not ten.
 *
 * A name or face opens that person's profile. The rest of the row still
 * opens the subject: the post, the game, or Payments. A recorded result
 * opens the game's result sheet in place.
 *
 * There is no push channel. The badge polls once a minute, and again when
 * the tab is shown or the user navigates, only if that minute has elapsed.
 */

import { main, ICON, toast } from "./shared.js";
import { apiGet, apiSend, warm, esc, timeAgo, titleCase, whenLabel, sportIcon, avatar, personLink } from "./api.js";
import { skeletonPosts } from "./posts.js";
import { openResultSheet } from "./results.js";

const POLL_MS = 60_000;

let pollTimer = null;
let onVisible = null;
let lastFetchAt = 0;
let inFlight = null;

/**
 * The rendered page's own state: its cursor and its loads. One route, so
 * one copy is live at a time; each render replaces it, and an answer for a
 * page that has been replaced, or for a load a newer reset superseded, is
 * dropped rather than appended to the wrong list.
 */
let P = null;

// ── badge ─────────────────────────────────────────────────────────────

function setBadge(n) {
  document.querySelectorAll("[data-badge]").forEach((b) => {
    b.hidden = !n;
    b.textContent = n > 9 ? "9+" : String(n);
  });
}

/**
 * Fetch the unread count. Calls share one in-flight request. A call within
 * a minute of the last start does nothing, unless `force` is set (the
 * minute timer). Visibility and navigation pass no force, so a flap cannot
 * outrun the poll.
 */
export function refreshBadge({ force = false } = {}) {
  if (inFlight) return inFlight;
  if (!force && Date.now() - lastFetchAt < POLL_MS) return;
  lastFetchAt = Date.now();
  inFlight = apiGet("/api/notifications/unread")
    .then(({ count }) => setBadge(count))
    .catch(() => { /* signed out, or offline — the badge just stays as it was */ })
    .finally(() => { inFlight = null; });
  return inFlight;
}

export function startBadgePolling() {
  if (pollTimer) return;
  void refreshBadge({ force: true });
  pollTimer = setInterval(() => { if (!document.hidden) void refreshBadge({ force: true }); }, POLL_MS);
  onVisible = () => { if (!document.hidden) void refreshBadge(); };
  document.addEventListener("visibilitychange", onVisible);
}

export function stopBadgePolling() {
  clearInterval(pollTimer);
  pollTimer = null;
  if (onVisible) document.removeEventListener("visibilitychange", onVisible);
  onVisible = null;
  setBadge(0);
}

// ── page ──────────────────────────────────────────────────────────────

export function renderNotifications() {
  main().innerHTML = `
    <div class="profile-page">
      <div class="notif-panel">
        <div class="notif-head"><h3>Notifications</h3></div>
        <div id="notif-list">${skeletonPosts(5)}</div>
        <div id="notif-more"></div>
      </div>
    </div>`;
  const root = main().querySelector(".notif-panel");
  P = { root, $: (sel) => root.querySelector(sel), next: null, seq: 0, paging: false };
  P.$("#notif-list").addEventListener("click", (e) => {
    const a = e.target.closest("[data-result-game]");
    if (!a) return;
    e.preventDefault();
    void openResultSheet(a.dataset.resultGame);
  });
  void load(true);
}

/** Fetch the first page ahead of the viewer opening it; reading it marks nothing read. */
export function warmNotifications() {
  warm("/api/notifications");
}

/** Shown again from the tab cache: reload the list in place, no skeleton. */
export function resumeNotifications() {
  void load(true);
}

async function load(reset) {
  const p = P;
  const list = p?.$("#notif-list");
  if (!list) return;
  // A reset drops whatever is in flight and forgets the old cursor; "more"
  // never cancels a reset, so a click during a reload cannot swallow it.
  if (reset) {
    p.seq++;
    p.paging = false;
    p.next = null;
  } else if (p.paging || !p.next) {
    return;
  }
  const seq = p.seq;
  const before = p.next;
  if (!reset) p.paging = true;
  const current = () => seq === p.seq && p === P;
  try {
    const data = await apiGet("/api/notifications", reset ? undefined : { before });
    if (!current()) return;
    const html = group(data.notifications).map(row).join("");
    if (reset) {
      list.innerHTML = html || `
        <div class="empty"><p>Nothing yet.</p>
          <p class="empty-sub">Likes, replies, new followers, people joining or leaving your games,
            results to record, recaps and recruiter views all show up here.</p></div>`;
    } else {
      list.insertAdjacentHTML("beforeend", html);
    }
    p.next = data.nextBefore;
    const more = p.$("#notif-more");
    more.innerHTML = p.next ? `<button type="button" class="btn-game btn-game-ghost btn-block" id="notif-more-btn">Show more</button>` : "";
    if (p.next) more.querySelector("#notif-more-btn").addEventListener("click", () => void load(false));

    // Seen once rendered. The rows keep their unread tint for this visit.
    if (reset && data.notifications.some((n) => !n.read)) {
      // Read marks change only what this page and the badge show.
      await apiSend("/api/notifications/read", "POST", undefined, { stale: ["/api/notifications"] });
      setBadge(0);
    }
  } catch (err) {
    if (!current()) return;
    // A failed "more" keeps the rows already shown; the button retries.
    if (reset) list.innerHTML = `<p class="feed-loading">${esc(err.message)}</p>`;
    else toast(err.message);
  } finally {
    if (!reset && current()) p.paging = false;
  }
}

/**
 * Merge adjacent likes, follows, or joins about the same subject into one
 * row. A join or a leave only collapses when it names a game, so two
 * gameless rows stay separate.
 */
function groupKey(n) {
  if (n.kind === "like" || n.kind === "follow") return `${n.kind}:${n.post?.id ?? ""}`;
  if ((n.kind === "join" || n.kind === "left") && n.game?.id) return `${n.kind}:${n.game.id}`;
  return "";
}

function group(items) {
  const out = [];
  for (const n of items) {
    const prev = out[out.length - 1];
    const key = groupKey(n);
    if (prev && key && prev.key === key) {
      if (n.actor && !prev.actors.some((a) => a.id === n.actor.id)) prev.actors.push(n.actor);
      prev.read = prev.read && n.read;
      continue;
    }
    out.push({ ...n, key, actors: n.actor ? [n.actor] : [] });
  }
  return out;
}

const KIND = {
  like:   { icon: ICON.heart,  cls: "k-like" },
  reply:  { icon: ICON.reply,  cls: "k-reply" },
  follow: { icon: ICON.user,   cls: "k-follow" },
  join:   { icon: ICON.ball,   cls: "k-join" },
  left:   { icon: ICON.logout, cls: "k-left" },
  recap:  { icon: ICON.trophy, cls: "k-recap" },
  view:   { icon: ICON.trendUp, cls: "k-view" },
  result_settled: { icon: ICON.trophy, cls: "k-settled" },
  game_changed:  { icon: ICON.clipboard, cls: "k-changed" },
  game_removed:  { icon: ICON.close, cls: "k-removed" },
  cohost_named:  { icon: ICON.people, cls: "k-role" },
  payout_sent:   { icon: ICON.dollar, cls: "k-money" },
  payout_wallet: { icon: ICON.dollar, cls: "k-result" },
  funds_added:   { icon: ICON.dollar, cls: "k-money" },
  paid:          { icon: ICON.dollar, cls: "k-money" },
  pay_request:   { icon: ICON.dollar, cls: "k-result" },
  event_result:    { icon: ICON.trophy, cls: "k-result" },
  event_off:       { icon: ICON.close,  cls: "k-removed" },
  event_refund:    { icon: ICON.dollar, cls: "k-money" },
  event_prize:     { icon: ICON.trophy, cls: "k-money" },
  event_payout:    { icon: ICON.dollar, cls: "k-money" },
  verified:        { icon: ICON.check,  cls: "k-settled" },
  market_settled:  { icon: ICON.trendUp, cls: "k-money" },
  org_invite:      { icon: ICON.people, cls: "k-role" },
  team_added:      { icon: ICON.people, cls: "k-join" },
  tryout_invite:   { icon: ICON.target, cls: "k-role" },
  camp_invite:     { icon: ICON.trophy, cls: "k-settled" },
};

function who(actors) {
  const link = (a, fallback) => personLink(a, { fallback });
  if (actors.length <= 1) return link(actors[0], "Someone");
  if (actors.length === 2) return `${link(actors[0], "Someone")} and ${link(actors[1], "someone")}`;
  if (actors.length === 3) {
    return `${link(actors[0], "Someone")}, ${link(actors[1], "someone")} and ${link(actors[2], "someone")}`;
  }
  return `${link(actors[0], "Someone")}, ${link(actors[1], "someone")} and ${actors.length - 2} others`;
}

const gameHref = (n) => (n.game ? `#/games/${esc(n.game.id)}` : "#/games");

function row(n) {
  const k = KIND[n.kind] ?? KIND.like;
  let text = "", sub = "", href = "#/", resultGame = "";
  const gameLine = n.game ? `${sportIcon(n.game.sport)} ${n.game.venueName} · ${whenLabel(n.game.startsAt)}` : "";
  const sport = esc(titleCase(n.game?.sport ?? "game"));
  switch (n.kind) {
    case "like":
      text = `${who(n.actors)} liked your post`;
      sub = n.post?.body ?? "";
      href = n.post ? `#/p/${n.post.threadId}` : "#/profile";
      break;
    case "reply":
      text = `${who(n.actors)} replied`;
      sub = n.post?.body ?? "";
      href = n.post ? `#/p/${n.post.threadId}` : "#/profile";
      break;
    case "follow":
      text = `${who(n.actors)} followed you`;
      href = n.actors.length === 1 ? `#/u/${n.actors[0].id}` : "#/profile";
      break;
    case "join":
      text = `${who(n.actors)} joined your ${esc(titleCase(n.game?.sport ?? "game"))} game`;
      sub = n.game ? `${sportIcon(n.game.sport)} ${n.game.venueName} · ${whenLabel(n.game.startsAt)}` : "";
      href = gameHref(n);
      break;
    case "left":
      text = `${who(n.actors)} left your ${esc(titleCase(n.game?.sport ?? "game"))} game`;
      sub = n.game ? `${sportIcon(n.game.sport)} ${n.game.venueName} · ${whenLabel(n.game.startsAt)}` : "";
      href = gameHref(n);
      break;
    case "recap":
      text = `Your recap from <strong>${esc(n.game?.venueName ?? "your game")}</strong> is in`;
      sub = "See who showed up and what it did for your record.";
      href = n.post ? `#/p/${n.post.id}` : "#/";
      break;
    case "result_settled":
      text = `The result of your <strong>${sport}</strong> game is settled`;
      sub = gameLine;
      href = gameHref(n);
      resultGame = n.game?.id ?? "";
      break;
    case "game_changed":
      text = `${who(n.actors)} changed the details of your <strong>${sport}</strong> game`;
      sub = gameLine;
      href = gameHref(n);
      break;
    case "game_removed":
      text = `${who(n.actors)} removed you from a <strong>${sport}</strong> game`;
      sub = gameLine;
      href = gameHref(n);
      break;
    case "cohost_named":
      text = `${who(n.actors)} made you a co-host of a <strong>${sport}</strong> game`;
      sub = gameLine;
      href = gameHref(n);
      break;
    case "payout_sent":
      text = "Your money was paid out";
      sub = [n.detail, n.game ? gameLine : ""].filter(Boolean).join(" · ");
      href = "#/pay";
      break;
    case "payout_wallet":
      text = "A payout couldn't reach the network you chose";
      sub = [n.detail, n.game ? gameLine : ""].filter(Boolean).join(" · ");
      href = "#/pay";
      break;
    case "funds_added":
      text = "The money you added has arrived";
      sub = n.detail ?? "";
      href = "#/pay";
      break;
    case "paid":
      text = `${who(n.actors)} paid you`;
      sub = n.detail ?? "";
      href = "#/pay";
      break;
    case "pay_request":
      text = `${who(n.actors)} asked you for money`;
      sub = n.detail ?? "";
      href = "#/pay";
      break;
    case "event_result":
      text = `The result of your <strong>${sport}</strong> event is posted`;
      sub = gameLine;
      href = gameHref(n);
      break;
    case "event_off":
      text = `Your <strong>${sport}</strong> event is off`;
      sub = [n.detail, gameLine].filter(Boolean).join(" · ");
      href = gameHref(n);
      break;
    case "event_refund":
      text = `Your money from a <strong>${sport}</strong> event came back`;
      sub = [n.detail, gameLine].filter(Boolean).join(" · ");
      href = "#/pay";
      break;
    case "event_prize":
      text = `You won prize money at a <strong>${sport}</strong> event`;
      sub = [n.detail, gameLine].filter(Boolean).join(" · ");
      href = "#/pay";
      break;
    case "event_payout":
      text = `Your <strong>${sport}</strong> event paid out`;
      sub = [n.detail, gameLine].filter(Boolean).join(" · ");
      href = "#/pay";
      break;
    case "verified":
      text = `Your check-in at <strong>${esc(n.game?.venueName ?? "your game")}</strong> is verified`;
      sub = gameLine;
      // The game sheet shows the verified line and opens this game's receipt.
      href = n.game ? gameHref(n) : "#/record";
      break;
    case "market_settled":
      text = "A <strong>pick</strong> you hold settled";
      sub = n.detail ?? "";
      // Home › Markets › Your picks (markets/home.js), where it now shows under Settled.
      href = "#/markets/picks";
      break;
    case "org_invite":
      // detail: "<org name> · <role>" (api/orgs/orgs.ts inviteStaff).
      text = `${who(n.actors)} invited you to join an organization's staff`;
      sub = n.detail ?? "";
      href = "#/orgs/invites";
      break;
    case "tryout_invite":
      // detail: "<org> · <tryout>" (api/tryouts/tryouts.ts); the game is the tryout's event.
      text = `You're invited to a <strong>tryout</strong>`;
      sub = n.detail ?? "";
      href = n.game ? `#/tryout/${esc(n.game.id)}` : "#/";
      break;
    case "camp_invite":
      text = `You're invited to <strong>camp</strong>`;
      sub = n.detail ?? "";
      href = n.game ? `#/tryout/${esc(n.game.id)}` : "#/";
      break;
    case "team_added":
      // detail: "<team> · <season>" (api/leagues/leagues.ts addMember).
      text = `${who(n.actors)} put you on a league team`;
      sub = n.detail ?? "";
      href = "#/orgs";
      break;
    case "view":
      text = `${who(n.actors)} <span class="notif-role">${esc(titleCase(n.actors[0]?.role ?? ""))}</span> viewed your profile`;
      href = n.actors[0] ? `#/u/${n.actors[0].id}` : "#/profile";
      break;
  }

  const faces = n.actors.slice(0, 4).map((a) => avatar(a, "xs", { href: a.id ? `#/u/${a.id}` : "" })).join("");
  // The row cannot be one <a>: the names inside it are their own links.
  // A stretched link sits under the sentence, and the names and faces sit above it.
  return `
    <div class="notif${n.read ? "" : " unread"}">
      <span class="notif-kind ${k.cls}">${k.icon}</span>
      <span class="notif-body">
        ${faces ? `<span class="notif-faces">${faces}</span>` : ""}
        <span class="notif-text" id="nt-${esc(n.id)}">${text} <time>${esc(timeAgo(n.createdAt))}</time></span>
        ${sub ? `<span class="notif-sub">${esc(sub)}</span>` : ""}
      </span>
      ${n.post?.image ? `<img class="notif-thumb" src="${esc(n.post.image)}" alt="" loading="lazy">` : ""}
      <a class="notif-open" href="${href}" aria-labelledby="nt-${esc(n.id)}"${resultGame ? ` data-result-game="${esc(resultGame)}"` : ""}></a>
    </div>`;
}
