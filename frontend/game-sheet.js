/**
 * The sheets a player meets around one game, before and after joining:
 *
 *  - the game itself (tap a card or row): when, level, where, cost, who is
 *    playing and how reliably they show up, the host's notes, and the next
 *    thing to do in a pinned footer. On desktop it docks to the right, and
 *    ↑ / ↓ step through the list it was opened from;
 *  - "You're in" after a join, or where you are on the waitlist;
 *  - leaving, saying who gets the spot and that leaving before check-in
 *    closes is not counted (social/reliability.ts);
 *  - check-in, drawing the venue's geofence with you on it;
 *  - the card's "more" menu as an action sheet on phones.
 *
 * game-card.js decides when each opens and runs every action; these only
 * render, and hand clicks back through `handle`. The check-in rules (window,
 * radius) come from GET /api/meta, never restated here.
 */

import { openSheet, getUser, ICON, showsUp } from "./shared.js";
import { fetchGameRecord, gameRecordLine, openGameReceipt, paintCounts } from "./record.js";
import { apiGet, clockText, esc, ordinal, titleCase, sportIcon, avatar, getCoords, loadMeta } from "./api.js";
import { eventCost } from "./events.js";

const LEVEL = (g) => (g.skillLevel === "any" ? "All levels" : titleCase(g.skillLevel));
const dayTime = (iso) => {
  const d = new Date(iso);
  return `${d.toLocaleDateString([], { weekday: "short" })} ${clockText(d)}`;
};
const PHONE = "(max-width: 760px)";

/** Directions to the venue in the viewer's maps app. Only the venue's coordinates are sent. */
export const mapsUrl = (v) => `https://www.google.com/maps/dir/?api=1&destination=${v.lat},${v.lng}`;

/** "in 3 days", "in 4 hours", "in 20 min", "started". */
function fromNow(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "started";
  const min = Math.round(ms / 60000);
  if (min < 60) return `in ${min} min`;
  const h = Math.round(min / 60);
  if (h < 36) return `in ${h} hour${h === 1 ? "" : "s"}`;
  const d = Math.round(h / 24);
  return `in ${d} days`;
}


// ── the game ──────────────────────────────────────────────────────────

/**
 * Open one game. `painted` is the copy the list drew (for its distance),
 * `ids` the list's order for ↑ / ↓, `controlsOf(g)` the card's controls,
 * and `handle(el)` runs a clicked control as the card would. `modal` opens
 * it as a centred dialog on desktop instead of the docked drawer (Home's
 * preview, game-preview.js); phones get the bottom sheet either way.
 */
