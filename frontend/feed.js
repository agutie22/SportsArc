/**
 * Home. LinkedIn's three-column frame — your card left, widget rail right
 * — around an X-style feed: sticky Following/Latest tabs, a stories row of
 * people you follow who are playing today, short posts with photos,
 * replies and likes, reverse-chronological with infinite scroll.
 *
 * Below 900px the rails disappear and their most useful parts — your
 * games, games near you, and people to follow — come back as swipeable
 * cards inside the feed, so a phone loses nothing.
 *
 * The rails are role-aware. A player is pointed at coaches and scouts, a
 * coach and a scout at players, and each role leads with the widget that
 * matters most to it.
 *
 * A game linked from anywhere on Home opens in a modal (game-preview.js)
 * where it can be joined, with Open in Games as the way through.
 */

import {
  main, getUser, toast, ROLE_META, ICON, shortAddr, balanceText,
  explorerUrlFor, bindCopyButtons,
} from "./shared.js";
import {
  apiGet, warm, esc, firstName, titleCase, whenLabel, timeAgo, sportIcon, avatar, lastCoords, locate, personLink,
} from "./api.js";
import {
  postCard, skeletonPosts, bindPostList, followButton, bindFollowButtons, hydratePosts,
} from "./posts.js";
import { mountComposer } from "./compose.js";
import { openGamePreview } from "./game-preview.js";
import { gameGlance } from "./game-card.js";
import { meRecordLine } from "./record.js";
import { listHomeSections, takeHomeAsk } from "./modules.js";

// Preferences, shared by every render: the feed tab. (The location is
// api.js lastCoords(), shared with Games.)
let SCOPE = "home";

/**
 * What one rendered Home shows. Home has one route, so one copy is live at
 * a time: H is it, replaced by every render (a double-tap reload, a kept
 * page that expired). Async work takes the H it started under and drops
 * its answer if H has moved on, so a discarded page's late answer never
 * lands on the new one. The page's lookups go through h.$, which also
 * finds the page while the tab cache holds it out of the document.
 */
let H = null;

function newHome(root) {
  return {
    root,
    $: (sel) => root.querySelector(sel),
    sectionsMounted: false, // module sections filled in (see mountHomeSections)
    nextBefore: null,       // the feed's cursor
    seq: 0,                 // the newest feed load wins; a reset replaces one in flight
    paging: false,          // a "more" load in flight
    observer: null,         // infinite scroll
    visible: new Set(),     // sections whose visible() said yes on this page
    lastPeople: [],
    lastPlayed: [],
    lastMine: [],
  };
}

/** Which rails a role sees, in order, and what to call them. */
const RAILS = {
  player: [
    ["myGames", "Your games"],
    ["nearby", "Games near you"],
    ["people", "Coaches & scouts"],
  ],
  coach: [
    ["myGames", "Your games"],
    ["people", "Players to know"],
    ["nearby", "Games near you"],
  ],
  scout: [
    ["people", "Players to watch"],
    ["nearby", "Games to scout"],
    ["myGames", "Your games"],
  ],
};

/** Profile fields that make a profile worth landing on, for the meter. */
const COMPLETENESS = [
  "avatarUrl", "coverUrl", "headline", "bio", "primarySport", "position", "school", "location",
];

// A post made from the bottom-bar sheet lands while Home may be on screen.
document.addEventListener("sportsarc:posted", () => {
  if (H?.root.isConnected) void load({ reset: true });
});

