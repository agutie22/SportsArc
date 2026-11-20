/**
 * The Games page: the viewer's own games beside the public list.
 *
 * Wide screens show two columns. On the left, "My games":
 *   - results waiting on the viewer, looking back two weeks
 *     (GET /api/my/results/open);
 *   - "Up next", the next game as a full card (check-in open first);
 *   - "Hosting" and "Playing" as one-line rows (GET /api/my/games), each
 *     folded to three with "Show all".
 * On the right, "Find games": a day picker for the coming week (with a
 * count under each day, and "Later" for anything after it), the location,
 * distance and sport filters, and that day's open games as rows. A game
 * already in My games is left out.
 *
 * Above both, the sport tabs (ALL, BASKETBALL, SOCCER …) filter the page.
 * A sport that has Pro markets (modules.js sport sections; markets/) also
 * shows its scoreboard strip and a Games · Markets switch: Markets is the
 * section's own tab beside its rail (the Gemini account and positions).
 * Old #/sport/<sport> links land here with that sport chosen (openSport).
 *
 * Under 900px the two columns become the "My games" and "Find games" tabs.
 * A game opened from a link (#/games/<id>) sits above both, under a
 * heading that says how the viewer is connected to it.
 *
 * Everything is fetched, then painted in one pass, so the lists do not jump
 * as they arrive. A filter change reloads the public list alone. Filters,
 * the tab and the shared location are kept for the browser session.
 *
 * The card, the row and their buttons are game-card.js, the host tools
 * manage.js, and the "Host a game" sheet host.js.
 */

import { main, getUser, toast } from "./shared.js";
import { apiGet, dayKey, warm, esc, titleCase, loadMeta, lastCoords, locate } from "./api.js";
import { bindCards, decorateCards, gameCard, gameRow } from "./game-card.js";
import { fetchGame } from "./manage.js";
import { openHostForm } from "./host.js";
import { listSportSections } from "./modules.js";

const fetchGames = (params) => apiGet("/api/games", { ...params, limit: 100 }).then((b) => b.games);
const fetchMyGames = () => apiGet("/api/my/games", { limit: 30 }).then((b) => b.games);
const fetchOpenResults = () => apiGet("/api/my/results/open").then((b) => b.games);

// ── state ─────────────────────────────────────────────────────────────
//
// Two kinds, kept apart on purpose. The module holds the viewer's
// preferences (sport, distance, location, the open tab, Games · Markets),
// saved for the session and shared by every copy of the page. What one
// rendered page shows (the linked game, the last answer, the picked day,
// unfolded lists, its loads in flight) lives on that page's own state,
// made by renderGames(): the tab cache can hold a #/games page while a
// #/games/<id> page renders, and neither may read the other's.

const VIEW_KEY = "sportsarc.gamesView";
const RADII = [5, 25, 50, 200];
const FOLD = 3;               // rows a Hosting / Playing list shows before "Show all"
const WEEK = 7;               // days in the picker before "Later"
const LATER = "later";

function savedView() {
  try { return JSON.parse(sessionStorage.getItem(VIEW_KEY) ?? "{}") ?? {}; } catch { return {}; }
}
function saveView() {
  try { sessionStorage.setItem(VIEW_KEY, JSON.stringify({ ...FILTERS, near: NEAR, tab: TAB, view: VIEW })); } catch { /* private mode */ }
}

const saved = savedView();
let META = null;
/** Games near the viewer (on unless they tapped back to all); the position is api.js lastCoords(). */
let NEAR = saved.near !== false;
/** Asked for the position on our own once this load; after that only a tap asks again. */
let AUTO_LOCATED = false;
/** Where the list is centred: the shared position while Near me is on. */
const nearCoords = () => (NEAR ? lastCoords() : null);
let FILTERS = {
  sport: typeof saved.sport === "string" ? saved.sport : "",
  radiusKm: RADII.includes(saved.radiusKm) ? saved.radiusKm : 25,
};
let TAB = saved.tab === "mine" || saved.tab === "find" ? saved.tab : null;  // null: chosen after the first load
let VIEW = saved.view === "markets" ? "markets" : "games";  // the Games · Markets switch, for a sport with markets
/** Query from an old #/sport/<sport>?… link, handed to the sections once (e.g. gemini=connected). */
let PENDING_PARAMS = null;

