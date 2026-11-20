/**
 * Profile. Instagram's shape — cover, big avatar, a stat row, bio and
 * chips, then tabs — carrying LinkedIn's substance, because this is the
 * page a coach or scout lands on: identity, measurables, a verified
 * activity record, and links out.
 *
 * Tabs: Posts (the X-style list), Media (a 3-wide photo grid), Games
 * (hosted and played), Stats (venue ranks and claimed athlete records).
 * Above them: a pinned highlight video and an Instagram-style highlights
 * row built from the profile's links.
 */

import { $, $$, main, getUser, setUser, toast, ROLE_META, ICON, openSheet, showsUp, shareLink } from "./shared.js";
import {
  apiGet, apiSend, warm, loadMeta, esc, titleCase, whenLabel, timeAgo, sportIcon, avatar, uploadImage,
} from "./api.js";
import {
  postCard, skeletonPosts, bindPostList, followButton, bindFollowButtons, openLightbox, hydratePosts,
} from "./posts.js";
import { videoInfo, liteVideo, bindVideos, openVideoSheet } from "./video.js";
import { openVenueSheet } from "./venue.js";
import { openPaySheet } from "./money.js";
import { recordChip, markGames, paintCounts } from "./record.js";
import { annotateProfileGames } from "./events.js";
import { applyTeam, previewTeam, restoreTeam, teamPicker } from "./teams.js";

const heightStr = (inches) =>
  inches ? `${Math.floor(inches / 12)}'${inches % 12}"` : null;

/** The show-up chip beside the role badge; nothing for a new player. */
function showsUpChip(r) {
  const s = showsUp(r);
  if (!s) return "";
  return `<button class="rel-chip${s.low ? " is-low" : ""}" data-rel aria-haspopup="dialog">${ICON.check}${esc(s.text)}</button>`;
}

/** What the chip counts, in plain words; a tap works where a tooltip does not. */
function openShowsUpSheet(p) {
  const r = p.reliability;
  const { body } = openSheet({ id: "sheet-rel", title: "Shows up" });
  body.innerHTML = `
    <div class="rel-sheet">
      <p class="rel-big"><strong>${r.showed}</strong> of ${r.games} games</p>
      <p>${esc(p.name ?? "This player")} checked in at the venue for ${r.showed} of the ${r.games} games
        they still held a seat in when check-in closed.</p>
      <p class="rel-dim">Leaving a game before check-in closes doesn't count against anyone. Cancelled games aren't counted.</p>
    </div>`;
}

/** Fetch what your own profile's first paint asks for, ahead of opening it. */
export function warmProfile() {
  const me = getUser();
  if (!me) return;
  warm(`/api/users/${me.id}`);
  warm("/api/stories");
  warm(`/api/users/${me.id}/venues`);
  warm("/api/my/profile-views");
}

export function renderProfile(userId, { edit = false } = {}) {
  const me = getUser();
  if (!me) return;
  void load(userId || me.id, { edit });
}

async function load(userId, { edit = false } = {}) {
  main().innerHTML = `<div class="profile-page">${headerSkeleton()}</div>`;
  // Leaving before the answer arrives must not paint over the next page.
  const shell = main().firstElementChild;
  try {
    const [{ profile, posts }, stories, venues] = await Promise.all([
      apiGet(`/api/users/${userId}`),
      apiGet("/api/stories").then((r) => r.stories).catch(() => []),
      apiGet(`/api/users/${userId}/venues`).then((r) => r.venues).catch(() => []),
    ]);
    if (!shell.isConnected) return;
    const live = stories.some((s) => s.user.id === profile.id && s.live);
    paint(profile, posts, live, venues);
    if (edit && profile.isSelf) openEditor(profile);
  } catch (err) {
    if (shell.isConnected) main().innerHTML = `<div class="empty"><p>${esc(err.message)}</p></div>`;
  }
}

function headerSkeleton() {
  return `
    <div class="pf" aria-hidden="true">
      <div class="pf-cover skel" style="border-radius:0"></div>
      <div class="pf-head">
        <div class="pf-avatar-wrap"><div class="skel skel-circle avatar" style="width:132px;height:132px"></div></div>
        <div class="skel skel-line" style="width:40%;height:20px;margin-top:16px"></div>
        <div class="skel skel-line" style="width:60%"></div>
        <div class="skel skel-line" style="width:50%"></div>
      </div>
      ${skeletonPosts(2)}
    </div>`;
}