export function renderHome() {
  const user = getUser();
  if (!user) return;

  // A module tab is never the starting tab: it only opens once its section says it is visible.
  if (!FEED_SCOPES.has(SCOPE)) SCOPE = "home";

  main().innerHTML = `
    <div class="home-page">
      <div class="feed-layout">
        <aside class="feed-left" aria-label="Your profile">${meCard(user)}</aside>

        <section class="feed-center" aria-label="Feed">
          <div class="feed-tabs" role="tablist">
            <button class="feed-tab ${SCOPE === "home" ? "active" : ""}" data-scope="home" role="tab">Following</button>
            <button class="feed-tab ${SCOPE === "latest" ? "active" : ""}" data-scope="latest" role="tab">Latest</button>
            ${listHomeSections().filter((s) => s.feedTab).map((s) => `
              <button class="feed-tab" data-scope="mod:${esc(s.id)}" role="tab" hidden>${esc(s.feedTab.label)}</button>`).join("")}
          </div>
          <div class="home-feed" id="home-feed">
            <div class="stories" id="stories" aria-label="Playing today">${storiesSkeleton()}</div>
            <div id="composer-slot"></div>
            <div class="mobile-widgets" id="mobile-widgets"></div>
            <div class="mobile-rail" id="mobile-rail"></div>
            <div id="feed-list" class="feed-list">${skeletonPosts()}</div>
            <div id="feed-more"></div>
          </div>
          <div class="home-module" id="home-module" hidden></div>
        </section>

        <aside class="feed-right" id="feed-right" aria-label="Suggestions">
          <div class="feed-rails" id="feed-rails"></div>
          <div class="feed-rails" id="home-module-rail" hidden></div>
        </aside>
      </div>
    </div>`;
  const h = H = newHome(main().querySelector(".home-page"));

  // A game link on Home opens the preview; a modified click (new tab) still follows the link.
  h.root.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest('a[href^="#/games/"]');
    const id = a?.getAttribute("href").slice("#/games/".length);
    if (!id || id.includes("/")) return;
    e.preventDefault();
    // After a join, leave or check-in, Home's stories, rails and card catch up.
    openGamePreview(id, {
      onChange: () => { void loadStories(); void loadMeCard(); void loadRails(getUser()?.role); },
    });
  });

  h.root.querySelectorAll(".feed-tab").forEach((t) =>
    t.addEventListener("click", () => {
      if (t.dataset.scope === SCOPE) { window.scrollTo({ top: 0, behavior: "smooth" }); return; }
      if (t.dataset.scope.startsWith("mod:")) { openModuleTab(t.dataset.scope.slice(4)); return; }
      const fromModule = !FEED_SCOPES.has(SCOPE);
      SCOPE = t.dataset.scope;
      showFeed(h);
      void load({ reset: true, skeleton: true });
      if (fromModule) void loadStories();
    }));

  mountComposer(h.$("#composer-slot"));
  bindPostList(h.$("#feed-list"));
  bindFollowButtons(h.$(".feed-layout"));

  void load({ reset: true });
  void loadStories();
  void loadMeCard();
  renderCardWallet(h);
  void loadRails(user.role);
  void mountHomeSections();
}

// ── module sections (modules.js registerHomeSection), e.g. Pro markets ──

/** The feed's own tabs; anything else in SCOPE is "mod:<id>". */
const FEED_SCOPES = new Set(["home", "latest"]);

/**
 * Ask each section whether it shows, then fill its slots. A section that
 * fails or says no leaves no trace; Home renders the same without it.
 */
async function mountHomeSections() {
  const sections = listHomeSections();
  const h = H;
  if (!sections.length || !h || h.sectionsMounted) return;
  const page = h.root;
  const shown = await Promise.all(sections.map(async (s) => {
    try { return (await (s.visible?.() ?? true)) ? s : null; } catch { return null; }
  }));
  // Sections may look themselves up in the document, so they mount only on
  // screen; a page set aside meanwhile mounts them when it is resumed.
  if (h !== H || h.sectionsMounted || !page.isConnected) return;
  h.sectionsMounted = true;
  h.visible = new Set(shown.filter(Boolean).map((s) => s.id));
  for (const s of shown) {
    if (!s) continue;
    try {
      if (s.meCard) {
        const el = document.createElement("div");
        el.className = "me-card-module";
        h.$("#pc-wallet")?.after(el);
        s.meCard(el);
      }
      if (s.widget) paintModuleWidget(s);
      if (s.feedTab) page.querySelector(`.feed-tab[data-scope="mod:${CSS.escape(s.id)}"]`)?.removeAttribute("hidden");
    } catch (err) {
      console.error(`[home] section ${s.id} failed:`, err);
    }
  }
  takeAsk();
}

/** One column: no rail, so a section's widget sits above the feed instead. */
const ONE_COLUMN = "(max-width: 900px)";