export function openGameSheet(id, { painted, ids = [], controlsOf, handle, modal = false }) {
  const s = openSheet({ id: "game-sheet", title: "Game", className: "sheet-game", bottom: true, footer: true, drawer: !modal });
  const state = { id, seq: 0, rec: null };

  async function show(gameId) {
    state.id = gameId;
    const seq = ++state.seq;
    s.body.innerHTML = `<div class="skel skel-line" style="width:55%;height:30px"></div>
      <div class="skel skel-line" style="width:80%"></div><div class="skel skel-line" style="width:65%"></div>`;
    s.foot.innerHTML = "";
    let g, roster, meta, cost;
    try {
      [g, roster, meta] = await Promise.all([
        apiGet(`/api/games/${gameId}`).then((b) => b.game),
        getUser() ? apiGet(`/api/games/${gameId}/roster`).then((b) => b.players).catch(() => ({})) : {},
        loadMeta().catch(() => null),
      ]);
      cost = g.kind === "event" ? await eventCost(g.id) : null;
    } catch (err) {
      if (seq === state.seq) s.body.innerHTML = `<p class="empty empty-sm">${esc(err.message)}</p>`;
      return;
    }
    if (seq !== state.seq || !s.sheet.isConnected) return;
    const p = painted(gameId);
    if (p?.distanceKm !== undefined) g.distanceKm = p.distanceKm;
    s.sheet.querySelector(".sheet-title").textContent =
      g.kind === "event" ? `${titleCase(g.sport)} event` : `Pickup ${titleCase(g.sport).toLowerCase()}`;
    s.body.innerHTML = gameBody(g, roster ?? {}, meta, cost);
    s.foot.innerHTML = gameFoot(g, controlsOf(g), cost);
    state.rec = null;
    if (getUser()) void paintCounts(s.body, g.players.map((p) => p.id));
    // Where your seat stands on the public record, once there is something to say.
    if (g.viewerStatus === "joined" && (g.viewerCheckedIn || g.checkInWindow === "closed")) {
      const rec = await fetchGameRecord(gameId);
      const line = gameRecordLine(rec);
      if (seq !== state.seq || !s.sheet.isConnected || !line) return;
      state.rec = rec;
      s.body.insertAdjacentHTML("afterbegin", line);
    }
  }

  s.sheet.addEventListener("click", (e) => {
    if (e.target.closest("[data-gs-receipt]")) { openGameReceipt(state.rec); return; }
    const more = e.target.closest("[data-roster-all]");
    if (more) { s.body.querySelector(".gs-roster").classList.add("is-all"); more.remove(); return; }
    const t = e.target.closest("[data-join], [data-leave], [data-event-leave], [data-enter], [data-manage], [data-result], [data-share], [data-checkin], [data-venue]");
    if (!t || t.disabled) return;
    // Share and the venue stack on top; every other action replaces this sheet.
    if (!t.dataset.share && !t.dataset.venue) s.close();
    handle(t);
  });

  const onKey = (e) => {
    if (!s.sheet.isConnected) { document.removeEventListener("keydown", onKey); return; }
    if (matchMedia(PHONE).matches || e.target.closest?.("input, textarea, select")) return;
    if ([...document.querySelectorAll(".sheet")].pop() !== s.sheet) return;
    const i = ids.indexOf(state.id);
    if (i < 0 || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
    const next = ids[i + (e.key === "ArrowDown" ? 1 : -1)];
    if (next) { e.preventDefault(); void show(next); }
  };
  document.addEventListener("keydown", onKey);
  void show(id);
}

function gameBody(g, roster, meta, cost) {
  const start = new Date(g.startsAt);
  const end = new Date(start.getTime() + g.durationMinutes * 60000);
  const filled = Math.min(100, Math.round((100 * g.joinedCount) / Math.max(1, g.capacity)));
  const venueSub = [g.venue.indoor ? "Indoor" : "Outdoor", titleCase(g.venue.kind), g.distanceKm !== undefined ? `${g.distanceKm} km` : ""]
    .filter(Boolean).join(" · ");
  const costTile = g.kind === "event"
    ? `<div class="gs-tile${cost?.free ? " is-free" : ""}"><span>Entry</span><strong>${esc(cost?.label ?? "Paid event")}</strong>${cost?.sub ? `<small>${esc(cost.sub)}</small>` : ""}</div>`
    : `<div class="gs-tile is-free"><span>Cost</span><strong>Free</strong><small>No deposit</small></div>`;

  const recruiters = g.players.filter((p) => roster[p.id]?.recruiter && p.id !== getUser()?.id);
  const banner = recruiters.length
    ? `<div class="gs-spot">${avatar(recruiters[0], "xs")}<span><b>${recruiters.length === 1
        ? `A ${esc(roster[recruiters[0].id].recruiter.role)} is playing.`
        : `${recruiters.length} coaches and scouts are playing.`}</b> ${recruiters.slice(0, 2).map((p) => {
          const r = roster[p.id].recruiter;
          return `${esc(p.name ?? "Someone")}${r.school ? ` (${esc(r.school)})` : ""}`;
        }).join(", ")}</span></div>`
    : "";

  const me = getUser()?.id;
  const rows = g.players.map((p) => playerRow(p, roster[p.id], me)).join("");
  const shared = g.players.filter((p) => roster[p.id]?.sharedGames && p.id !== me).length;
  const rules = meta?.checkIn;
  const how = g.kind === "event" || !rules ? "" : `
    <details class="gs-how">
      <summary>How free games work</summary>
      <ul class="gs-facts">
        <li>${ICON.logout}<span>Leave any time before check-in closes and it isn't counted against you.</span></li>
        <li>${ICON.pin}<span>Check in from <b>${esc(dayTime(g.checkInOpensAt))}</b>, within ${rules.radiusM} m of the venue. Check-in closes ${rules.graceMinAfter} min after the start.</span></li>
        <li>${ICON.trophy}<span>The host records the result. It goes on the record of everyone who checked in.</span></li>
      </ul>
    </details>`;

  return `
    ${g.status === "cancelled" ? `<p class="res-note">This game was cancelled.</p>` : ""}
    <div class="gs-hero">
      <span class="gs-icon">${sportIcon(g.sport)}</span>
      <div><strong class="gs-when">${esc(dayTime(g.startsAt))}</strong>
        <span>${esc(start.toLocaleDateString([], { month: "short", day: "numeric" }))} · ${esc(clockText(start))}–${esc(clockText(end))} · ${esc(fromNow(g.startsAt))}</span></div>
    </div>
    <div class="gs-tiles">
      <div class="gs-tile"><span>Spots</span><strong>${g.joinedCount} of ${g.capacity}</strong>
        <i class="gs-bar"><b style="width:${filled}%"></b></i>${g.waitlistCount ? `<small>${g.waitlistCount} waiting</small>` : ""}</div>
      <div class="gs-tile"><span>Level</span><strong>${esc(LEVEL(g))}</strong><small>${g.durationMinutes} min</small></div>
      <button type="button" class="gs-tile" data-venue="${esc(g.venue.id)}" title="See the regulars here">
        <span>Where ›</span><strong>${esc(g.venue.name)}</strong><small>${esc(venueSub)}</small></button>
      ${costTile}
    </div>
    ${banner}
    <section class="gs-sec">
      <h4 class="res-label">Who's playing <em>${g.joinedCount} in${shared ? ` · ${shared} played with you` : ""}</em></h4>
      ${g.players.length
        ? `<ul class="gs-roster">${rows}</ul>${g.players.length > 6
          ? `<button type="button" class="gs-more" data-roster-all>See all ${g.players.length}</button>` : ""}`
        : `<p class="res-hint">Nobody has joined yet. Be the first.</p>`}
      ${g.hostPlays ? "" : `<p class="res-hint">Hosted by ${esc(g.host?.name ?? "someone")}, who isn't playing.</p>`}
    </section>
    ${g.notes ? `<p class="gs-quote"><b>From the host</b>${esc(g.notes)}</p>` : ""}
    ${how}`;
}

function playerRow(p, r, me) {
  const tags = [
    p.roles.includes("host") ? `<span class="gs-tag">Host</span>` : "",
    p.roles.includes("cohost") ? `<span class="gs-tag gs-tag-co">Co-host</span>` : "",
    p.id === me ? `<span class="res-you">You</span>` : "",
    r?.recruiter ? `<span class="gs-tag gs-tag-coach">${esc(titleCase(r.recruiter.role))}</span>` : "",
    r?.sharedGames && p.id !== me
      ? `<span class="gs-tag gs-tag-pw">Played with you${r.sharedGames > 1 ? ` ×${r.sharedGames}` : ""}</span>` : "",
    r?.venueRank ? `<span class="gs-tag gs-tag-reg">#${r.venueRank} regular here</span>` : "",
  ].join("");
  const rel = r ? showsUp(r.reliability) : null;
  return `<li class="gs-player">
    ${avatar(p, "xs", { href: `#/u/${p.id}` })}
    <div><a href="#/u/${esc(p.id)}">${esc(p.name ?? "Player")}</a>
      <span>${tags}${r ? `<em class="${rel?.low ? "is-low" : ""}" data-rec-person="${esc(p.id)}">${esc(rel?.text ?? "New")}</em>` : ""}</span></div>
  </li>`;
}

/** The footer: share, then what the viewer can do next, then one line saying what it means. */
function gameFoot(g, c, cost) {
  const share = g.status === "cancelled" ? ""
    : `<button type="button" class="icon-btn gs-share" data-share="${esc(g.id)}" aria-label="Share link" title="Share link">${ICON.share}</button>`;
  const joined = g.viewerStatus === "joined";
  const main = c.main.replace("<button ", "<button data-primary ");
  const leave = c.canLeave
    ? `<button type="button" class="btn-game btn-game-ghost" ${g.kind === "event" ? "data-event-leave" : "data-leave"}="${esc(g.id)}">${
      g.viewerStatus === "waitlist" ? "Leave waitlist" : "Leave"}</button>` : "";
  const manage = g.viewerRole && c.kind !== "manage"
    ? `<button type="button" class="btn-game btn-game-ghost" data-manage="${esc(g.id)}">Manage</button>` : "";
  const directions = joined && g.checkInWindow !== "closed"
    ? `<a class="btn-game btn-game-ghost" href="${esc(mapsUrl(g.venue))}" target="_blank" rel="noopener">${ICON.pin}Directions</a>` : "";

  let note = "";
  if (g.status === "cancelled") note = "";
  else if (g.viewerStatus === "waitlist") note = `You're ${ordinal(g.viewerWaitlistPosition ?? 1)} on the waitlist. You move in automatically if someone leaves.`;
  else if (joined && g.viewerCheckedIn) note = "You're checked in.";
  else if (joined && g.checkInWindow === "early") note = `You're in. Check-in opens ${dayTime(g.checkInOpensAt)}.`;
  else if (joined && g.checkInWindow === "open") note = `Check-in is open until ${clockText(new Date(g.checkInClosesAt))}.`;
  else if (c.kind === "join" && g.spotsLeft === 0) note = `Full. You'd be ${ordinal(g.waitlistCount + 1)} in line and move in automatically if someone leaves.`;
  else if (c.kind === "join") note = `${g.spotsLeft} spot${g.spotsLeft === 1 ? "" : "s"} left. Free, and leaving before check-in closes isn't counted.`;
  else if (c.kind === "register") note = cost?.free ? "Nothing is charged. Your PIN signs your entry." : "You confirm the entry with your PIN.";

  // `c.link` is an extra way out a caller adds, e.g. Home's "Open in Games".
  const buttons = [share, leave, manage, directions, c.link ?? "", main].filter(Boolean).join("");
  if (!buttons && !note) return "";
  return `<div class="gs-foot-row">${buttons}</div>${note ? `<small class="gs-foot-note">${esc(note)}</small>` : ""}`;
}

