/**
 * Map tab (#/map): where people play, from GET /api/insights/map.
 *
 * Two halves. The stage on the left holds the filters, the four ways to
 * draw the map (map-stage.js) and the map itself; the panel on the right
 * answers for whatever the map shows: the court you picked, totals for
 * the courts in view, when people play there, and the busiest courts.
 *
 * The stage calls pg.showVenues(list) after every move and pg.select(id)
 * when a court is tapped; this file hands it the data (stage.setData).
 * Without WebGL the map says so and the panel still works on every court.
 * Nothing here names a person: player counts and show-up rates arrive as
 * null under five adults (api/insights/map.ts). A court backed by a
 * sponsor org says so, with the league games played there.
 * Signed-out visitors see the same page, without hosting.
 */

import { ICON, getUser, main } from "./shared.js";
import { apiGet, esc, loadMeta, titleCase, clockText, dayHeading } from "./api.js";
import { openVenueSheet } from "./venue.js";
import { openGamePreview } from "./game-preview.js";
import { openHostForm } from "./host.js";
import { MODES, mountStage } from "./map-stage.js";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const RANGES = [[4, "4 wk"], [12, "12 wk"], [52, "Year"]];

// Preferences only; what one page shows lives on its state object.
const prefs = { sport: "", weeks: 12, mode: "clusters" };
/** The page on screen; a late answer for an older page is dropped. */
let current = null;