/**
 * A section's rail widget, first in the rail. Re-run when the rails repaint.
 * On one column it goes above the feed (#mobile-widgets), where the rail
 * would have shown it.
 */
function paintModuleWidget(s, h = H) {
  const box = matchMedia(ONE_COLUMN).matches ? h?.$("#mobile-widgets") : h?.$("#feed-rails");
  if (!box || box.querySelector(`[data-home-section="${CSS.escape(s.id)}"]`)) return;
  const section = document.createElement("section");
  section.className = "widget";
  section.dataset.homeSection = s.id;
  section.innerHTML = `<h4 class="widget-title">${esc(s.widget.title)}</h4><div class="widget-body"></div>`;
  box.prepend(section);
  s.widget.render(section.querySelector(".widget-body"), section);
}

function markTab(h) {
  h.root.querySelectorAll(".feed-tab").forEach((x) => x.classList.toggle("active", x.dataset.scope === SCOPE));
}

function showFeed(h) {
  markTab(h);
  h.$("#home-feed").hidden = false;
  h.$("#home-module").hidden = true;
  h.$("#feed-rails").hidden = false;
  h.$("#home-module-rail").hidden = true;
}

/** Open a section's feed tab: its view replaces stories, composer and posts. */
function openModuleTab(id, view = null) {
  const h = H;
  const s = listHomeSections().find((x) => x.id === id && x.feedTab);
  if (!s || !h?.visible.has(id) || !h.$("#home-module")) return;
  SCOPE = `mod:${id}`;
  markTab(h);
  const el = h.$("#home-module");
  const rail = h.$("#home-module-rail");
  h.$("#home-feed").hidden = true;
  el.hidden = false;
  h.$("#feed-rails").hidden = true;
  rail.hidden = false;
  // The feed is out of view: no paging behind the module's back, and a load in flight is dropped.
  stopFeed(h);
  try {
    s.feedTab.render(el, rail, view);
  } catch (err) {
    console.error(`[home] tab ${id} failed:`, err);
    el.innerHTML = `<p class="feed-loading">${esc(err?.message ?? "Could not load this tab.")}</p>`;
  }
}

/** A link like #/markets/picks asked for a module tab (modules.js askHomeTab). */
function takeAsk() {
  const ask = takeHomeAsk();
  if (ask) openModuleTab(ask.tab, ask.view);
}

// ── left: the "me" card ───────────────────────────────────────────────

function meCard(user) {
  const rm = ROLE_META[user.role] ?? {};
  return `
    <div class="me-card">
      <div class="me-card-cover" id="me-cover" data-role="${esc(user.role)}"></div>
      <div class="me-card-body">
        ${avatar(user, "lg", { cls: "me-card-avatar", href: "#/profile" })}
        <a class="me-card-name" href="#/profile">${esc(user.name)}</a>
        <p class="me-card-headline">${esc(user.headline || "")}</p>
        ${rm.full ? `<span class="role-badge" data-role="${esc(user.role)}">${esc(rm.full)}</span>` : ""}
        <div class="me-card-stats" id="me-stats">
          ${["Played", "Followers", "Following"].map((l) => `
            <div class="me-card-stat"><strong>·</strong><span>${l}</span></div>`).join("")}
        </div>
        <div id="me-record"></div>
        <div id="me-meter"></div>
      </div>
      <a class="me-card-views" id="me-views" href="#/profile" hidden></a>
      <div class="me-card-wallet" id="pc-wallet"></div>
      <nav class="me-card-links">
        <a class="me-card-link" href="#/games">${ICON.ball}<span>My games</span></a>
        <a class="me-card-link" href="#/people">${ICON.people}<span>Find people</span></a>
        <a class="me-card-link" href="#/profile">${ICON.user}<span>View profile</span></a>
      </nav>
    </div>`;
}