// ── after joining ─────────────────────────────────────────────────────

/** "You're in" (or where you are on the waitlist), with what happens next. */
export function openJoinedSheet(g, { onShare }) {
  const wait = g.viewerStatus === "waitlist";
  const { body, foot, close } = openSheet({ id: "joined-sheet", title: wait ? "Waitlist" : "You're in", className: "sheet-game sheet-small", bottom: true, footer: true });
  const me = getUser()?.id;
  const others = g.players.filter((p) => p.id !== me);
  const pos = g.viewerWaitlistPosition ?? 1;
  const start = new Date(g.startsAt);
  const steps = wait
    ? [
        ["Now", `${ordinal(pos)} in line`, `The game is full at ${g.capacity}.`, true],
        ["If someone leaves", "You move in automatically", "Their spot goes to the first in line."],
        [dayTime(g.checkInOpensAt), "Check-in opens", "Only players in the game can check in."],
      ]
    : [
        ["Now", "You have a spot", "Free. Leave before check-in closes and it isn't counted.", true],
        [dayTime(g.checkInOpensAt), "Check-in opens", "Be at the venue and tap Check in."],
        [dayTime(g.startsAt), "Game starts", "The host sets the sides and starts it."],
        ["After", "The result goes on your record", "Only if you checked in."],
      ];
  body.innerHTML = `
    <div class="gs-done">
      <span class="gs-done-ic${wait ? " is-wait" : ""}">${wait ? esc(ordinal(pos)) : ICON.check}</span>
      <strong>${wait ? "On the waitlist" : "You're in"}</strong>
      <span>${esc(dayTime(g.startsAt))} · ${esc(start.toLocaleDateString([], { month: "short", day: "numeric" }))} · ${esc(g.venue.name)}</span>
    </div>
    ${others.length ? `<div class="gs-faces"><div>${others.slice(0, 4).map((p) => avatar(p, "xs")).join("")}</div>
      <span>${esc(others.slice(0, 2).map((p) => p.name ?? "Someone").join(" and "))}${others.length > 2 ? ` and ${others.length - 2} other${others.length === 3 ? "" : "s"}` : ""} ${others.length === 1 ? "is" : "are"} playing</span></div>` : ""}
    <ol class="gs-steps">${steps.map(([when, what, sub, now]) =>
      `<li${now ? ` class="is-now"` : ""}><time>${esc(when)}</time><strong>${esc(what)}</strong><small>${esc(sub)}</small></li>`).join("")}</ol>`;
  foot.innerHTML = `<div class="gs-foot-row">
    <button type="button" class="btn-game btn-game-ghost" data-invite>${ICON.share}Invite a friend</button>
    <button type="button" class="btn-game" data-primary data-done>Done</button></div>`;
  foot.querySelector("[data-invite]").addEventListener("click", () => onShare(g));
  foot.querySelector("[data-done]").addEventListener("click", close);
}