/** Each rendered .games-page → its own state (see newPage). */
const PAGES = new WeakMap();

function newPage(root, focus) {
  return {
    root,
    $: (sel) => root.querySelector(sel),
    focus,                  // game id from a #/games/<id> link
    data: null,             // { focus, needs, mine, open } as last fetched
    day: null,              // the picked day's key (see dayKey), or LATER
    unfolded: new Set(),    // "hosting" | "playing" lists shown in full
    seq: 0,                 // the newest load wins
    fullLoads: 0,           // full reloads in flight
    sectionSeq: 0,          // the newest section paint wins
    locating: false,        // a position fix in flight for this page
  };
}

// ── page ──────────────────────────────────────────────────────────────

const skeleton = `<div class="games-rows">${`
  <div class="game-row game-row-skel">
    <div class="skel skel-line" style="width:48px"></div>
    <div class="skel skel-line" style="width:55%"></div>
  </div>`.repeat(4)}</div>`;

/** The Games page; `focus` is a game id from a #/games/<id> link. */
export function renderGames({ focus = null } = {}) {
  if (!getUser()) return;

  main().innerHTML = `
    <div class="games-page" data-tab="${TAB ?? "mine"}" data-view="games">
      <div class="games-head">
        <h3 class="games-title">Games</h3>
        <button class="btn-host" id="btn-host">+ Host a Game</button>
      </div>

      <nav class="sport-tabs games-sport-tabs" id="games-sport-tabs" aria-label="Sports"></nav>
      <div class="games-strip" id="games-strip" hidden></div>
      <div class="games-views" id="games-views" role="tablist" aria-label="Games or markets" hidden>
        <button type="button" role="tab" data-view="games">Games</button>
        <button type="button" role="tab" data-view="markets">Markets</button>
      </div>
      <div class="games-markets" id="games-markets">
        <div class="games-markets-rail" id="games-markets-rail"></div>
        <div class="games-markets-main" id="games-markets-main"></div>
      </div>

      <div id="games-focus"></div>

      <div class="games-tabs" role="tablist" aria-label="Games">
        <button type="button" role="tab" data-tab="mine">My games<span id="games-mine-n"></span></button>
        <button type="button" role="tab" data-tab="find">Find games<span id="games-find-n"></span></button>
      </div>

      <div class="games-cols">
        <div class="games-mine" id="games-mine" role="tabpanel"></div>
        <section class="games-find" role="tabpanel">
          <h4 class="games-section">Find games <span id="games-locnote"></span></h4>
          <div class="games-days" id="games-days"></div>
          <div class="games-filters">
            <button class="chip chip-loc" id="btn-locate"></button>
            <select class="chip chip-select" id="filter-radius" aria-label="Distance">
              ${RADII.map((n) => `<option value="${n}"${FILTERS.radiusKm === n ? " selected" : ""}>Within ${n} km</option>`).join("")}
            </select>
          </div>
          <div id="games-open">${skeleton}</div>
        </section>
      </div>
    </div>`;

  const page = main().querySelector(".games-page");
  const pg = newPage(page, focus);
  PAGES.set(page, pg);
  const reload = () => refresh(pg);
  bindCards(page, { refresh: reload, hostAgain: (game) => void startHosting(pg, game) });
  page.addEventListener("click", (e) => {
    const t = e.target.closest("[data-fold], [data-tab], [data-day], [data-sport], [data-view], [data-host-new]");
    if (!t) return;
    const d = t.dataset;
    if (d.fold) {
      if (!pg.unfolded.delete(d.fold)) pg.unfolded.add(d.fold);
      page.classList.add("is-settled");
      paintMine(pg);
      decorateCards(pg.$("#games-mine"), { onChange: reload });
    } else if (d.tab) {
      TAB = d.tab; saveView(); paintTabs(pg);
    } else if (d.day) {
      pg.day = d.day;
      page.classList.add("is-settled");
      paintOpen(pg);
      decorateCards(pg.$("#games-open"), { onChange: reload });
    } else if (d.sport !== undefined) {
      FILTERS.sport = d.sport; saveView(); paintSports(pg); void paintSection(pg); void refresh(pg, { openOnly: true });
    } else if (d.view) {
      VIEW = d.view; saveView(); void paintSection(pg);
    } else if (d.hostNew !== undefined) {
      void startHosting(pg);
    }
  });
  // A sport tab about to be clicked: fetch its games and its section data now.
  const nav = pg.$("#games-sport-tabs");
  for (const type of ["pointerenter", "focusin", "touchstart"]) {
    nav.addEventListener(type, (e) => {
      const t = e.target.closest?.("[data-sport]");
      if (t && t.dataset.sport !== FILTERS.sport) prefetchSport(t.dataset.sport);
    }, { passive: true, capture: type === "pointerenter" });
  }
  pg.$("#btn-host").addEventListener("click", () => void startHosting(pg));
  pg.$("#btn-locate").addEventListener("click", () => toggleLocation(pg));
  pg.$("#filter-radius").addEventListener("change", (e) => {
    FILTERS.radiusKm = Number(e.target.value); saveView(); void refresh(pg, { openOnly: true });
  });

  paintTabs(pg);
  paintFilters(pg);
  paintSports(pg);
  void ensureMeta(pg).then(() => {
    void paintSection(pg);
    // While the browser is idle, get the viewer's own sport ready too.
    const own = getUser()?.primarySport;
    const idle = window.requestIdleCallback ?? ((fn) => setTimeout(fn, 1200));
    if (own && own !== FILTERS.sport && META?.sports?.includes(own)) idle(() => prefetchSport(own));
  });
  void refresh(pg);
  autoLocate(pg);
}