function paint(p, posts, live, venues) {
  const rm = ROLE_META[p.role] ?? {};
  const legend = venues.filter((v) => v.rank <= 3).slice(0, 2);
  const featured = p.highlightUrl ? videoInfo(p.highlightUrl) : null;
  const highlights = p.links.map((l) => ({ ...l, v: videoInfo(l.url) }));
  const chips = [
    p.primarySport && [sportIcon(p.primarySport), titleCase(p.primarySport)],
    p.position && ["", p.position],
    p.school && [ICON.school, p.school],
    p.classYear && ["", `Class of ${p.classYear}`],
    heightStr(p.heightInches) && ["", heightStr(p.heightInches)],
    p.weightLbs && ["", `${p.weightLbs} lb`],
    p.location && [ICON.pin, p.location],
  ].filter(Boolean);

  const cover = p.coverUrl
    ? `class="pf-cover has-img" style="--cover:url('${esc(p.coverUrl)}')"`
    : `class="pf-cover" data-role="${esc(p.role ?? "")}"`;

  main().innerHTML = `
    <div class="profile-page">
      <div class="pf">
        <div ${cover}></div>
        <header class="pf-head">
          <div class="pf-toprow">
            <div class="pf-avatar-wrap${live ? " live" : ""}" ${live ? `title="Playing now"` : ""}>${avatar(p, "lg")}</div>
            <div class="pf-actions">
              <button class="icon-btn" id="btn-share" aria-label="Share profile" title="Share profile">${ICON.share}</button>
              ${p.isSelf
                ? `<button class="btn-game btn-game-ghost" id="btn-edit">Edit profile</button>`
                : `<button class="btn-game btn-game-ghost" id="btn-pay">Pay</button>
                   ${followButton(p.id, p.isFollowing, { large: true })}`}
            </div>
          </div>

          <div class="pf-name-row">
            <h1 class="pf-name">${esc(p.name ?? "Unnamed")}</h1>
            ${rm.label ? `<span class="role-badge" data-role="${esc(p.role)}">${esc(rm.label)}</span>` : ""}
            <span id="pf-record-slot">${showsUpChip(p.reliability)}</span>
          </div>
          ${p.headline ? `<p class="pf-headline">${esc(p.headline)}</p>` : ""}

          <div class="pf-stats">
            <span class="pf-stat" title="Games checked in at the venue"><strong>${p.stats.gamesPlayed}</strong>played</span>
            <span class="pf-stat"><strong>${p.stats.gamesHosted}</strong>hosted</span>
            <span class="pf-stat"><strong id="pf-followers">${p.stats.followers}</strong>followers</span>
            <span class="pf-stat"><strong>${p.stats.following}</strong>following</span>
          </div>

          ${p.isSelf ? `<div class="pf-views" id="pf-views" hidden></div>` : ""}

          ${p.bio ? `<p class="pf-bio">${esc(p.bio)}</p>` : ""}

          ${chips.length || legend.length ? `
            <div class="pf-chips">
              ${legend.map((v) => `<button class="pf-chip pf-chip-legend${v.rank === 1 ? " is-top" : ""}" data-venue="${esc(v.venue.id)}">
                  ${v.rank === 1 ? ICON.crown : ""}<strong>#${v.rank}</strong>at ${esc(v.venue.name)}</button>`).join("")}
              ${chips.map(([icon, text]) => `<span class="pf-chip">${icon}<strong>${esc(text)}</strong></span>`).join("")}
            </div>` : ""}

          ${featured
            ? `<div class="pf-featured"><span class="pf-featured-label">${ICON.play} Featured highlight</span>${liteVideo(featured)}</div>`
            : p.highlightUrl
              ? `<a class="pf-chip pf-featured-link" href="${esc(p.highlightUrl)}" target="_blank" rel="noopener noreferrer nofollow">${ICON.play}Featured highlight</a>`
              : ""}

          ${highlights.length ? `
            <div class="hl-row" aria-label="Highlights and links">
              ${highlights.map((l, i) => `
                <button class="hl" data-hl="${i}" title="${esc(l.url)}">
                  <span class="hl-ring${l.v ? " is-video" : ""}">
                    ${l.v?.thumb ? `<img src="${esc(l.v.thumb)}" alt="" loading="lazy">` : l.v ? ICON.play : ICON.link}
                  </span>
                  <span class="hl-label">${esc(l.label || (l.v ? "Highlight" : "Link"))}</span>
                </button>`).join("")}
            </div>` : ""}

          ${p.isSelf && !p.bio && !chips.length
            ? `<p class="pf-note">Coaches and scouts land here. Add your sport, position and school so they know what they're looking at.</p>`
            : ""}
        </header>

        <nav class="pf-tabs" role="tablist">
          ${[["posts", ICON.list, "Posts"], ["media", ICON.grid, "Media"],
             ["games", ICON.ball, "Games"], ["stats", ICON.trophy, "Stats"]].map(([id, icon, label]) => `
            <button class="pf-tab${id === "posts" ? " active" : ""}" data-tab="${id}" role="tab"
                    aria-label="${label}">${icon}<span>${label}</span></button>`).join("")}
        </nav>
        <div class="pf-panel" id="pf-panel" data-tab="posts"></div>
      </div>
    </div>`;

  // The open tab lives on this page's own panel, not in the module: a kept
  // copy of your profile and a fresh render of someone else's must not share it.
  $$(".pf-tab").forEach((t) => t.addEventListener("click", () => {
    $("#pf-panel").dataset.tab = t.dataset.tab;
    $$(".pf-tab").forEach((x) => x.classList.toggle("active", x === t));
    void showTab(p, posts, venues);
  }));

  const head = $(".pf-head");
  bindVideos(head);
  head.addEventListener("click", (e) => {
    if (e.target.closest("[data-rel]")) { openShowsUpSheet(p); return; }
    const v = e.target.closest("[data-venue]");
    if (v) { void openVenueSheet(v.dataset.venue); return; }
    const h = e.target.closest("[data-hl]");
    if (!h) return;
    const l = highlights[Number(h.dataset.hl)];
    if (l.v?.embed) openVideoSheet(l.v, l.label);
    else window.open(l.url, "_blank", "noopener,noreferrer");
  });
  if (p.isSelf) void loadViews();

  $("#btn-share").addEventListener("click", () => void shareProfile(p));
  if (p.isSelf) $("#btn-edit").addEventListener("click", () => openEditor(p));
  $("#btn-pay")?.addEventListener("click", () => openPaySheet({ id: p.id, name: p.name, avatarUrl: p.avatarUrl }));
  // The record's own chip replaces the server's show-up chip once there is a record.
  void recordChip($("#pf-record-slot"), p, p.isSelf);
  // This page's root, never #main-content: that element outlives every page,
  // so whichever page bound it first would keep the only listener.
  bindFollowButtons($(".profile-page"), {
    onChange: (_, now) => {
      const el = $("#pf-followers");
      if (el) el.textContent = String(Math.max(0, Number(el.textContent) + (now ? 1 : -1)));
    },
  });
  bindPostList($("#pf-panel"));
  void showTab(p, posts, venues);
}

// ── who's looking (own profile only) ──────────────────────────────────

async function loadViews() {
  const box = $("#pf-views");
  if (!box) return;
  try {
    const v = await apiGet("/api/my/profile-views");
    if (!v.total) return;
    const rec = v.byRole.coach + v.byRole.scout;
    const faces = v.recruiters.slice(0, 3).map((r) => avatar(r, "xs", { href: `#/u/${r.id}` })).join("");
    box.innerHTML = `
      <button type="button" class="pf-views-open">
        <span class="pf-views-icon">${ICON.trendUp}</span>
        <span class="pf-views-text">
          <strong>${v.total} profile view${v.total === 1 ? "" : "s"}</strong>
          <span>${rec ? `${v.byRole.coach} coach${v.byRole.coach === 1 ? "" : "es"} · ${v.byRole.scout} scout${v.byRole.scout === 1 ? "" : "s"} · ` : ""}last ${v.windowDays} days</span>
        </span>
      </button>
      ${faces ? `<span class="notif-faces">${faces}</span>` : ""}`;
    box.hidden = false;
    box.querySelector(".pf-views-open").addEventListener("click", () => openViewsSheet(v));
  } catch { /* optional */ }
}