/** Live counts and completeness; the card reads fine without them. */
async function loadMeCard() {
  const h = H;
  const user = getUser();
  if (!user || !h) return;
  try {
    const { profile } = await apiGet(`/api/users/${user.id}`);
    const stats = h.$("#me-stats");
    if (h !== H || !stats) return;
    stats.innerHTML = [
      [profile.stats.gamesPlayed, "Played"],
      [profile.stats.followers, "Followers"],
      [profile.stats.following, "Following"],
    ].map(([v, l]) => `<div class="me-card-stat"><strong>${v}</strong><span>${l}</span></div>`).join("");

    if (profile.coverUrl) {
      const cover = h.$("#me-cover");
      cover.classList.add("has-img");
      cover.style.setProperty("--cover", `url("${profile.coverUrl}")`);
    }

    void loadViews(h);
    void meRecordLine(h.$("#me-record"), user.id);

    const done = COMPLETENESS.filter((k) => profile[k]).length;
    const pct = Math.round((done / COMPLETENESS.length) * 100);
    // Rewritten either way, so a refresh after finishing the profile drops the meter.
    h.$("#me-meter").innerHTML = pct >= 100 ? "" : `
        <div class="me-card-meter">
          <div class="me-card-meter-top">
            <span>Profile ${pct}% complete</span><a href="#/profile/edit">Finish</a>
          </div>
          <div class="progress-bar progress-accent"><div class="progress-fill" style="width:${pct}%"></div></div>
        </div>`;
  } catch { /* the card still reads fine without live counts */ }
}

/** "23 profile views · 3 coaches" — the recruiting signal, on your card. */
async function loadViews(h) {
  try {
    const v = await apiGet("/api/my/profile-views");
    const el = h.$("#me-views");
    if (h !== H || !el || !v.total) return;
    const rec = v.byRole.coach + v.byRole.scout;
    el.innerHTML = `${ICON.trendUp}
      <span><strong>${v.total}</strong> profile view${v.total === 1 ? "" : "s"}
      ${rec ? `· <em>${rec} coach${rec === 1 ? "" : "es"} &amp; scouts</em>` : ""}</span>
      <small>${v.windowDays}d</small>`;
    el.hidden = false;
  } catch { /* optional */ }
}

/**
 * Wallet on the "me" card. Collapsed it shows the two things worth
 * glancing at — balance and address. Expanded it adds the full address,
 * copy and explorer, so the wallet needs no separate screen.
 */
function renderCardWallet(h) {
  const box = h.$("#pc-wallet");
  const user = getUser();
  if (!box || !user) return;

  const addr = user.circle?.walletAddress ?? "";
  if (!addr) {
    box.innerHTML = `
      <button class="pc-wallet-empty" id="pc-wallet-setup">Set up your wallet</button>
      <p class="pc-wallet-hint">Send and receive money from your wallet.</p>`;
    h.$("#pc-wallet-setup").addEventListener("click", () => {
      toast("Opening wallet setup…");
      document.dispatchEvent(new CustomEvent("sportsarc:wallet-setup"));
    });
    return;
  }

  box.innerHTML = `
    <div class="pc-wallet-wrap">
      <button class="pc-wallet" id="pc-wallet-btn" aria-expanded="false" aria-controls="pc-wallet-more">
        <span class="pc-wallet-bal" data-wallet-balance>${esc(balanceText())}</span>
        <span class="pc-wallet-right">
          <code class="pc-wallet-addr">${esc(shortAddr(addr))}</code>
          <svg class="pc-wallet-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
        </span>
      </button>
      <div class="pc-wallet-more" id="pc-wallet-more" hidden>
        <div class="pc-wallet-row">
          <span class="pc-wallet-key">Address</span>
          <span class="pc-wallet-val"><code>${esc(shortAddr(addr, 10, 6))}</code></span>
        </div>
        <div class="pc-wallet-actions">
          <button class="pc-wallet-act" data-copy="${esc(addr)}">${ICON.copy}<span>Copy</span></button>
          <a class="pc-wallet-act" href="${esc(explorerUrlFor(addr, { kind: "address" }))}"
             target="_blank" rel="noopener noreferrer">${ICON.external}<span>Explorer</span></a>
        </div>
      </div>
    </div>`;

  const btn = h.$("#pc-wallet-btn");
  const more = h.$("#pc-wallet-more");
  btn.addEventListener("click", () => {
    const open = more.hidden;
    more.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
    btn.classList.toggle("pc-wallet-open", open);
  });
  bindCopyButtons(box);
}

// ── stories: who you follow is playing today ──────────────────────────