const prefetched = new Map();   // sport → when

/** Warm a sport's open games and every section's data, at most every 15 s. */
function prefetchSport(sport) {
  if (Date.now() - (prefetched.get(sport) ?? 0) < 15_000) return;
  prefetched.set(sport, Date.now());
  warm("/api/games", { ...openParams(sport), limit: 100 });
  for (const s of listSportSections()) {
    try { void Promise.resolve(s.prefetch?.(sport)).catch(() => {}); } catch { /* prefetch is best effort */ }
  }
}

/**
 * An old #/sport/<sport>[?query] link (and the Gemini connect return):
 * choose that sport here and open Games. A query from Gemini opens Markets.
 */
export function openSport(rest = "") {
  const [raw, query = ""] = String(rest).split("?");
  const sport = decodeURIComponent(raw || "").toLowerCase();
  FILTERS.sport = sport;   // none named (#/sport/?view=markets): ALL, not the saved sport
  const params = new URLSearchParams(query);
  if (params.get("gemini")) { VIEW = "markets"; PENDING_PARAMS = params; }
  if (params.get("view") === "markets") VIEW = "markets";
  saveView();
  location.replace("#/games");
}

/** Open the host sheet once the vocabularies are in. */
async function startHosting(pg, again = null) {
  await ensureMeta(pg);
  openHostForm({ meta: META, coords: lastCoords(), again, onPosted: () => void refresh(pg) });
}

async function ensureMeta(pg) {
  if (!META) {
    try { META = await loadMeta(); } catch { return; /* sport chips stay at "All sports" */ }
  }
  paintSports(pg);
}

// ── filters ───────────────────────────────────────────────────────────