function openViewsSheet(v) {
  const { body } = openSheet({ id: "views-sheet", title: "Who viewed your profile" });
  const other = v.byRole.player + v.byRole.other;
  body.innerHTML = `
    <div class="views-summary">
      <div><strong>${v.total}</strong><span>views</span></div>
      <div><strong>${v.byRole.coach}</strong><span>coaches</span></div>
      <div><strong>${v.byRole.scout}</strong><span>scouts</span></div>
      <div><strong>${other}</strong><span>players &amp; others</span></div>
    </div>
    ${v.recruiters.length
      ? v.recruiters.map((r) => `
          <a class="widget-row" href="#/u/${esc(r.id)}">
            ${avatar(r, "sm")}
            <span class="widget-text">
              <strong>${esc(r.name ?? "Someone")}</strong>
              <span class="widget-sub">${esc([titleCase(r.role ?? ""), r.headline].filter(Boolean).join(" · "))}</span>
            </span>
            <span class="widget-sub">${esc(timeAgo(r.viewedAt))}</span>
          </a>`).join("")
      : `<p class="empty-inline">No coaches or scouts yet. Complete your profile and post highlights to get seen.</p>`}
    <p class="pf-note">Only coaches and scouts are shown by name. Other visitors are counted but never named,
      and nobody under 18 is ever identified as a viewer.</p>`;
}

