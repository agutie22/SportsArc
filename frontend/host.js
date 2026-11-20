/**
 * The "Host a game" sheet: sport, where, when and how many, with everything
 * else folded under "More options". Where searches the venues already on the
 * map (GET /api/venues) so games at the same court share one venue and one
 * regulars ladder; a new spot is pinned at the host's location or at
 * coordinates pasted from a map app, since check-in is geofenced to it.
 *
 * "Host again" copies one of the viewer's recent games (GET /api/my/hosted,
 * or a game passed in from the Manage sheet) onto the same weekday and time,
 * the next week that is still ahead. The last sport, length, size and
 * "I'm playing" are remembered in localStorage as conveniences only.
 *
 * After posting, the toast offers Share: the native share sheet where there
 * is one, else the #/games/<id> link is copied.
 */

import { $$, toast, openSheet, shareLink } from "./shared.js";
import { apiGet, apiSend, clockText, esc, titleCase, usd, whenLabel, sportIcon, getCoords } from "./api.js";
import { publishEvent } from "./events.js";

const DEFAULTS_KEY = "sportsarc.hostDefaults";
const DURATIONS = [30, 45, 60, 90, 120, 150, 180, 240];
const DAY_MS = 86400000;

const pad = (n) => String(n).padStart(2, "0");
const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
/** "18:30" → "6:30 PM". */
const timeLabel = (t) => {
  const [h, m] = t.split(":").map(Number);
  return clockText(new Date(2000, 0, 1, h, m));
};
const durationLabel = (m) => (m < 60 ? `${m} min` : m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m / 60} h`);

function loadDefaults() {
  try { return JSON.parse(localStorage.getItem(DEFAULTS_KEY) ?? "{}") ?? {}; } catch { return {}; }
}
function saveDefaults(d) {
  try { localStorage.setItem(DEFAULTS_KEY, JSON.stringify(d)); } catch { /* private mode */ }
}

/** Tonight at 6 if it is early enough, else tomorrow at 6. */
function defaultStart() {
  const d = new Date();
  if (d.getHours() >= 16) d.setDate(d.getDate() + 1);
  d.setHours(18, 0, 0, 0);
  return d;
}

/** The same weekday and time as `iso`, a week on, and never in the past. */
function nextOccurrence(iso) {
  const d = new Date(iso);
  d.setDate(d.getDate() + 7);
  while (d.getTime() < Date.now() + 30 * 60000) d.setDate(d.getDate() + 7);
  return d;
}

/** "34.05, -118.24" (what map apps copy) as { lat, lng }, or null. */
export function parseCoords(text) {
  const m = String(text).match(/(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

/** The link a game is shared with. */
const gameLink = (id) => `${location.origin}${location.pathname}#/games/${id}`;

/** Share a game: the native share sheet, else copy its link. */
export function shareGame(g) {
  return shareLink({
    title: "SportsArc game",
    text: `${titleCase(g.sport)} at ${g.venue.name}, ${whenLabel(g.startsAt)}. Join me on SportsArc.`,
    url: gameLink(g.id),
  });
}

/**
 * Open the sheet. `meta` is GET /api/meta, `coords` the viewer's last known
 * position, `again` a game to copy, `venue` a venue to start at (the Map's
 * "Host a game here"), `onPosted(game)` runs after posting.
 */