function paintTabs(pg) {
  const page = pg.root;
  page.dataset.tab = TAB ?? "mine";
  for (const b of page.querySelectorAll(".games-tabs [data-tab]")) {
    b.setAttribute("aria-selected", String(b.dataset.tab === page.dataset.tab));
  }
}

/** ALL, then one tab per sport from /api/meta: the filter for the whole page. */
function paintSports(pg) {
  const nav = pg.$("#games-sport-tabs");
  if (!nav) return;
  const sports = META?.sports ?? [];
  if (FILTERS.sport && META && !sports.includes(FILTERS.sport)) FILTERS.sport = "";
  nav.innerHTML = ["", ...sports.filter((s) => s !== "other")].map((s) => {
    const on = FILTERS.sport === s;
    return `<button type="button" class="sport-tab${on ? " is-on" : ""}" data-sport="${esc(s)}"
      aria-pressed="${on}">${s ? esc(titleCase(s)) : "All"}</button>`;
  }).join("");
}

// ── sport sections (Pro markets) ──────────────────────────────────────

/**
 * The strip and the Games · Markets switch for the chosen sport, from the
 * sections modules register. ALL, a sport without markets, or no module:
 * the page is the plain Games page.
 */
async function paintSection(pg) {
  const page = pg.root;
  const seq = ++pg.sectionSeq;
  const sport = FILTERS.sport;
  const all = listSportSections();
  const shown = await Promise.all(all.map((s) => (s.visible ? s.visible(sport).catch(() => false) : true)));
  if (seq !== pg.sectionSeq || !page.isConnected) return;
  const sections = all.filter((_, i) => shown[i]);
  const tabbed = sections.find((s) => s.tab);
  const strip = pg.$("#games-strip");
  const views = pg.$("#games-views");
  const main = pg.$("#games-markets-main");
  const rail = pg.$("#games-markets-rail");
  strip.innerHTML = "";
  main.innerHTML = "";
  rail.innerHTML = "";

  if (!tabbed) VIEW = "games";
  strip.hidden = !sections.some((s) => s.strip);
  views.hidden = !tabbed;
  page.dataset.view = VIEW;
  for (const b of views.querySelectorAll("[data-view]")) {
    b.setAttribute("aria-selected", String(b.dataset.view === VIEW));
    if (b.dataset.view === "markets" && tabbed) b.textContent = tabbed.tabLabel ?? "Markets";
  }

  const mount = (box, fn) => {
    const el = document.createElement("div");
    box.appendChild(el);
    try { fn(sport, el); } catch (err) { console.warn("[games] sport section failed:", err); el.remove(); }
  };
  for (const s of sections) if (s.strip) mount(strip, s.strip);
  if (VIEW === "markets" && tabbed) {
    mount(main, tabbed.tab);
    for (const s of sections) if (s.rail) mount(rail, s.rail);
  }
  if (PENDING_PARAMS) {
    const params = PENDING_PARAMS;
    PENDING_PARAMS = null;
    for (const s of sections) {
      try { s.onEnter?.(sport, params); } catch (err) { console.warn("[games] section onEnter failed:", err); }
    }
  }
}

/** The location chip, the distance filter (idle without a location) and the note. */
function paintFilters(pg) {
  const btn = pg.$("#btn-locate");
  if (!btn) return;
  const near = Boolean(nearCoords());
  btn.textContent = pg.locating ? "Locating…" : near ? "Near me" : "Use my location";
  btn.classList.toggle("chip-active", near);
  btn.setAttribute("aria-pressed", String(near));
  btn.title = near ? "Showing games near you. Tap to show all." : "";
  const radius = pg.$("#filter-radius");
  // The distance is a preference: another copy of the page may have changed it.
  radius.value = String(FILTERS.radiusKm);
  radius.disabled = !near;
  radius.title = near ? "" : "Share your location to filter by distance";
  pg.$("#games-locnote").textContent = near ? `· within ${FILTERS.radiusKm} km` : "· all upcoming";
}