const shareProfile = (p) => shareLink({ title: p.name ?? "SportsArc", url: `${location.origin}/#/u/${p.id}` });

// ── tabs ──────────────────────────────────────────────────────────────

async function showTab(p, posts, venues = []) {
  const panel = $("#pf-panel");
  if (!panel) return;
  const tab = panel.dataset.tab;

  if (tab === "posts") {
    panel.innerHTML = posts.length
      ? `<div class="feed-list">${posts.map(postCard).join("")}</div>`
      : empty("No posts yet", p.isSelf ? "Share a highlight, a result, or where you're playing next." : "");
    hydratePosts(panel);
    return;
  }

  if (tab === "media") {
    const withImages = posts.filter((x) => x.images?.length);
    panel.innerHTML = withImages.length
      ? `<div class="media-grid">${withImages.map((x) => `
          <button class="media-tile" data-src="${esc(x.images[0])}" aria-label="Open photo">
            <img src="${esc(x.images[0])}" alt="" loading="lazy" decoding="async">
            ${x.images.length > 1 ? `<span class="media-tile-multi">${ICON.stack}</span>` : ""}
            <span class="media-tile-meta">${ICON.heart}${x.likeCount}</span>
          </button>`).join("")}</div>`
      : empty("No photos yet", p.isSelf ? "Photos you post show up here as a grid." : "");
    panel.querySelectorAll(".media-tile").forEach((t) =>
      t.addEventListener("click", () => openLightbox(t.dataset.src)));
    return;
  }

  if (tab === "games") {
    panel.innerHTML = `<div class="pf-panel-pad">${skeletonPosts(2)}</div>`;
    try {
      const { games } = await apiGet(`/api/users/${p.id}/games`);
      if (panel.dataset.tab !== "games") return;
      const now = Date.now();
      panel.innerHTML = games.length
        ? `<div class="pf-panel-pad">${games.map((g) => {
            const upcoming = new Date(g.startsAt).getTime() > now;
            return `
              <a class="game-card" data-pf-game="${esc(g.id)}" href="#/games/${esc(g.id)}" style="color:inherit">
                <div class="game-icon">${sportIcon(g.sport)}</div>
                <div class="game-body">
                  <div class="game-line1">
                    <span class="game-sport">${esc(titleCase(g.sport))}</span>
                    ${g.host.id === p.id ? `<span class="game-badge">Host</span>` : ""}
                    ${upcoming ? `<span class="game-badge game-badge-in">Upcoming</span>` : ""}
                  </div>
                  <div class="game-when">${esc(whenLabel(g.startsAt))}</div>
                  <div class="game-where">${esc(g.venue.name)}</div>
                </div>
              </a>`;
          }).join("")}</div>`
        : empty("No games yet", p.isSelf ? "Games you host or join will appear here." : "");
      if (games.length) void annotateProfileGames(panel);
      if (games.length && p.isSelf) void markGames(panel);
    } catch (err) {
      panel.innerHTML = empty("Could not load games", err.message);
    }
    return;
  }

  // stats
  panel.innerHTML = `<div class="pf-panel-pad">${skeletonPosts(1)}</div>`;
  try {
    const { records } = await apiGet(`/api/users/${p.id}/records`);
    if (panel.dataset.tab !== "stats") return;
    const courts = venues.length ? `
      <div class="record-card">
        <div class="record-head">
          <div><div class="record-title">${ICON.crown} Home courts</div>
          <div class="record-sub">Rank by check-ins at the venue, last 90 days</div></div>
        </div>
        ${venues.map((v) => `
          <button class="court-row" data-venue="${esc(v.venue.id)}">
            <span class="court-rank${v.rank === 1 ? " is-top" : ""}">#${v.rank}</span>
            <span class="court-name"><strong>${esc(v.venue.name)}</strong><span>of ${v.of} regulars</span></span>
            <span class="court-count"><strong>${v.checkIns}</strong> check-in${v.checkIns === 1 ? "" : "s"}</span>
          </button>`).join("")}
      </div>` : "";
    panel.innerHTML = records.length || courts
      ? `<div class="pf-panel-pad">${courts}${records.map(recordCard).join("")}
           ${records.length ? `<p class="pf-note">Stat lines are imported from public sources and claimed by this user. Not yet verified.</p>` : ""}</div>`
      : empty("No stats yet",
          p.isSelf ? "Check in at games to rank at your courts." : "");
  } catch (err) {
    panel.innerHTML = empty("Could not load stats", err.message);
  }
}