export function openHostForm({ meta, coords = null, again = null, venue = null, onPosted } = {}) {
  const sheet = openSheet({ id: "host-new", title: "Host a game", className: "sheet-hostnew" });
  const { body } = sheet;
  const sports = meta?.sports ?? ["basketball"];
  const kinds = meta?.venueKinds ?? ["park"];
  const skills = meta?.skillLevels ?? ["any"];
  const saved = loadDefaults();
  const start = defaultStart();

  const s = {
    coords,
    sport: sports.includes(saved.sport) ? saved.sport : "",
    venue: null,          // an existing venue
    spot: null,           // a new one: { name, kind, address, where: "here" | "paste", paste }
    query: "",
    results: [],
    day: isoDay(start),
    time: hhmm(start),
    otherDay: false,
    duration: DURATIONS.includes(saved.duration) ? saved.duration : 90,
    capacity: Number.isInteger(saved.capacity) ? saved.capacity : 10,
    plays: saved.plays !== false,
    skill: skills.includes("any") ? "any" : skills[0],
    notes: "",
    event: false,
    entryFee: 10,
    minPlayers: 4,
    prize: false,
    prizeAmount: "200",
    busy: false,
  };

  body.innerHTML = `
    <form class="hs" novalidate>
      <section class="hs-sec" data-again-box hidden>
        <span class="hs-label">Host again</span>
        <div class="hs-chips hs-scroll" data-again></div>
      </section>
      <section class="hs-sec">
        <span class="hs-label">Sport</span>
        <div class="hs-chips hs-scroll" data-sports></div>
      </section>
      <section class="hs-sec">
        <span class="hs-label">Where</span>
        <div data-where></div>
      </section>
      <section class="hs-sec">
        <span class="hs-label">When</span>
        <div class="hs-chips hs-scroll" data-days></div>
        <input type="date" class="hs-input" data-date hidden>
        <div class="hs-row">
          <select class="hs-input" data-time aria-label="Start time"></select>
          <span class="hs-for">for</span>
          <select class="hs-input" data-duration aria-label="How long"></select>
        </div>
      </section>
      <section class="hs-sec hs-split">
        <span class="hs-label">Players</span>
        <div class="hs-stepper">
          <button type="button" data-step="-1" aria-label="Fewer players">&minus;</button>
          <output data-capacity></output>
          <button type="button" data-step="1" aria-label="More players">+</button>
        </div>
      </section>
      <label class="hs-toggle" data-pickup-only>
        <input type="checkbox" data-plays>
        <span><strong>I'm playing</strong><small>Takes one of the spots. You can join later if you turn it off.</small></span>
      </label>
      <label class="hs-toggle">
        <input type="checkbox" data-event>
        <span><strong>Paid event</strong><small>People pay you to enter, or you put up a prize. You sign with your PIN.</small></span>
      </label>
      <section class="hs-sec" data-event-box hidden>
        <span class="hs-label">Entry fee</span>
        <div class="hs-chips" data-fees></div>
        <div class="hs-split">
          <span class="hs-label">Minimum to run</span>
          <div class="hs-stepper">
            <button type="button" data-min-step="-1" aria-label="Lower minimum">&minus;</button>
            <output data-min></output>
            <button type="button" data-min-step="1" aria-label="Raise minimum">+</button>
          </div>
        </div>
        <label class="hs-toggle">
          <input type="checkbox" data-prize>
          <span><strong>Prize · 60 / 30 / 10</strong><small>Optional. Winners are paid this, not the entry fees.</small></span>
        </label>
        <label class="hs-sec" data-prize-amt hidden>
          <span class="hs-label">Prize you put up</span>
          <input class="hs-input" data-prize-amount inputmode="decimal" placeholder="200">
        </label>
        <p class="hs-hint" data-receive></p>
      </section>
      <details class="hs-more">
        <summary>More options <span class="hs-more-sum" data-more-sum></span></summary>
        <div class="hs-more-body">
          <div class="hs-sec">
            <span class="hs-label">Skill level</span>
            <div class="hs-chips" data-skills></div>
          </div>
          <label class="hs-sec">
            <span class="hs-label">Notes</span>
            <input class="hs-input" data-notes maxlength="500" placeholder="Bring a light and dark shirt">
          </label>
        </div>
      </details>
      <div class="hs-foot">
        <p class="hs-summary" data-summary></p>
        <button type="submit" class="btn-game" data-post>Post game</button>
      </div>
    </form>`;

  const form = body.querySelector("form");
  const q = (sel) => body.querySelector(sel);

  // ── painting ──
  const chip = (attr, value, label, on) =>
    `<button type="button" class="chip${on ? " chip-active" : ""}" ${attr}="${esc(String(value))}" aria-pressed="${on}">${label}</button>`;

  function paintSports() {
    q("[data-sports]").innerHTML = sports
      .map((sp) => chip("data-sport", sp, `<span class="hs-ico">${sportIcon(sp)}</span>${titleCase(sp)}`, s.sport === sp)).join("");
  }

  function paintWhere() {
    const box = q("[data-where]");
    if (s.venue) {
      const v = s.venue;
      const sub = [v.distanceKm !== undefined ? `${v.distanceKm} km away` : "", titleCase(v.kind), v.address ?? ""]
        .filter(Boolean).join(" · ");
      box.innerHTML = `
        <div class="hs-venue">
          <div><strong>${esc(v.name)}</strong><small>${esc(sub)}</small></div>
          <button type="button" class="hs-link" data-venue-change>Change</button>
        </div>`;
      return;
    }
    if (s.spot) {
      const sp = s.spot;
      const here = sp.where === "here";
      box.innerHTML = `
        <div class="hs-venue hs-venue-new">
          <div><span class="hs-tag">New spot</span><strong>${esc(sp.name)}</strong></div>
          <button type="button" class="hs-link" data-venue-change>Change</button>
        </div>
        <div class="hs-spot">
          <div class="hs-chips">${kinds.map((k) => chip("data-kind", k, titleCase(k), sp.kind === k)).join("")}</div>
          <input class="hs-input" data-spot-address maxlength="255" placeholder="Address (optional)" value="${esc(sp.address)}">
          <div class="hs-chips">
            ${chip("data-spot-where", "here", "I'm there now", here)}
            ${chip("data-spot-where", "paste", "Paste from a map", !here)}
          </div>
          ${here
            ? `<small class="hs-hint">${s.coords ? "Pinned where you are now." : "We'll use your location."} Check-in only works near this point.</small>`
            : `<input class="hs-input" data-spot-paste inputmode="decimal" placeholder="34.0522, -118.2437" value="${esc(sp.paste)}">
               <small class="hs-hint">In your map app, long-press the court and copy its coordinates. Check-in only works near this point.</small>`}
        </div>`;
      return;
    }
    box.innerHTML = `
      <input class="hs-input" data-venue-q type="search" autocomplete="off"
        placeholder="Search parks, courts and gyms" value="${esc(s.query)}">
      <div class="hs-results" data-venue-results></div>`;
    paintResults();
  }

  function paintResults() {
    const box = q("[data-venue-results]");
    if (!box) return;
    const name = s.query.trim();
    const rows = s.results.slice(0, 6).map((v, i) => `
      <button type="button" class="hs-result" data-pick="${i}">
        <strong>${esc(v.name)}</strong>
        <small>${esc([v.distanceKm !== undefined ? `${v.distanceKm} km` : "", titleCase(v.kind), v.address ?? ""].filter(Boolean).join(" · "))}</small>
      </button>`).join("");
    const add = name
      ? `<button type="button" class="hs-result hs-result-add" data-new-spot>+ Add &ldquo;${esc(name)}&rdquo; as a new spot</button>`
      : "";
    const locate = !s.coords
      ? `<button type="button" class="hs-link hs-locate" data-locate>Use my location to see spots nearby</button>`
      : "";
    box.innerHTML = rows + add + locate;
  }

  function paintDays() {
    const today = new Date();
    const lastStart = new Date(); lastStart.setHours(23, 0, 0, 0);
    const days = [];
    for (let i = today.getTime() < lastStart.getTime() ? 0 : 1; days.length < 7; i++) {
      const d = new Date(today.getTime() + i * DAY_MS);
      const label = i === 0 ? "Today" : i === 1 ? "Tomorrow"
        : `${d.toLocaleDateString([], { weekday: "short" })} ${d.getDate()}`;
      days.push([isoDay(d), label]);
    }
    const listed = days.some(([v]) => v === s.day);
    if (!listed) s.otherDay = true;
    q("[data-days]").innerHTML =
      days.map(([v, l]) => chip("data-day", v, l, !s.otherDay && s.day === v)).join("") +
      chip("data-day", "other", s.otherDay ? new Date(`${s.day}T12:00`).toLocaleDateString([], { month: "short", day: "numeric" }) : "Other date", s.otherDay);
    const date = q("[data-date]");
    date.hidden = !s.otherDay;
    date.min = isoDay(today);
    date.value = s.day;
  }

  function paintTime() {
    const times = [];
    for (let m = 5 * 60; m < 24 * 60; m += 15) times.push(`${pad(Math.floor(m / 60))}:${pad(m % 60)}`);
    if (!times.includes(s.time)) { times.push(s.time); times.sort(); }
    q("[data-time]").innerHTML = times.map((t) => `<option value="${t}"${t === s.time ? " selected" : ""}>${timeLabel(t)}</option>`).join("");
    const durs = DURATIONS.includes(s.duration) ? DURATIONS : [...DURATIONS, s.duration].sort((a, b) => a - b);
    q("[data-duration]").innerHTML = durs.map((d) => `<option value="${d}"${d === s.duration ? " selected" : ""}>${durationLabel(d)}</option>`).join("");
  }

  const FEES = [0, 5, 10, 20];

  /** What the host keeps if the event fills, after 1% plus 1¢ per entry. */
  function receiveLine() {
    const fee = Number(s.entryFee) || 0;
    if (!s.event) return "";
    if (!fee && s.prize) return "No entry fee. The prize is paid to the winners, not to you.";
    if (!fee) return "Add an entry fee or a prize. With neither, this is a pickup game.";
    const cut = Math.min(fee, Math.round((fee * 0.01 + 0.01) * 100) / 100);
    const total = (fee - cut) * s.capacity;
    return `${s.capacity} players × ${usd(fee, { short: true })} → you receive ${usd(total, { short: true })}`;
  }

  function paintEvent() {
    q("[data-event]").checked = s.event;
    q("[data-event-box]").hidden = !s.event;
    q("[data-prize]").checked = s.prize;
    q("[data-prize-amt]").hidden = !(s.event && s.prize);
    q("[data-prize-amount]").value = s.prizeAmount;
    body.querySelectorAll("[data-pickup-only]").forEach((el) => { el.hidden = s.event; });
    if (s.minPlayers > s.capacity) s.minPlayers = s.capacity;
    if (s.minPlayers < 1) s.minPlayers = 1;
    q("[data-min]").textContent = String(s.minPlayers);
    const down = q("[data-min-step='-1']");
    const up = q("[data-min-step='1']");
    if (down) down.disabled = s.minPlayers <= 1;
    if (up) up.disabled = s.minPlayers >= s.capacity;
    q("[data-fees]").innerHTML = FEES.map((n) => chip("data-fee", n, n ? `$${n}` : "Free", Number(s.entryFee) === n)).join("");
    q("[data-receive]").textContent = receiveLine();
    q("[data-post]").textContent = s.event ? "Post event" : "Post game";
  }

  function paintPlayers() {
    q("[data-capacity]").textContent = String(s.capacity);
    q("[data-step='-1']").disabled = s.capacity <= 2;
    q("[data-step='1']").disabled = s.capacity >= 100;
    q("[data-plays]").checked = s.plays;
    paintEvent();
  }

  function paintMore() {
    q("[data-skills]").innerHTML = skills.map((k) => chip("data-skill", k, titleCase(k), s.skill === k)).join("");
    q("[data-notes]").value = s.notes;
    paintMoreSum();
  }

  function paintMoreSum() {
    const bits = [s.skill !== "any" ? titleCase(s.skill) : "", s.notes ? "Notes" : ""]
      .filter(Boolean);
    q("[data-more-sum]").textContent = bits.length ? `· ${bits.join(" · ")}` : "";
  }

  const startsAt = () => new Date(`${s.day}T${s.time}`);
  const spotCoords = () => (s.spot?.where === "paste" ? parseCoords(s.spot.paste) : s.coords);

  /** What still blocks posting, or "" when the game can go up. */
  function missing() {
    if (!s.sport) return "Pick a sport.";
    if (!s.venue && !s.spot) return "Pick where you'll play.";
    if (s.spot && s.spot.where === "paste" && !parseCoords(s.spot.paste)) return "Paste the spot's coordinates.";
    if (Number.isNaN(startsAt().getTime())) return "Pick a day.";
    if (startsAt().getTime() <= Date.now()) return "That time has already passed.";
    if (s.event && !Number(s.entryFee) && !s.prize) return "An event needs an entry fee or a prize.";
    if (s.event && s.prize && s.prizeAmount && Number(s.prizeAmount) <= 0) return "The prize amount needs to be more than zero.";
    return "";
  }

  function paintSummary() {
    const why = missing();
    const where = s.venue?.name ?? s.spot?.name;
    q("[data-summary]").innerHTML = why
      ? `<span class="hs-dim">${esc(why)}</span>`
      : `<strong>${esc(titleCase(s.sport))}</strong> at ${esc(where)} · ${esc(whenLabel(startsAt().toISOString()))} · ${s.capacity} players`;
    q("[data-post]").disabled = Boolean(why) || s.busy;
  }

  function paintAll() {
    paintSports(); paintWhere(); paintDays(); paintTime(); paintPlayers(); paintMore(); paintSummary();
  }

  // ── venues ──
  let searchSeq = 0;
  let searchTimer = 0;
  async function search() {
    const seq = ++searchSeq;
    const params = { q: s.query.trim() || undefined };
    if (s.coords) Object.assign(params, { lat: s.coords.lat, lng: s.coords.lng, radiusKm: 50 });
    if (!params.q && !s.coords) { s.results = []; paintResults(); return; }
    try {
      const r = await apiGet("/api/venues", params);
      if (seq !== searchSeq || !body.isConnected) return;
      s.results = r.venues ?? [];
    } catch {
      s.results = [];
    }
    paintResults();
  }

  async function locate(btn) {
    if (btn) { btn.disabled = true; btn.textContent = "Locating…"; }
    const c = await getCoords();
    if (!body.isConnected) return null;
    if (!c) toast("Could not get your location.");
    else s.coords = c;
    return c;
  }

  // ── host again ──
  function applyAgain(g) {
    const when = nextOccurrence(g.startsAt);
    Object.assign(s, {
      sport: sports.includes(g.sport) ? g.sport : s.sport,
      venue: g.venue, spot: null, query: "",
      day: isoDay(when), time: hhmm(when), otherDay: false,
      duration: g.durationMinutes, capacity: g.capacity,
      plays: g.hostPlays !== false,
      skill: skills.includes(g.skillLevel) ? g.skillLevel : s.skill,
      notes: g.notes ?? "",
    });
    paintAll();
  }

  async function loadAgain() {
    let games = [];
    try { games = (await apiGet("/api/my/hosted")).games ?? []; } catch { return; }
    if (!games.length || !body.isConnected) return;
    q("[data-again-box]").hidden = false;
    q("[data-again]").innerHTML = games.map((g, i) => {
      const d = new Date(g.startsAt);
      const when = `${d.toLocaleDateString([], { weekday: "short" })} ${timeLabel(hhmm(d))}`;
      return `<button type="button" class="chip hs-again" data-again-i="${i}">
        <span class="hs-ico">${sportIcon(g.sport)}</span>${esc(g.venue.name)} · ${esc(when)}</button>`;
    }).join("");
    q("[data-again]").addEventListener("click", (e) => {
      const b = e.target.closest("[data-again-i]");
      if (!b) return;
      $$("[data-again-i]", body).forEach((x) => x.classList.toggle("chip-active", x === b));
      void applyAgain(games[Number(b.dataset.againI)]);
    });
  }

  // ── events ──
  form.addEventListener("click", async (e) => {
    const t = e.target.closest("button");
    if (!t || t.disabled) return;
    const d = t.dataset;
    if (d.sport !== undefined) { s.sport = d.sport; paintSports(); }
    else if (d.day !== undefined) {
      if (d.day === "other") {
        s.otherDay = true; paintDays();
        const date = q("[data-date]");
        try { date.showPicker?.(); } catch { date.focus(); }
      } else { s.day = d.day; s.otherDay = false; paintDays(); }
    }
    else if (d.step !== undefined) { s.capacity = Math.min(100, Math.max(2, s.capacity + Number(d.step))); paintPlayers(); }
    else if (d.skill !== undefined) { s.skill = d.skill; paintMore(); }
    else if (d.fee !== undefined) { s.entryFee = Number(d.fee); paintEvent(); }
    else if (d.minStep !== undefined) {
      s.minPlayers = Math.min(s.capacity, Math.max(1, s.minPlayers + Number(d.minStep)));
      paintEvent();
    }
    else if (d.pick !== undefined) { s.venue = s.results[Number(d.pick)]; paintWhere(); }
    else if (d.newSpot !== undefined) {
      s.spot = { name: s.query.trim().slice(0, 160), kind: kinds[0], address: "", where: s.coords ? "here" : "paste", paste: "" };
      paintWhere();
    }
    else if (d.venueChange !== undefined) {
      s.venue = null; s.spot = null; paintWhere();
      q("[data-venue-q]")?.focus();
      void search();
    }
    else if (d.kind !== undefined) { s.spot.kind = d.kind; paintWhere(); }
    else if (d.spotWhere !== undefined) {
      if (d.spotWhere === "here" && !s.coords && !(await locate(t))) { paintWhere(); paintSummary(); return; }
      s.spot.where = d.spotWhere; paintWhere();
    }
    else if (d.locate !== undefined) { if (await locate(t)) void search(); else paintResults(); }
    else return;
    paintSummary();
  });

  form.addEventListener("input", (e) => {
    const t = e.target;
    if (t.matches("[data-venue-q]")) {
      s.query = t.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(search, 220);
    } else if (t.matches("[data-spot-address]")) s.spot.address = t.value;
    else if (t.matches("[data-spot-paste]")) s.spot.paste = t.value;
    else if (t.matches("[data-notes]")) { s.notes = t.value; paintMoreSum(); }
    else if (t.matches("[data-prize-amount]")) { s.prizeAmount = t.value; paintEvent(); }
    paintSummary();
  });

  form.addEventListener("change", (e) => {
    const t = e.target;
    if (t.matches("[data-time]")) s.time = t.value;
    else if (t.matches("[data-duration]")) s.duration = Number(t.value);
    else if (t.matches("[data-plays]")) s.plays = t.checked;
    else if (t.matches("[data-event]")) { s.event = t.checked; paintEvent(); }
    else if (t.matches("[data-prize]")) { s.prize = t.checked; paintEvent(); }
    else if (t.matches("[data-date]") && t.value) { s.day = t.value; paintDays(); }
    paintSummary();
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (missing() || s.busy) return;
    if (s.spot?.where === "here" && !s.coords && !(await locate())) return;
    s.busy = true;
    paintSummary();
    const venue = s.venue
      ? { venueId: s.venue.id }
      : { venue: { name: s.spot.name, address: s.spot.address.trim() || undefined, kind: s.spot.kind, ...spotCoords() } };
    try {
      const { game } = await apiSend("/api/games", "POST", {
        sport: s.sport,
        startsAt: startsAt().toISOString(),
        durationMinutes: s.duration,
        capacity: s.capacity,
        skillLevel: s.skill,
        notes: s.notes.trim() || undefined,
        hostPlays: s.event ? false : s.plays,
        kind: s.event ? "event" : "pickup",
        ...venue,
      });
      saveDefaults({ sport: s.sport, duration: s.duration, capacity: s.capacity, plays: s.plays });
      let msg = s.event ? "Event posted." : "Game posted.";
      if (s.event) {
        try {
          await publishEvent(game, {
            entryFee: Number(s.entryFee) || 0,
            minPlayers: s.minPlayers,
            prize: s.prize,
            prizeAmount: s.prize && s.prizeAmount ? s.prizeAmount : "",
          });
        } catch (err) {
          msg = err.message.startsWith("The event is open")
            ? err.message
            : `The game is up, but the event is not open yet: ${err.message}`;
        }
      }
      sheet.close();
      toast(msg, { action: { label: "Share", onClick: () => void shareGame(game) } });
      onPosted?.(game);
    } catch (err) {
      toast(err.message);
      s.busy = false;
      if (body.isConnected) paintSummary();
    }
  });

  // ── start ──
  if (venue && !again) s.venue = venue;
  paintAll();
  void loadAgain();
  if (again) void applyAgain(again);
  else if (!s.coords && !s.venue) {
    // Ask for nothing on open; use the location only if it is already allowed.
    navigator.permissions?.query({ name: "geolocation" })
      .then((p) => { if (p.state === "granted") return locate().then((c) => c && !s.venue && !s.spot && search()); })
      .catch(() => {});
  } else void search();
}