function storiesSkeleton() {
  return Array.from({ length: 5 }, () => `
    <div class="story" aria-hidden="true">
      <div class="skel skel-circle" style="width:66px;height:66px"></div>
      <div class="skel skel-line" style="width:48px;margin:0"></div>
    </div>`).join("");
}

/**
 * Fetch what Home's first paint asks for, ahead of the viewer opening it.
 * The nearby-games rail waits on geolocation and is left to load itself.
 */
export function warmHome() {
  const user = getUser();
  if (!user) return;
  warm("/api/feed", { scope: FEED_SCOPES.has(SCOPE) ? SCOPE : "home", limit: 20 });
  warm("/api/stories");
  warm(`/api/users/${user.id}`);
  warm("/api/my/profile-views");
  warm("/api/my/games");
  warm("/api/people/played-with");
  warm("/api/people/suggested");
}

/** Home shown again from the tab cache: the feed stays put, "playing today" refreshes. */
export function resumeHome() {
  void loadStories();
  // Sections that were still deciding when the page was set aside mount now.
  if (H && !H.sectionsMounted) void mountHomeSections();
  takeAsk();
}

async function loadStories() {
  const h = H;
  const row = h?.$("#stories");
  if (!row) return;
  const host = `
    <a class="story story-host" href="#/games">
      <span class="story-ring">${ICON.plus}</span>
      <span class="story-name">Host</span>
    </a>`;
  try {
    const { stories } = await apiGet("/api/stories");
    if (h !== H) return;
    row.innerHTML = host + stories.map((s) => {
      const first = firstName(s.user.name);
      const label = s.live ? "Playing now" : whenLabel(s.game.startsAt);
      return `
        <div class="story">
          <a class="story-ring ${s.live ? "live" : "upcoming"}" href="#/games/${esc(s.game.id)}"
             title="${esc(`${s.user.name ?? "Someone"} · ${titleCase(s.game.sport)} at ${s.game.venueName} · ${label}`)}">
            ${avatar(s.user, "md")}
          </a>
          ${s.live ? `<span class="story-live">LIVE</span>` : ""}
          <span class="story-name">${sportIcon(s.game.sport)} ${personLink(s.user, { label: first })}</span>
        </div>`;
    }).join("");
  } catch {
    if (h === H) row.innerHTML = host;
  }
}

// ── right rail, and its inline twin for one-column layouts ────────────

async function loadRails(role) {
  const h = H;
  const rail = h?.$("#feed-rails");
  if (!rail) return;
  const plan = [["playedWith", "Played with you"], ...(RAILS[role] ?? RAILS.player)];
  rail.innerHTML = plan
    .map(([id, title]) => `
      <section class="widget" id="w-${id}">
        <h4 class="widget-title">${esc(title)}</h4>
        <div class="widget-body">${railSkeleton()}</div>
      </section>`).join("");
  // A section's widget (e.g. Tonight on Gemini) goes back on top if its visible() already said yes.
  for (const s of listHomeSections()) if (s.widget && h.visible.has(s.id)) paintModuleWidget(s, h);

  const titles = Object.fromEntries(plan);
  const [people, nearby, played, mine] = await Promise.all([fillPeople(h), fillNearby(h), fillPlayedWith(h), fillMyGames(h)]);
  if (h !== H) return;
  h.lastPeople = people;
  h.lastPlayed = played;
  h.lastMine = mine;
  renderMobileRail(h, people, nearby, titles);
}

function railSkeleton() {
  return Array.from({ length: 3 }, () => `
    <div class="skel-row" aria-hidden="true">
      <div class="skel skel-circle" style="width:36px;height:36px"></div>
      <div><div class="skel skel-line" style="width:60%"></div><div class="skel skel-line" style="width:85%;margin:0"></div></div>
    </div>`).join("");
}