function recordCard(r) {
  const entries = Object.entries(r.stats ?? {}).slice(0, 12);
  return `
    <div class="record-card">
      <div class="record-head">
        <div>
          <div class="record-title">${sportIcon(r.sport)} ${esc(titleCase(r.sport))}${r.position ? ` · ${esc(r.position)}` : ""}</div>
          <div class="record-sub">${esc([r.school?.name, r.school?.state, r.classYear && `Class of ${r.classYear}`].filter(Boolean).join(" · "))}</div>
        </div>
        ${r.sourceUrl ? `<a class="record-sub" href="${esc(r.sourceUrl)}" target="_blank" rel="noopener noreferrer nofollow">Source: ${esc(r.source)}</a>`
                      : `<span class="record-sub">Source: ${esc(r.source)}</span>`}
      </div>
      ${entries.length ? `<div class="record-stats">${entries.map(([k, v]) => `
        <div class="stat-tile"><strong>${esc(v)}</strong><span>${esc(k)}</span></div>`).join("")}</div>` : ""}
    </div>`;
}

const empty = (title, sub) =>
  `<div class="empty empty-sm"><strong>${esc(title)}</strong>${sub ? esc(sub) : ""}</div>`;

// ── editor ────────────────────────────────────────────────────────────

async function openEditor(p) {
  if ($("#profile-sheet")) return;
  const META = await loadMeta().catch(() => ({ sports: [] }));

  const sportOpts = ['<option value="">—</option>']
    .concat((META.sports ?? []).map((s) =>
      `<option value="${s}" ${s === p.primarySport ? "selected" : ""}>${titleCase(s)}</option>`))
    .join("");

  const linkRows = (p.links.length ? p.links : [{ label: "", url: "" }, { label: "", url: "" }])
    .slice(0, 5)
    .map((l) => `
      <div class="link-row">
        <input class="link-label" placeholder="Label" value="${esc(l.label)}" maxlength="40" aria-label="Link label">
        <input class="link-url" placeholder="https://…" value="${esc(l.url)}" maxlength="300" inputmode="url" aria-label="Link URL">
      </div>`).join("");

  const state = { avatarUrl: p.avatarUrl, coverUrl: p.coverUrl, team: p.team ?? null, saved: false };

  // Picking a team previews it on the whole app; closing without Save puts the old one back.
  const { sheet, body, foot, close } = openSheet({
    id: "profile-sheet", title: "Edit profile", footer: true,
    onClose: () => { if (!state.saved) restoreTeam(); },
  });
  // Save sits in the sheet's footer and submits the form by its id.
  foot.innerHTML = `<button type="submit" form="profile-form" class="btn-game" id="profile-save" data-primary>Save</button>`;
  body.innerHTML = `
      <form id="profile-form">
        <div class="pf-edit-media">
          <div class="pf-edit-cover" id="edit-cover"></div>
          <label class="pf-edit-btn" style="position:absolute;inset:0;margin:auto" title="Change cover">
            ${ICON.camera}<input type="file" accept="image/jpeg,image/png,image/webp" hidden data-kind="coverUrl">
          </label>
          <div class="pf-edit-avatar">
            <span id="edit-avatar">${avatar({ ...p, ...state }, "lg")}</span>
            <label class="pf-edit-btn" title="Change photo">
              ${ICON.camera}<input type="file" accept="image/jpeg,image/png,image/webp" hidden data-kind="avatarUrl">
            </label>
          </div>
        </div>

        <div class="host-grid">
          <label class="host-wide">Headline
            <input name="headline" value="${esc(p.headline ?? "")}" maxlength="255"
                   placeholder="e.g. Point guard · El Monte High"></label>
          <label class="host-wide">Bio
            <textarea name="bio" rows="3" maxlength="600"
              placeholder="What should a coach know about you?">${esc(p.bio ?? "")}</textarea></label>
        </div>

        <div class="pf-edit-section">Athlete details</div>
        <div class="host-grid">
          <label>Sport<select name="primarySport">${sportOpts}</select></label>
          <label>Position<input name="position" value="${esc(p.position ?? "")}" maxlength="32"></label>
          <label>School<input name="school" value="${esc(p.school ?? "")}" maxlength="160"></label>
          <label>Class year<input name="classYear" value="${esc(p.classYear ?? "")}" maxlength="16" inputmode="numeric"></label>
          <label>Height (in)<input name="heightInches" type="number" min="36" max="96" inputmode="numeric"
                 value="${p.heightInches ?? ""}"></label>
          <label>Weight (lb)<input name="weightLbs" type="number" min="50" max="500" inputmode="numeric"
                 value="${p.weightLbs ?? ""}"></label>
          <label class="host-wide">Location
            <input name="location" value="${esc(p.location ?? "")}" maxlength="120"
                   placeholder="e.g. San Gabriel Valley, CA"></label>
        </div>

        <div class="pf-edit-section">Team</div>
        <p class="pf-team-note">The app wears your team's colors. College football for now.</p>
        <div id="edit-team"></div>

        <div class="pf-edit-section">Highlights</div>
        <div class="host-grid">
          <label class="host-wide">Featured highlight
            <input name="highlightUrl" value="${esc(p.highlightUrl ?? "")}" maxlength="300" inputmode="url"
                   placeholder="YouTube, Vimeo or Hudl link — pinned under your bio"></label>
        </div>

        <div class="pf-edit-section">Links</div>
        <p class="pf-note" style="margin:-4px 0 10px">Video links show up as highlight circles on your profile.</p>
        <div id="link-rows">${linkRows}</div>
      </form>`;

  const paintCover = () => {
    const c = $("#edit-cover");
    c.style.backgroundImage = state.coverUrl ? `url("${state.coverUrl}")` : "";
    c.dataset.role = p.role ?? "";
    c.className = state.coverUrl ? "pf-edit-cover" : "pf-edit-cover pf-cover";
  };
  paintCover();

  teamPicker($("#edit-team", sheet), {
    selected: state.team,
    allowNone: true,
    onPick: (team) => { state.team = team; previewTeam(team); },
  });

  sheet.querySelectorAll('input[type="file"]').forEach((input) =>
    input.addEventListener("change", async () => {
      const f = input.files[0];
      input.value = "";
      if (!f) return;
      const kind = input.dataset.kind;
      const save = $("#profile-save");
      save.disabled = true;
      toast("Uploading…");
      try {
        state[kind] = await uploadImage(f);
        if (kind === "coverUrl") paintCover();
        else $("#edit-avatar").innerHTML = avatar({ ...p, ...state }, "lg");
      } catch (err) {
        toast(err.message);
      } finally {
        save.disabled = false;
      }
    }));

  $("#profile-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("#profile-save");
    btn.disabled = true;
    const f = new FormData(e.target);
    const links = $$("#link-rows .link-row")
      .map((row) => ({
        label: row.querySelector(".link-label").value.trim(),
        url: row.querySelector(".link-url").value.trim(),
      }))
      .filter((l) => l.url);
    try {
      await apiSend("/api/profile", "PATCH", {
        headline: f.get("headline"),
        primarySport: f.get("primarySport"),
        position: f.get("position"),
        school: f.get("school"),
        classYear: f.get("classYear"),
        heightInches: f.get("heightInches"),
        weightLbs: f.get("weightLbs"),
        location: f.get("location"),
        bio: f.get("bio"),
        links,
        highlightUrl: f.get("highlightUrl"),
        avatarUrl: state.avatarUrl ?? null,
        coverUrl: state.coverUrl ?? null,
        teamKey: state.team?.key ?? null,
      });
      state.saved = true;
      applyTeam(state.team);
      const me = getUser();
      if (me) {
        setUser({ ...me, avatarUrl: state.avatarUrl ?? null, headline: f.get("headline") || "" });
        document.dispatchEvent(new CustomEvent("sportsarc:user-changed"));
      }
      close();
      toast("Profile saved");
      await load(p.id);
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
    }
  });
}