export async function renderMap() {
  current?.stage?.destroy();
  const root = main();
  root.innerHTML = `
    <div class="map-page">
      <section class="map-stage" aria-label="Map">
        <div class="map-tools">
          <div class="map-chips" data-sports role="group" aria-label="Sport"></div>
          <div class="map-seg" data-range role="group" aria-label="Range">
            ${RANGES.map(([w, l]) => `<button type="button" data-weeks="${w}" aria-pressed="${w === prefs.weeks}">${l}</button>`).join("")}
          </div>
          <div class="map-seg map-modes" data-modes role="group" aria-label="Map style">
            ${MODES.map(([m, l]) => `<button type="button" data-mode="${m}" aria-pressed="${m === prefs.mode}">${l}</button>`).join("")}
          </div>
        </div>
        <div class="map-canvas" data-canvas></div>
      </section>
      <aside class="map-panel" data-panel aria-label="What the map shows">
        <div data-sel></div>
        <section class="map-sec">
          <h3 class="map-h">In view <span data-range-label></span></h3>
          <div class="map-stats" data-stats>${statSkeleton()}</div>
        </section>
        <section class="map-sec">
          <h3 class="map-h">When people play</h3>
          <div data-when><div class="skel skel-line" style="height:120px"></div></div>
        </section>
        <section class="map-sec">
          <h3 class="map-h">Busiest courts</h3>
          <div class="map-rows" data-rows><div class="skel skel-line"></div><div class="skel skel-line"></div></div>
        </section>
      </aside>
    </div>`;

  const pg = {
    root,
    data: null,
    inView: [],
    selId: null,
    seq: 0,
    stage: null,
    q: (sel) => root.querySelector(sel),
    /** The stage calls this with the venues inside its view. */
    // The map can report one last move after the page is replaced; it paints nothing then.
    showVenues: (list) => {
      pg.inView = list;
      if (!pg.q("[data-stats]")) return;
      paintStats(pg); paintWhen(pg); paintRows(pg);
    },
    select: (id, { fly = false } = {}) => {
      pg.selId = id;
      paintSelected(pg);
      paintRows(pg);
      pg.stage?.select(id, { fly });
    },
  };
  current = pg;
  void startStage(pg);

  const meta = await loadMeta().catch(() => ({ sports: [] }));
  if (current !== pg) return;
  pg.q("[data-sports]").innerHTML = ["", ...(meta.sports ?? [])].map((s) =>
    `<button type="button" class="chip${s === prefs.sport ? " chip-active" : ""}" data-sport="${esc(s)}">${s ? esc(titleCase(s)) : "All"}</button>`).join("");

  pg.q("[data-sports]").addEventListener("click", (e) => {
    const b = e.target.closest("[data-sport]");
    if (!b || b.dataset.sport === prefs.sport) return;
    prefs.sport = b.dataset.sport;
    pg.q("[data-sports]").querySelectorAll("[data-sport]").forEach((x) => x.classList.toggle("chip-active", x === b));
    void load(pg);
  });
  pg.q("[data-range]").addEventListener("click", (e) => {
    const b = e.target.closest("[data-weeks]");
    if (!b || Number(b.dataset.weeks) === prefs.weeks) return;
    prefs.weeks = Number(b.dataset.weeks);
    pg.q("[data-range]").querySelectorAll("[data-weeks]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    void load(pg);
  });
  pg.q("[data-rows]").addEventListener("click", (e) => {
    const r = e.target.closest("[data-venue]");
    if (r) pg.select(r.dataset.venue, { fly: true });
  });
  pg.q("[data-modes]").addEventListener("click", (e) => {
    const b = e.target.closest("[data-mode]");
    if (!b || b.dataset.mode === prefs.mode) return;
    prefs.mode = b.dataset.mode;
    pg.q("[data-modes]").querySelectorAll("[data-mode]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    pg.stage?.setMode(prefs.mode);
  });
  pg.q("[data-sel]").addEventListener("click", (e) => onSelAction(pg, e, meta));

  await load(pg);
}

/** Mount the map; until it answers, and if it cannot, the panel stands alone. */
async function startStage(pg) {
  const canvas = pg.q("[data-canvas]");
  try {
    const stage = await mountStage(canvas, {
      mode: prefs.mode,
      topInset: () => (pg.q(".map-tools")?.offsetHeight ?? 120) + 30,
      onView: (list) => pg.showVenues(list),
      onSelect: (id) => {
        pg.select(id);
        // On phones the panel sits under the map; bring the court's card up.
        if (matchMedia("(max-width: 900px)").matches) pg.q("[data-sel]")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      },
    });
    if (current !== pg) { stage.destroy(); return; }
    pg.stage = stage;
    if (pg.data) { stage.setData(pg.data.venues); stage.select(pg.selId); }
  } catch (err) {
    if (current !== pg) return;
    console.warn("[map] the map could not start:", err);
    canvas.innerHTML = `<div class="map-canvas-note">${ICON.pin}<span>The map could not load here. The panel still lists every court.</span></div>`;
  }
}

async function load(pg) {
  const seq = ++pg.seq;
  pg.q("[data-panel]").classList.add("is-loading");
  try {
    const data = await apiGet("/api/insights/map", { sport: prefs.sport || undefined, weeks: prefs.weeks });
    if (current !== pg || seq !== pg.seq) return;
    pg.data = data;
    pg.inView = data.venues;
    if (pg.selId && !data.venues.some((v) => v.id === pg.selId)) pg.selId = null;
    if (!pg.selId) pg.selId = data.venues[0]?.id ?? null;
    paintPanel(pg);
    pg.stage?.setData(data.venues);
    pg.stage?.select(pg.selId);
  } catch (err) {
    if (current !== pg || seq !== pg.seq) return;
    pg.q("[data-stats]").innerHTML = `<p class="map-empty">${esc(err.message)}</p>`;
  } finally {
    if (seq === pg.seq) pg.q("[data-panel]").classList.remove("is-loading");
  }
}

// ── panel ─────────────────────────────────────────────────────────────

function paintPanel(pg) {
  const label = RANGES.find(([w]) => w === prefs.weeks)?.[1] ?? "";
  pg.q("[data-range-label]").textContent = prefs.weeks === 52 ? "· last year" : `· last ${label.replace(" wk", " weeks")}`;
  paintSelected(pg);
  paintStats(pg);
  paintWhen(pg);
  paintRows(pg);
}

function statSkeleton() {
  return [0, 1, 2].map(() => `<div class="map-stat"><b class="skel skel-line" style="width:60%"></b><span class="skel skel-line" style="width:80%"></span></div>`).join("");
}

function paintStats(pg) {
  const vs = pg.inView;
  const played = vs.reduce((s, v) => s + v.games, 0);
  const active = vs.filter((v) => v.games > 0).length;
  const upcoming = vs.reduce((s, v) => s + v.upcoming, 0);
  pg.q("[data-stats]").innerHTML = [
    [played, played === 1 ? "game played" : "games played"],
    [active, active === 1 ? "active court" : "active courts"],
    [upcoming, "coming up"],
  ].map(([n, l]) => `<div class="map-stat"><b>${n.toLocaleString()}</b><span>${l}</span></div>`).join("");
}

/** Hour of week (0 = Mon 00:00) in the map's time zone. */
function paintWhen(pg) {
  const grid = new Array(168).fill(0);
  for (const v of pg.inView) for (const [h, n] of v.hours) grid[h] += n;
  const max = Math.max(...grid);
  const el = pg.q("[data-when]");
  if (max === 0) {
    el.innerHTML = `<p class="map-empty">No games played here in this range yet.</p>`;
    return;
  }
  let cells = `<span></span>${Array.from({ length: 24 }, (_, x) => `<span class="map-hh">${x % 6 === 0 ? x : ""}</span>`).join("")}`;
  for (let d = 0; d < 7; d++) {
    cells += `<span class="map-dd">${DAYS[d]}</span>`;
    for (let x = 0; x < 24; x++) {
      const n = grid[d * 24 + x];
      const level = n === 0 ? 0 : Math.max(1, Math.ceil((n / max) * 5));
      cells += `<span class="map-cell" data-l="${level}" title="${DAYS[d]} ${hourText(x)} · ${n} game${n === 1 ? "" : "s"}"></span>`;
    }
  }
  const peak = grid.indexOf(max);
  el.innerHTML = `<div class="map-heat" role="img" aria-label="Games by day and hour">${cells}</div>
    <p class="map-note">Busiest: <b>${DAYS[Math.floor(peak / 24)]} ${hourText(peak % 24)}</b>${pg.data?.timezone ? ` · ${esc(zoneName(pg.data.timezone))}` : ""}</p>`;
}

function paintRows(pg) {
  const top = [...pg.inView].sort((a, b) => b.games - a.games || b.upcoming - a.upcoming).slice(0, 8);
  const el = pg.q("[data-rows]");
  if (top.length === 0) {
    const what = prefs.sport ? `No ${esc(titleCase(prefs.sport))} games here in this range.` : "No courts in view in this range.";
    el.innerHTML = `<p class="map-empty">${what} ${getUser() ? `<a href="#/games">Host the first one</a>.` : "Zoom out or pick another sport."}</p>`;
    return;
  }
  const weeks = pg.data?.weeks ?? prefs.weeks;
  el.innerHTML = top.map((v, i) => `
    <button type="button" class="map-row${v.id === pg.selId ? " is-sel" : ""}" data-venue="${v.id}">
      <span class="map-rank">${i + 1}</span>
      <span class="map-row-main"><b>${esc(v.name)}</b><span>${v.nextAt ? `Next: ${esc(nextText(v.nextAt))}` : esc(titleCase(v.kind))}</span></span>
      <span class="map-row-num"><b>${perWeek(v.games, weeks)}</b>/ week</span>
    </button>`).join("");
}

function paintSelected(pg) {
  const el = pg.q("[data-sel]");
  const v = pg.data?.venues.find((x) => x.id === pg.selId);
  if (!v) { el.innerHTML = ""; return; }
  const weeks = pg.data.weeks;
  const few = v.players === null;
  el.innerHTML = `
    <article class="map-card">
      <header class="map-card-head">
        <div><h2>${esc(v.name)}</h2><span>${esc(v.indoor ? "Indoor" : titleCase(v.kind))}${v.address ? ` · ${esc(v.address)}` : ""}</span></div>
        <button type="button" class="map-x" data-act="close" aria-label="Close">${ICON.close}</button>
      </header>
      ${v.partner || v.league ? `<p class="map-partner">${[
        v.partner ? `Partner court · <a href="#/org/${esc(v.partner.orgSlug)}">${esc(v.partner.orgName)}</a>` : "",
        v.league ? `${v.league.games} league ${v.league.games === 1 ? "game" : "games"} here${v.league.seasons.length ? ` · <a href="#/season/${esc(v.league.seasons[0].id)}">${esc(v.league.seasons[0].name)}</a>` : ""}` : "",
      ].filter(Boolean).join(" · ")}</p>` : ""}
      <div class="map-facts">
        <div><b>${perWeek(v.games, weeks)}</b><span>games a week</span></div>
        <div><b>${few ? "—" : v.players}</b><span>${few ? "under 5 players" : "regulars"}</span></div>
        <div><b class="${few ? "" : "map-good"}">${few ? "—" : `${Math.round(v.showUp * 100)}%`}</b><span>show up</span></div>
      </div>
      <div class="map-up" data-up>${v.upcoming ? `<div class="skel skel-line"></div>` : `<p class="map-empty">No games coming up here.</p>`}</div>
      <div class="map-acts">
        <button type="button" class="btn-game btn-game-ghost" data-act="ladder">Regulars ladder</button>
        ${getUser() ? `<button type="button" class="btn-game btn-game-ghost" data-act="host">Host a game here</button>` : ""}
      </div>
    </article>`;
  if (v.upcoming) void loadUpcoming(pg, v);
}

async function loadUpcoming(pg, v) {
  const games = await apiGet("/api/games", { venueId: v.id, sport: prefs.sport || undefined, limit: 3 }).then((r) => r.games).catch(() => []);
  if (current !== pg || pg.selId !== v.id) return;
  const el = pg.q("[data-up]");
  if (!el) return;
  el.innerHTML = games.length
    ? games.map((g) => `
      <button type="button" class="map-game" data-game="${g.id}">
        <span class="map-when"><b>${esc(clockText(g.startsAt))}</b>${esc(dayHeading(g.startsAt))}</span>
        <span class="map-what"><b>${esc(titleCase(g.sport))} · ${esc(g.skillLevel === "any" ? "All levels" : titleCase(g.skillLevel))}</b>
          <span>${g.spotsLeft ? `${g.spotsLeft} spot${g.spotsLeft === 1 ? "" : "s"} left` : "Full · waitlist"}${g.host?.name ? ` · ${esc(g.host.name)}` : ""}</span></span>
        <span class="btn-game btn-post-sm">View</span>
      </button>`).join("")
    : `<p class="map-empty">No games coming up here.</p>`;
}

function onSelAction(pg, e, meta) {
  const game = e.target.closest("[data-game]");
  if (game) { openGamePreview(game.dataset.game); return; }
  const act = e.target.closest("[data-act]")?.dataset.act;
  const v = pg.data?.venues.find((x) => x.id === pg.selId);
  if (!act || !v) return;
  if (act === "close") pg.select(null);
  if (act === "ladder") void openVenueSheet(v.id);
  if (act === "host") {
    openHostForm({ meta, venue: { id: v.id, name: v.name, address: v.address, lat: v.lat, lng: v.lng, kind: v.kind, indoor: v.indoor } });
  }
}

// ── formatting ────────────────────────────────────────────────────────

const perWeek = (games, weeks) => {
  const n = games / weeks;
  return n >= 10 ? Math.round(n).toString() : n.toFixed(1).replace(/\.0$/, "");
};
const hourText = (h) => (h === 0 ? "12 am" : h < 12 ? `${h} am` : h === 12 ? "noon" : `${h - 12} pm`);
const zoneName = (tz) => (tz === "America/Chicago" ? "Central time" : tz);
const nextText = (iso) => `${dayHeading(iso)} ${clockText(iso)}`;