// ── leaving ───────────────────────────────────────────────────────────

/** Ask before leaving, saying what it costs. `onLeave` does it; the sheet closes once it succeeds. */
export function openLeaveSheet(g, { event = false, onLeave }) {
  const wait = g.viewerStatus === "waitlist";
  const title = wait ? "Leave the waitlist?" : event ? "Leave this event?" : "Leave this game?";
  const { body, foot, close } = openSheet({ id: "leave-sheet", title, className: "sheet-game sheet-small", bottom: true, footer: true });
  const facts = wait
    ? [
        [ICON.people, `You're ${ordinal(g.viewerWaitlistPosition ?? 1)} in line and will lose your place.`],
        [ICON.check, "Waiting doesn't affect your show-up rate."],
      ]
    : [
        [ICON.people, g.waitlistCount ? "Your spot goes to the first person on the waitlist." : "Your spot opens up for anyone to join."],
        [ICON.check, "<b>Not counted as a no-show.</b> Only players still in the game when check-in closes are counted."],
        event
          ? [ICON.dollar, "Any entry fee you paid comes back to you."]
          : [ICON.ball, "It's free, so there's nothing to refund. You can join again while there's room."],
      ];
  body.innerHTML = `
    ${ticket(g)}
    <ul class="gs-facts">${facts.map(([icon, text]) => `<li>${icon}<span>${text}</span></li>`).join("")}</ul>
    <p class="res-error" role="alert" hidden></p>`;
  foot.innerHTML = `<div class="gs-foot-row">
    <button type="button" class="btn-game btn-game-ghost" data-stay>Stay in</button>
    <button type="button" class="btn-game btn-game-bad" data-go>${wait ? "Leave waitlist" : event ? "Leave event" : "Leave game"}</button></div>`;
  foot.querySelector("[data-stay]").addEventListener("click", close);
  foot.querySelector("[data-go]").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try { await onLeave(); close(); }
    catch (err) {
      const box = body.querySelector(".res-error");
      box.textContent = err.message; box.hidden = false;
      btn.disabled = false;
    }
  });
}