// ── people directory ──────────────────────────────────────────────────

/** The unfiltered directory, ahead of the viewer opening it (searchPeople sends {}). */
export function warmPeople() {
  warm("/api/people", {});
}

export function renderPeople() {
  if (!getUser()) return;
  main().innerHTML = `
    <div class="profile-page">
      <div class="games-head">
        <div>
          <h3 class="games-title">Find people</h3>
          <p class="games-sub">Players, coaches and scouts on SportsArc.</p>
        </div>
      </div>
      <div class="games-filters">
        <input class="chip chip-input" id="people-q" placeholder="Name, school or area" type="search" enterkeyhint="search">
        <select class="chip chip-select" id="people-role">
          <option value="">All roles</option>
        </select>
      </div>
      <div id="people-list" class="people-list">${skeletonPosts(4)}</div>
    </div>`;

  // This page's own state: its lookups and its newest search.
  const root = main().querySelector(".profile-page");
  const pg = { $: (sel) => root.querySelector(sel), seq: 0 };
  let timer;
  const run = () => { clearTimeout(timer); timer = setTimeout(() => void searchPeople(pg), 250); };
  pg.$("#people-q").addEventListener("input", run);
  pg.$("#people-role").addEventListener("change", run);
  bindFollowButtons(pg.$("#people-list"));
  void fillRoles(pg);
  void searchPeople(pg);
}