function myGameRow(g) {
  return `
    <a class="widget-row" href="#/games/${esc(g.id)}">
      <span class="widget-icon">${sportIcon(g.sport)}</span>
      <span class="widget-text">
        <strong>${esc(titleCase(g.sport))}</strong>
        <span class="widget-sub">${esc(whenLabel(g.startsAt))} · ${esc(g.venue.name)}</span>
      </span>
      ${g.checkInWindow === "open" && !g.viewerCheckedIn
        ? `<span class="widget-pill widget-pill-live">Check in</span>`
        : g.viewerCheckedIn ? `<span class="widget-pill">&#10003;</span>` : ""}
    </a>`;
}

async function fillMyGames(h) {
  const box = h.$("#w-myGames .widget-body");
  try {
    const { games } = await apiGet("/api/my/games");
    if (!box || h !== H) return games;
    box.innerHTML = games.length
      ? games.slice(0, 4).map(myGameRow).join("")
      : `<p class="empty-inline">Nothing coming up. <a href="#/games">Find a game</a></p>`;
    return games;
  } catch (err) {
    if (box) box.innerHTML = `<p class="empty-inline">${esc(err.message)}</p>`;
    return [];
  }
}

/**
 * People you were verified alongside and don't follow yet — the
 * connection most likely to be real. Hidden entirely when there are none.
 */
async function fillPlayedWith(h) {
  const section = h.$("#w-playedWith");
  try {
    const { people } = await apiGet("/api/people/played-with");
    const fresh = people.filter((p) => !p.isFollowing).slice(0, 4);
    if (!section || h !== H) return fresh;
    if (!fresh.length) { section.remove(); return fresh; }
    section.querySelector(".widget-body").innerHTML = fresh.map((p) => `
      <div class="widget-row">
        ${avatar(p, "sm", { href: `#/u/${p.id}` })}
        <a class="widget-text" href="#/u/${esc(p.id)}">
          <strong>${esc(p.name ?? "Someone")}</strong>
          <span class="widget-sub">${p.sharedGames} game${p.sharedGames === 1 ? "" : "s"} together · ${esc(timeAgo(p.lastPlayedAt))}</span>
        </a>
        ${followButton(p.id, false)}
      </div>`).join("");
    return fresh;
  } catch {
    section?.remove();
    return [];
  }
}

async function fillPeople(h) {
  const box = h.$("#w-people .widget-body");
  try {
    const { people } = await apiGet("/api/people/suggested");
    if (box && h === H) {
      box.innerHTML = people.length
        ? people.slice(0, 4).map((p) => `
          <div class="widget-row">
            ${avatar(p, "sm", { href: `#/u/${p.id}` })}
            <a class="widget-text" href="#/u/${esc(p.id)}">
              <strong>${esc(p.name ?? "Unnamed")}</strong>
              <span class="widget-sub">${esc([titleCase(p.role ?? ""), p.school].filter(Boolean).join(" · "))}</span>
            </a>
            ${followButton(p.id, p.isFollowing)}
          </div>`).join("") + `<a class="widget-foot" href="#/people">Show more</a>`
        : `<p class="empty-inline">No suggestions yet.</p>`;
    }
    return people;
  } catch (err) {
    if (box) box.innerHTML = `<p class="empty-inline">${esc(err.message)}</p>`;
    return [];
  }
}

/**
 * Paints straight away with whatever location is already known, then —
 * the first time only — asks for position and repaints nearest-first,
 * so the rail never sits on a skeleton waiting for a permission prompt.
 */
async function fillNearby(h, { refine = true } = {}) {
  const box = h.$("#w-nearby .widget-body");
  const coords = lastCoords();
  if (!coords && refine) {
    void locate().then(async (c) => {
      if (!c || h !== H) return;
      const open = await fillNearby(h, { refine: false });
      if (h !== H) return;
      const titles = Object.fromEntries(RAILS[getUser()?.role] ?? RAILS.player);
      renderMobileRail(h, h.lastPeople, open, titles);
    });
  }
  try {
    // Enough that dropping the viewer's own games still leaves four to show.
    const params = { limit: 20 };
    if (coords) Object.assign(params, { lat: coords.lat, lng: coords.lng, radiusKm: 25 });
    const { games } = await apiGet("/api/games", params);
    const open = games.filter((g) => !g.viewerStatus && !g.isHost).slice(0, 5);
    if (box) {
      box.innerHTML = open.length
        ? open.slice(0, 4).map((g) => `
          <div class="widget-row">
            <span class="widget-icon">${sportIcon(g.sport)}</span>
            <a class="widget-text" href="#/games/${esc(g.id)}">
              <strong>${esc(titleCase(g.sport))} · ${esc(whenLabel(g.startsAt))}</strong>
              <span class="widget-sub">${esc(g.venue.name)}${
                g.distanceKm !== undefined ? ` · ${g.distanceKm} km` : ""} · ${esc(gameGlance(g).state)}</span>
            </a>
            ${viewButton(g)}
          </div>`).join("") +
          (coords ? "" : `<p class="empty-inline widget-hint">Share your location to see games nearby.</p>`)
        : `<p class="empty-inline">No open games${coords ? " nearby" : " yet"}. <a href="#/games">Host one</a></p>`;
    }
    return open;
  } catch (err) {
    if (box) box.innerHTML = `<p class="empty-inline">${esc(err.message)}</p>`;
    return [];
  }
}

/**
 * Joining happens on the game's own card (game-card.js), which knows
 * whether it is a free seat or a paid event entry.
 */
function viewButton(g) {
  return `<a class="btn-join" href="#/games/${esc(g.id)}">View</a>`;
}

/**
 * On one-column layouts the suggestions sit a few posts into the feed,
 * the way Instagram slots "Suggested for you", rather than pushing the
 * first post below the fold. The node moves out before the list is
 * rewritten so a refresh never destroys it.
 */
function parkMobileRail(h) {
  const rail = h.$("#mobile-rail");
  const list = h.$("#feed-list");
  if (rail && list && list.contains(rail)) list.before(rail);
}

function placeMobileRail(h) {
  const rail = h.$("#mobile-rail");
  const posts = h.root.querySelectorAll("#feed-list > .post");
  if (rail && posts.length) posts[Math.min(2, posts.length - 1)].after(rail);
}

function renderMobileRail(h, people, nearby, titles) {
  const box = h.$("#mobile-rail");
  if (!box) return;
  const blocks = [];
  if (h.lastPlayed.length) {
    blocks.push(`
      <div class="hscroll-block">
        <div class="hscroll-title"><span>Played with you</span></div>
        <div class="hscroll">
          ${h.lastPlayed.map((p) => `
            <div class="hcard">
              ${avatar(p, "md", { href: `#/u/${p.id}` })}
              <a class="hcard-name" href="#/u/${esc(p.id)}"><strong>${esc(p.name ?? "Someone")}</strong></a>
              <span class="hcard-sub">${p.sharedGames} game${p.sharedGames === 1 ? "" : "s"} together</span>
              ${followButton(p.id, false)}
            </div>`).join("")}
        </div>
      </div>`);
  }
  if (h.lastMine.length) {
    blocks.push(`
      <div class="hscroll-block">
        <div class="hscroll-title"><span>${esc(titles.myGames ?? "Your games")}</span><a href="#/games">See all</a></div>
        <div class="hscroll">
          ${h.lastMine.slice(0, 4).map((g) => `
            <a class="hcard" href="#/games/${esc(g.id)}">
              <span class="hcard-icon">${sportIcon(g.sport)}</span>
              <strong>${esc(titleCase(g.sport))}</strong>
              <span class="hcard-sub">${esc(whenLabel(g.startsAt))}</span>
              <span class="hcard-sub hcard-sub-tight">${esc(g.venue.name)}</span>
            </a>`).join("")}
        </div>
      </div>`);
  }
  if (nearby.length) {
    blocks.push(`
      <div class="hscroll-block">
        <div class="hscroll-title"><span>${esc(titles.nearby ?? "Games near you")}</span><a href="#/games">See all</a></div>
        <div class="hscroll">
          ${nearby.map((g) => `
            <div class="hcard">
              <span class="hcard-icon">${sportIcon(g.sport)}</span>
              <strong>${esc(titleCase(g.sport))}</strong>
              <span class="hcard-sub">${esc(whenLabel(g.startsAt))}</span>
              <span class="hcard-sub hcard-sub-tight">${esc(g.venue.name)}</span>
              ${viewButton(g)}
            </div>`).join("")}
        </div>
      </div>`);
  }
  if (people.length) {
    blocks.push(`
      <div class="hscroll-block">
        <div class="hscroll-title"><span>${esc(titles.people ?? "Who to follow")}</span><a href="#/people">See all</a></div>
        <div class="hscroll">
          ${people.map((p) => `
            <div class="hcard">
              ${avatar(p, "md", { href: `#/u/${p.id}` })}
              <a class="hcard-name" href="#/u/${esc(p.id)}"><strong>${esc(p.name ?? "Unnamed")}</strong></a>
              <span class="hcard-sub">${esc([titleCase(p.role ?? ""), p.school].filter(Boolean).join(" · ") || " ")}</span>
              ${followButton(p.id, p.isFollowing)}
            </div>`).join("")}
        </div>
      </div>`);
  }
  box.innerHTML = blocks.join("");
}