/**
 * Find the viewer's position and reload the open list around it. `ask`
 * (a tap) says so when it fails; on its own it fails quietly and the list
 * stays on all upcoming games.
 */
async function findNearby(pg, { ask = false } = {}) {
  if (pg.locating) return;
  if (ask && !navigator.geolocation) { toast("This browser cannot share location."); return; }
  pg.locating = true;
  paintFilters(pg);
  const coords = await locate();
  pg.locating = false;
  if (!pg.root.isConnected) return;   // set aside by the tab cache: resume reloads
  if (!coords) {
    paintFilters(pg);
    if (ask) toast("Could not get your location. Showing all games instead.");
    return;
  }
  if (NEAR) void refresh(pg, { openOnly: true });
}

/** Near me on: list nearby games, asking for the position once if none is known yet. */
function autoLocate(pg) {
  if (!NEAR || lastCoords() || AUTO_LOCATED) return;
  AUTO_LOCATED = true;
  void findNearby(pg);
}

/** The chip: nearby games, or tap again to go back to all of them. */
function toggleLocation(pg) {
  if (nearCoords()) { NEAR = false; saveView(); void refresh(pg, { openOnly: true }); return; }
  NEAR = true;
  saveView();
  if (lastCoords()) void refresh(pg, { openOnly: true });
  else void findNearby(pg, { ask: true });
}

// ── loading ───────────────────────────────────────────────────────────

/**
 * Shown again from the tab cache: reload in place; rows swap without
 * fading. The page's own state came back with it; only the preferences
 * another copy may have changed (an old #/sport link, the tab, the
 * filters) are painted again.
 */
export function resumeGames() {
  const root = main().querySelector(".games-page");
  const pg = root && PAGES.get(root);
  if (!pg) return;
  paintTabs(pg);
  paintFilters(pg);
  paintSports(pg);
  void paintSection(pg);
  void refresh(pg);
  autoLocate(pg);
}

/** The public list's filters, shared by refresh() and warmGames(). */
function openParams(sport = FILTERS.sport) {
  const params = {};
  const coords = nearCoords();
  if (coords) Object.assign(params, { lat: coords.lat, lng: coords.lng, radiusKm: FILTERS.radiusKm });
  if (sport) params.sport = sport;
  return params;
}

/** Fetch what the first paint asks for, ahead of the viewer opening the tab. */
export function warmGames() {
  void loadMeta().catch(() => {});  // the sport chips; cached for the session
  warm("/api/my/results/open");
  warm("/api/my/games", { limit: 30 });
  warm("/api/games", { ...openParams(), limit: 100 });
}

/**
 * Load and paint. `openOnly` (a filter changed) reloads the public list and
 * keeps the viewer's own games as they are.
 */
async function refresh(pg, { openOnly = false } = {}) {
  const page = pg.root;
  const seq = ++pg.seq;
  const keep = openOnly && pg.data && !pg.fullLoads ? pg.data : null;
  const params = openParams();
  paintFilters(pg);

  if (!keep) pg.fullLoads++;
  let got;
  try {
    got = await Promise.all([
      keep ? keep.focus : pg.focus ? fetchGame(pg.focus).catch(() => null) : null,
      keep ? keep.needs : fetchOpenResults().catch(() => []),
      keep ? keep.mine : fetchMyGames().catch(() => []),
      fetchGames(params).then((games) => ({ games }), (err) => ({ games: [], error: err.message })),
    ]);
  } finally {
    if (!keep) pg.fullLoads--;
  }
  // A page set aside by the tab cache is not connected; it reloads when it comes back.
  if (seq !== pg.seq || !page.isConnected) return;
  const [focus, needs, mine, open] = got;
  if (pg.focus && !focus) {
    // Said once: the link is dropped, so later reloads do not ask again.
    pg.focus = null;
    toast("That game is no longer available.");
  }
  // Rows fade in on the first paint only; a reload after an action swaps them in place.
  if (pg.data) page.classList.add("is-settled");
  pg.data = { focus, needs, mine, open };
  // A first visit with nothing of the viewer's own opens on Find games.
  if (!TAB) { TAB = needs.length || mine.length ? "mine" : "find"; paintTabs(pg); }
  if (!keep) paintMine(pg);
  paintOpen(pg);
  decorateCards(keep ? pg.$("#games-open") : page, { onChange: () => refresh(pg) });
}