/** Roles come from /api/meta so the list cannot drift from USER_ROLES. */
async function fillRoles(pg) {
  const sel = pg.$("#people-role");
  if (!sel) return;
  try {
    const META = await loadMeta();
    sel.innerHTML = `<option value="">All roles</option>` +
      (META.roles ?? []).map((r) => `<option value="${r}">${titleCase(r)}s</option>`).join("");
  } catch { /* the filter still works without it, just unfiltered */ }
}

/** Answers can arrive out of order ("ab" after "abc"); only the newest search paints. */
async function searchPeople(pg) {
  const list = pg.$("#people-list");
  if (!list) return;
  const seq = ++pg.seq;
  const params = {};
  const q = pg.$("#people-q")?.value.trim();
  const role = pg.$("#people-role")?.value;
  if (q) params.q = q;
  if (role) params.role = role;
  try {
    const { people } = await apiGet("/api/people", params);
    if (seq !== pg.seq) return;
    list.innerHTML = people.length
      ? people.map(personRow).join("")
      : `<div class="empty"><p>Nobody matches that yet.</p></div>`;
    void paintCounts(list, people.map((p) => p.id));
  } catch (err) {
    if (seq === pg.seq) list.innerHTML = `<p class="feed-loading">${esc(err.message)}</p>`;
  }
}

function personRow(p) {
  const me = getUser();
  const bits = [p.primarySport && titleCase(p.primarySport), p.position, p.school, p.location]
    .filter(Boolean).join(" · ");
  return `
    <a class="person-row" href="#/u/${esc(p.id)}">
      ${avatar(p, "sm")}
      <span class="person-body">
        <strong>${esc(p.name ?? "Unnamed")}</strong>
        ${p.headline ? `<span class="person-headline">${esc(p.headline)}</span>` : ""}
        ${bits ? `<span class="person-bits">${esc(bits)}</span>` : ""}
        <span data-rec-person="${esc(p.id)}"></span>
      </span>
      ${me && p.id !== me.id ? followButton(p.id, p.isFollowing) : `<span class="person-stat">${p.stats.gamesPlayed} played</span>`}
    </a>`;
}