function ticket(g) {
  return `<div class="gs-ticket"><span class="gs-icon">${sportIcon(g.sport)}</span>
    <div><strong>${esc(dayTime(g.startsAt))}</strong><span>${esc(g.venue.name)} · ${esc(titleCase(g.sport))}</span></div></div>`;
}

// ── check-in ──────────────────────────────────────────────────────────

/** Metres east and north of the venue, close enough at a park's scale. */
function offsetM(from, venue) {
  const k = 111_320;
  return {
    x: (from.lng - venue.lng) * k * Math.cos((venue.lat * Math.PI) / 180),
    y: (from.lat - venue.lat) * 110_540,
  };
}

/**
 * Check in at the venue: find the viewer, show them against the geofence,
 * and post only when they are inside it. The server decides; a refusal is
 * shown where the button was. `checkIn(coords)` posts, and resolves once
 * the lists are fresh.
 */
export async function openCheckInSheet(g, { checkIn }) {
  const { sheet, body, foot, close } = openSheet({ id: "checkin-sheet", title: "Check in", className: "sheet-game sheet-small", bottom: true, footer: true });
  const meta = await loadMeta().catch(() => null);
  const radius = meta?.checkIn?.radiusM;
  const head = sheet.querySelector(".sheet-head");
  const left = Math.max(0, Math.round((new Date(g.checkInClosesAt).getTime() - Date.now()) / 60000));
  head.querySelector(".sheet-title").insertAdjacentHTML("afterend", `<span class="res-status res-tone-live">Open · ${left} min left</span>`);

  body.innerHTML = `
    <div class="gs-radar" data-state="locating">
      <i class="gs-radar-ring"></i><i class="gs-radar-zone"></i><i class="gs-radar-court"></i><i class="gs-radar-me" hidden></i>
    </div>
    <p class="gs-radar-key">${radius ? `Green ring: ${radius} m around ${esc(g.venue.name)}` : esc(g.venue.name)}</p>
    <div class="gs-geo"><strong data-head>Finding you…</strong><span data-sub>Checking you're near ${esc(g.venue.name)}</span></div>`;
  const radar = body.querySelector(".gs-radar");
  const me = body.querySelector(".gs-radar-me");
  const setText = (h, sub) => { body.querySelector("[data-head]").textContent = h; body.querySelector("[data-sub]").textContent = sub; };

  const paintFoot = (mode, coords) => {
    const note = "Your location is used once, to confirm you're at the venue.";
    if (mode === "near") {
      foot.innerHTML = `<button type="button" class="btn-game" data-primary data-go>${ICON.pin}Check in</button><small class="gs-foot-note">${note}</small>`;
      foot.querySelector("[data-go]").addEventListener("click", async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true; btn.textContent = "Checking in…";
        try { await checkIn(coords); close(); }
        catch (err) { setText("Not checked in", err.message); paintFoot("far", coords); }
      });
    } else if (mode === "far") {
      foot.innerHTML = `<div class="gs-foot-row"><a class="btn-game btn-game-ghost" href="${esc(mapsUrl(g.venue))}" target="_blank" rel="noopener">${ICON.pin}Directions</a>
        <button type="button" class="btn-game" data-primary data-retry>Try again</button></div><small class="gs-foot-note">Tap Try again when you arrive.</small>`;
    } else if (mode === "off") {
      foot.innerHTML = `<button type="button" class="btn-game" data-primary data-retry>Try again</button>
        <small class="gs-foot-note">Allow location for this site in your browser settings, then try again.</small>`;
    } else foot.innerHTML = `<button type="button" class="btn-game" disabled>Locating…</button>`;
    foot.querySelector("[data-retry]")?.addEventListener("click", () => void locate());
  };

  async function locate() {
    radar.dataset.state = "locating";
    me.hidden = true;
    setText("Finding you…", `Checking you're near ${g.venue.name}`);
    paintFoot("locating");
    const coords = await getCoords();
    if (!sheet.isConnected) return;
    if (!coords) {
      radar.dataset.state = "off";
      setText("Location is off", "Check-in confirms you were at the venue, so it needs your location once.");
      paintFoot("off");
      return;
    }
    const o = offsetM(coords, g.venue);
    const dist = Math.round(Math.hypot(o.x, o.y));
    // The outer ring is twice the geofence; anyone farther sits on its edge.
    const scale = radius ? Math.min(1, dist / (2 * radius)) / Math.max(1, dist) : 0;
    me.style.left = `${50 + 50 * o.x * scale}%`;
    me.style.top = `${50 - 50 * o.y * scale}%`;
    me.hidden = false;
    const near = radius ? dist <= radius : true;
    radar.dataset.state = near ? "near" : "far";
    if (near) setText("You're at the venue", `About ${dist} m from ${g.venue.name}`);
    else setText(dist >= 1000 ? `${(dist / 1000).toFixed(1)} km away` : `${dist} m away`,
      `Get within ${radius} m of ${g.venue.name} to check in.`);
    paintFoot(near ? "near" : "far", coords);
  }
  void locate();
}

// ── the card menu on phones ───────────────────────────────────────────

/**
 * The card's "more" menu as an action sheet, titled with the game. Each item
 * clicks the card's own menu item, so whatever is wired to it (here or in
 * events.js) runs unchanged.
 */
export function openActionSheet(menu, title) {
  const items = [...menu.querySelectorAll(".gc-menu-item")];
  const { body, close } = openSheet({ id: "actions-sheet", title, className: "sheet-game sheet-small sheet-actions", bottom: true });
  const safe = items.filter((b) => !b.classList.contains("gc-menu-danger"));
  const danger = items.filter((b) => b.classList.contains("gc-menu-danger"));
  const group = (list) => list.length ? `<div class="gs-acts">${list.map((b) =>
    `<button type="button" class="gs-act${b.classList.contains("gc-menu-danger") ? " is-danger" : ""}" data-i="${items.indexOf(b)}"${b.disabled ? " disabled" : ""}>${b.innerHTML}</button>`).join("")}</div>` : "";
  body.innerHTML = group(safe) + group(danger);
  body.addEventListener("click", (e) => {
    const a = e.target.closest(".gs-act");
    if (!a || a.disabled) return;
    close();
    items[Number(a.dataset.i)].click();
  });
}