// ── painting ──────────────────────────────────────────────────────────

/** How the game opened from a link relates to the viewer. */
function focusTitle(g) {
  if (g.viewerRole === "host") return "You're hosting";
  if (g.viewerRole === "cohost") return "You're co-hosting";
  if (g.viewerStatus === "joined") return "You're in";
  if (g.viewerStatus === "waitlist") return "On the waitlist";
  return "Shared with you";
}

/** The viewer's games in the order they are shown, each one once. */
function mineLists(pg) {
  const { focus, needs, mine } = pg.data;
  const seen = new Set(focus ? [focus.id] : []);
  const take = (games) => games.filter((g) => !seen.has(g.id) && seen.add(g.id));
  const pending = take(needs);
  const rest = take(mine).sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt));
  // Up next: a game with check-in open, else the soonest one still to start
  // (a game that started a while ago is not "next").
  const next = rest.find((g) => g.checkInWindow === "open" && g.status !== "cancelled")
    ?? rest.find((g) => new Date(g.startsAt).getTime() > Date.now() && g.status !== "cancelled")
    ?? null;
  const others = rest.filter((g) => g !== next);
  return {
    focus,
    pending,
    next,
    hosting: others.filter((g) => g.viewerRole),
    playing: others.filter((g) => !g.viewerRole),
    seen,
  };
}

function rows(pg, title, games, { sub = "", cls = "", fold = "", showDay = true } = {}) {
  if (!games.length) return "";
  const folded = fold && games.length > FOLD && !pg.unfolded.has(fold);
  const shown = folded ? games.slice(0, FOLD) : games;
  const more = fold && games.length > FOLD
    ? `<button type="button" class="games-rows-more" data-fold="${fold}" aria-expanded="${!folded}">${
      folded ? `Show all ${games.length}` : "Show fewer"}</button>`
    : "";
  return `
    <section class="games-band ${cls}">
      <h4 class="games-section">${esc(title)}${sub ? ` <span>· ${esc(sub)}</span>` : ""}</h4>
      <div class="games-rows">${shown.map((g) => gameRow(g, { showDay })).join("")}${more}</div>
    </section>`;
}

function paintMine(pg) {
  const box = pg.$("#games-mine");
  if (!box || !pg.data) return;
  const m = mineLists(pg);
  const count = m.pending.length + (m.next ? 1 : 0) + m.hosting.length + m.playing.length;

  pg.$("#games-focus").innerHTML = m.focus ? `
    <section class="games-band games-focus">
      <h4 class="games-section">${esc(focusTitle(m.focus))}</h4>
      <div class="games-list">${gameCard(m.focus)}</div>
    </section>` : "";
  pg.$("#games-mine-n").textContent = count ? ` ${count}` : "";

  if (!count) {
    box.innerHTML = `
      <h4 class="games-section games-mine-title">My games</h4>
      <div class="empty empty-card">
        <p>No games yet.</p>
        <p class="empty-sub">Join one from Find games, or host your own.</p>
      </div>`;
    return;
  }
  box.innerHTML = `
    <h4 class="games-section games-mine-title">My games <span>· ${count}</span></h4>
    ${rows(pg, "Results waiting on you", m.pending, { sub: String(m.pending.length), cls: "games-needs" })}
    ${m.next ? `
      <section class="games-band">
        <h4 class="games-section">Up next</h4>
        <div class="games-list">${gameCard(m.next)}</div>
      </section>` : ""}
    ${rows(pg, "Hosting", m.hosting, { sub: String(m.hosting.length), fold: "hosting" })}
    ${rows(pg, "Playing", m.playing, { sub: String(m.playing.length), fold: "playing" })}
    <a class="games-link" href="#/record">Your verified record →</a>`;
}