// ── the feed ──────────────────────────────────────────────────────────

/**
 * Stop the feed where it stands: no paging, and any load in flight is
 * dropped when it answers. A reset starts from here, and so does a module
 * tab taking the feed's place.
 */
function stopFeed(h) {
  h.seq++;
  h.paging = false;
  h.nextBefore = null;
  h.observer?.disconnect();
  h.observer = null;
  const more = h.$("#feed-more");
  if (more) more.innerHTML = "";
}

/**
 * A reset (first paint, a feed tab, a new post) stops the feed and starts
 * over, so whatever was in flight is dropped and the old tab's cursor can
 * never page into the new one. "More" is one at a time, never cancels a
 * reset, and is dropped if a reset starts under it. `skeleton` blanks the
 * list while the reset loads (a tab switch); a refresh keeps the posts up.
 */
async function load({ reset = false, skeleton = false } = {}) {
  const h = H;
  if (!h || !FEED_SCOPES.has(SCOPE)) return;
  const list = h.$("#feed-list");
  if (reset) {
    stopFeed(h);
    if (skeleton) {
      // The inline suggestions live inside the list; move them out before it is rewritten.
      parkMobileRail(h);
      list.innerHTML = skeletonPosts();
    }
  } else if (h.paging || !h.nextBefore) {
    return;
  }
  const seq = h.seq;
  const current = () => seq === h.seq && h === H;
  const params = { scope: SCOPE, limit: 20 };
  if (!reset) {
    params.before = h.nextBefore;
    h.paging = true;
  }
  try {
    const data = await apiGet("/api/feed", params);
    if (!current()) return;

    const html = data.posts.map(postCard).join("");
    if (reset) {
      parkMobileRail(h);
      list.innerHTML = html || emptyState(data);
      if (data.usedFallback && data.posts.length) {
        list.insertAdjacentHTML("afterbegin",
          `<p class="feed-note">You're not following anyone yet — showing everyone for now.</p>`);
      }
    } else {
      list.insertAdjacentHTML("beforeend", html);
    }
    hydratePosts(list);

    h.nextBefore = data.nextBefore;
    if (reset) placeMobileRail(h);
    watchForMore(h);
  } catch (err) {
    if (!current()) return;
    // A failed "more" keeps the posts already shown; the button retries.
    if (reset) list.innerHTML = `<p class="feed-loading">${esc(err.message)}</p>`;
    else toast(err.message);
  } finally {
    if (!reset && current()) h.paging = false;
  }
}

/** Infinite scroll, with a button as the fallback and for keyboard users. */
function watchForMore(h) {
  const more = h.$("#feed-more");
  if (!more) return;
  h.observer?.disconnect();
  if (!h.nextBefore) { more.innerHTML = ""; return; }
  more.innerHTML = `<button type="button" class="btn-game btn-game-ghost btn-block" id="btn-more">Show more</button>`;
  more.querySelector("#btn-more").addEventListener("click", () => void load());
  if ("IntersectionObserver" in window) {
    h.observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) void load();
    }, { rootMargin: "600px 0px" });
    h.observer.observe(more);
  }
}

function emptyState(data) {
  return data.scope === "home"
    ? `<div class="empty"><p>Your feed is quiet.</p>
       <p class="empty-sub">Follow a few players, coaches or scouts, or host a game to get things moving.</p>
       <a class="btn-post" href="#/people">Find people</a></div>`
    : `<div class="empty"><p>No posts yet.</p>
       <p class="empty-sub">Be the first to say something.</p></div>`;
}