/** The picker's days: today and the six after it. */
function weekDays() {
  const out = [];
  const d = new Date(); d.setHours(0, 0, 0, 0);
  for (let i = 0; i < WEEK; i++) { out.push(new Date(d)); d.setDate(d.getDate() + 1); }
  return out;
}

/** Which picker slot a game falls in: its day's key, or LATER. */
function slotOf(g, keys) {
  const k = dayKey(new Date(g.startsAt));
  return keys.has(k) ? k : LATER;
}

function dayName(d, i) {
  if (i === 0) return "Today";
  return d.toLocaleDateString([], { weekday: "short" });
}

function paintOpen(pg) {
  const box = pg.$("#games-open");
  const picker = pg.$("#games-days");
  if (!box || !pg.data) return;
  const { games, error } = pg.data.open;
  if (error) { picker.innerHTML = ""; box.innerHTML = `<p class="empty">${esc(error)}</p>`; return; }
  const { seen } = mineLists(pg);
  // Games already under way are left out of the list: they cannot be joined.
  const shown = games.filter((g) => !seen.has(g.id) && new Date(g.startsAt).getTime() > Date.now());
  pg.$("#games-find-n").textContent = shown.length ? ` ${shown.length}` : "";

  const days = weekDays();
  const keys = new Set(days.map(dayKey));
  const bySlot = new Map();
  for (const g of shown) {
    const s = slotOf(g, keys);
    if (!bySlot.has(s)) bySlot.set(s, []);
    bySlot.get(s).push(g);
  }
  const later = bySlot.get(LATER) ?? [];
  // Keep the picked day while it is still in the picker; otherwise the first day with games.
  if (pg.day !== LATER && !keys.has(pg.day)) pg.day = null;
  if (pg.day === LATER && !later.length) pg.day = null;
  if (!pg.day) pg.day = days.map(dayKey).find((k) => bySlot.has(k)) ?? (later.length ? LATER : dayKey(days[0]));
  const day = pg.day;

  const chip = (key, top, mid, n) => `
    <button type="button" class="games-day-chip" data-day="${esc(key)}" aria-pressed="${day === key}">
      <b>${esc(top)}</b><strong>${esc(mid)}</strong>
      <small class="${n ? "" : "is-none"}">${n ? `${n} game${n === 1 ? "" : "s"}` : "none"}</small>
    </button>`;
  picker.innerHTML =
    days.map((d, i) => chip(dayKey(d), dayName(d, i), String(d.getDate()), bySlot.get(dayKey(d))?.length ?? 0)).join("") +
    (later.length ? chip(LATER, "Later", "+", later.length) : "");

  if (!shown.length) {
    const filtered = Boolean(nearCoords() || FILTERS.sport);
    box.innerHTML = `
      <div class="empty empty-compact">
        <p>${games.length ? "Nothing else here." : filtered ? "No games match." : "No games here yet."}</p>
        <p class="empty-sub">${games.length
          ? "Your games are in My games."
          : filtered ? "Try a wider distance or another sport, or host one."
            : "Be the first — host one and people nearby can join."}</p>
      </div>`;
    return;
  }
  const list = bySlot.get(day) ?? [];
  if (!list.length) {
    box.innerHTML = `
      <div class="empty empty-compact">
        <p>No games this day.</p>
        <p class="empty-sub">Pick another day, or <button type="button" class="games-inline-link" data-host-new>host one</button>.</p>
      </div>`;
    return;
  }
  // The API sends them soonest first.
  box.innerHTML = `<div class="games-rows">${list.map((g) => gameRow(g, { showDay: day === LATER })).join("")}</div>`;
}
