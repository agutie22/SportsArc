/**
 * The Manage sheet: the host tools for one game, for the host and co-hosts.
 *
 * Top to bottom, in the order a host reaches for them: Share link, Host
 * again and Split a cost; who holds which role; the players, each with
 * remove / co-host; then "Edit details", folded until opened;
 * and Cancel. What shows comes from the game's `can` flags, so the server's
 * rules decide and none is restated here.
 *
 * Moving a game searches the venues already on the map (GET /api/venues,
 * nearest the current one first) so it keeps sharing a venue and its
 * regulars ladder. A place that is not listed takes a name and coordinates
 * pasted from a map app, since check-in is geofenced to that point.
 */

import { confirmSheet, getUser, toast, openSheet, showsUp } from "./shared.js";
import { apiGet, apiSend, esc, titleCase, whenLabel, sportIcon, personLink } from "./api.js";
import { openSplitSheet } from "./money.js";
import { parseCoords, shareGame } from "./host.js";
import { cancelPaidEvent } from "./events.js";

/** Role names as the app shows them (the API sends host, cohost). */
export const ROLE_LABEL = { host: "Host", cohost: "Co-host" };

export const fetchGame = (id) => apiGet(`/api/games/${id}`).then((b) => b.game);
const fetchReliability = (id) => apiGet(`/api/games/${id}/reliability`).then((b) => b.players);
const cancelGame = (id) => apiSend(`/api/games/${id}/cancel`, "POST").then((b) => b.game);
const hostAct = (id, path, body, method = "POST") =>
  apiSend(`/api/games/${id}${path}`, method, body).then((b) => b.game);

/** A Date as the value of a datetime-local input, in local time. */
const localInput = (iso) => {
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

/**
 * Open the sheet for one game. `onChange` runs after anything is saved;
 * `onHostAgain(game)` opens the Host a game sheet with this game copied.
 */
export async function openManageSheet(gameId, { onChange, onHostAgain } = {}) {
  const { body, sheet, close } = openSheet({ id: "host-sheet", title: "Manage game", className: "sheet-result sheet-host" });
  body.innerHTML = `<div class="skel skel-line" style="width:50%;height:22px"></div>
    <div class="skel skel-line" style="width:80%"></div>`;
  const s = {
    gameId, game: null, reliability: {}, busy: false, onChange, onHostAgain, close,
    editOpen: false,
    where: "current",     // "current" | "search" | "spot"
    venue: null,          // an existing venue picked to move to
    spot: { name: "", paste: "" },
    query: "",
    results: [],
  };
  try {
    // How often each player shows up is a nicety: the sheet opens without it.
    [s.game, s.reliability] = await Promise.all([fetchGame(gameId), fetchReliability(gameId).catch(() => ({}))]);
  } catch (err) {
    body.innerHTML = `<p class="empty empty-sm">${esc(err.message)}</p>`;
    return;
  }
  if (!sheet.isConnected) return;
  paint(body, s);
  bind(body, s);
}

/**
 * "Shows up 19/20" beside a player, from games whose check-in has closed.
 * Unlike the profile, a new player says "New": the host still wants to know
 * someone is untested.
 */
function showsUpLine(r) {
  if (!r) return "";
  const s = showsUp(r);
  return `<span class="hm-rel${s?.low ? " is-low" : ""}">${s ? esc(s.text) : "New"}</span>`;
}

function roleChips(roles) {
  return (roles ?? []).map((r) => `<span class="hm-chip hm-chip-${r}">${ROLE_LABEL[r]}</span>`).join("");
}

const venueSub = (v) => [titleCase(v.kind), v.address ?? ""].filter(Boolean).join(" · ");

/** The Where field of the edit form: the place, a venue search, or a new spot. */
function whereHtml(s) {
  if (s.where === "search") {
    const rows = s.results.slice(0, 6).map((v, i) => `
      <button type="button" class="hs-result" data-pick="${i}">
        <span>${esc(v.name)}</span><small>${esc(venueSub(v))}</small>
      </button>`).join("");
    return `
      <input class="hs-input" data-venue-q type="search" autocomplete="off"
        placeholder="Search parks, courts and gyms" value="${esc(s.query)}">
      <div class="hs-results">${rows}
        <button type="button" class="hs-result hs-result-add" data-new-spot>Somewhere not listed</button>
      </div>
      <button type="button" class="hs-link" data-where-keep>Keep ${esc(s.game.venue.name)}</button>`;
  }
  if (s.where === "spot") {
    return `
      <div class="hs-spot">
        <input class="hs-input" data-spot-name maxlength="160" placeholder="Name of the place" value="${esc(s.spot.name)}">
        <input class="hs-input" data-spot-paste inputmode="decimal" placeholder="34.0522, -118.2437" value="${esc(s.spot.paste)}">
        <small class="hs-hint">In your map app, long-press the court and copy its coordinates. Check-in only works near this point.</small>
      </div>
      <button type="button" class="hs-link" data-where-keep>Keep ${esc(s.game.venue.name)}</button>`;
  }
  const v = s.venue ?? s.game.venue;
  return `
    <div class="hs-venue${s.venue ? "" : " hm-venue-now"}">
      <div><strong>${esc(v.name)}</strong><small>${esc(venueSub(v))}</small></div>
      <button type="button" class="hs-link" data-venue-change>Change</button>
    </div>`;
}

function paint(body, s) {
  const g = s.game;
  const me = getUser()?.id;
  const can = g.can ?? {};
  const cohosts = g.cohosts.length
    ? g.cohosts.map((c) => personLink(c, { fallback: "Player" })).join(", ")
    : "None yet";
  const cancelled = g.status === "cancelled";

  const edit = can.edit
    ? `<details class="hm-details"${s.editOpen ? " open" : ""}>
        <summary><span>Edit details <span class="hm-dim">time, place, size, notes</span></span></summary>
        <form class="host-form hm-edit" novalidate>
          <div class="host-grid">
            <label class="host-wide">When<input type="datetime-local" name="startsAt" value="${localInput(g.startsAt)}" required></label>
            <label>Minutes<input type="number" name="durationMinutes" value="${g.durationMinutes}" min="10" max="600"></label>
            <label>Players<input type="number" name="capacity" value="${g.capacity}" min="2" max="100"></label>
            <div class="host-wide hm-where"><span class="hm-label">Where</span><div data-where>${whereHtml(s)}</div></div>
            <label class="host-wide">Notes<input name="notes" value="${esc(g.notes ?? "")}" maxlength="500"></label>
          </div>
          <p class="res-hint">Joined players are told about any change. Details are fixed once check-in opens.</p>
          <div class="host-actions"><button type="submit" class="btn-game">Save changes</button></div>
        </form>
      </details>`
    : cancelled ? "" : `<p class="res-hint">Check-in has opened, so the time, place and size are fixed.</p>`;

  const rows = g.players.map((p) => {
    const isHost = p.id === g.host.id;
    const isCo = p.roles?.includes("cohost");
    const actions = [];
    if (can.cohosts && !isHost) {
      actions.push(`<button type="button" class="hm-btn" data-cohost="${esc(p.id)}" data-on="${isCo ? "" : "1"}">${isCo ? "Remove co-host" : "Make co-host"}</button>`);
    }
    if (can.remove && !isHost && p.id !== me && (g.viewerRole === "host" || !isCo)) {
      actions.push(`<button type="button" class="hm-btn hm-btn-bad" data-remove="${esc(p.id)}">Remove</button>`);
    }
    return `
      <li class="hm-player">
        <div class="hm-player-line">
          <a class="res-player-name" href="#/u/${esc(p.id)}">${esc(p.name ?? "Player")}</a>
          ${p.id === me ? `<span class="res-you">You</span>` : ""}
          ${roleChips(p.roles)}
          ${showsUpLine(s.reliability?.[p.id])}
        </div>
        ${actions.length ? `<div class="hm-actions">${actions.join("")}</div>` : ""}
      </li>`;
  }).join("");

  body.innerHTML = `
    <div class="res-head">
      <span class="res-icon">${sportIcon(g.sport)}</span>
      <div class="res-head-text">
        <strong>${esc(whenLabel(g.startsAt))}</strong>
        <span>${esc(g.venue.name)}</span>
      </div>
      <span class="res-status ${cancelled ? "res-tone-bad" : "res-tone-live"}">${cancelled ? "Cancelled" : esc(ROLE_LABEL[g.viewerRole] ?? "Player")}</span>
    </div>
    <div class="hm-quick">
      ${!cancelled ? `<button type="button" class="btn-game btn-game-ghost" data-share-game>Share link</button>` : ""}
      <button type="button" class="btn-game btn-game-ghost" data-host-again>Host again</button>
      ${!cancelled && g.joinedCount > 1
        ? `<button type="button" class="btn-game btn-game-ghost" data-split-cost>Split a cost</button>`
        : ""}
    </div>
    <dl class="hm-roles">
      <div><dt>Host</dt><dd>${personLink(g.host, { fallback: "—" })}${g.hostPlays ? "" : ` <span class="hm-dim">· not playing</span>`}</dd></div>
      <div><dt>Co-hosts</dt><dd>${cohosts}</dd></div>
    </dl>
    <h4 class="res-title">Players <span class="hm-dim">${g.joinedCount}/${g.capacity}</span></h4>
    ${g.players.length ? `<ul class="res-list hm-list">${rows}</ul>` : `<p class="res-hint">Nobody has joined yet.</p>`}
    ${can.cohosts ? `<p class="res-hint">Co-hosts can edit, remove players, cancel and run the result. Only the host names co-hosts.</p>` : ""}
    <p class="res-hint">You set the sides, start the game and record the result in the result sheet.</p>
    ${edit}
    ${can.cancel
      ? `<div class="hm-danger"><button type="button" class="btn-game btn-game-ghost hm-cancel" data-cancel-game>Cancel game</button></div>`
      : ""}`;
}

function bind(body, s) {
  const run = async (btn, fn, okMsg) => {
    if (s.busy) return;
    s.busy = true;
    if (btn) btn.disabled = true;
    try {
      s.game = await fn();
      toast(okMsg);
      s.onChange?.();
      if (body.isConnected) paint(body, s);
    } catch (err) {
      toast(err.message);
      if (btn) btn.disabled = false;
    } finally {
      s.busy = false;
    }
  };
  const nameOf = (id) => s.game.players.find((p) => p.id === id)?.name ?? "this player";

  // ── where ──
  const paintWhere = () => {
    const box = body.querySelector("[data-where]");
    if (box) box.innerHTML = whereHtml(s);
  };
  let searchSeq = 0;
  let searchTimer = 0;
  async function search() {
    const seq = ++searchSeq;
    const at = s.game.venue;
    try {
      const r = await apiGet("/api/venues", { q: s.query.trim() || undefined, lat: at.lat, lng: at.lng, radiusKm: 50 });
      if (seq !== searchSeq || !body.isConnected) return;
      s.results = (r.venues ?? []).filter((v) => v.id !== at.id);
    } catch {
      s.results = [];
    }
    if (s.where !== "search") return;
    // Repaint the rows only, so the search box keeps its focus and caret.
    const typed = body.querySelector("[data-venue-q]");
    if (!typed) { paintWhere(); return; }
    const tmp = document.createElement("div");
    tmp.innerHTML = whereHtml(s);
    body.querySelector(".hs-results")?.replaceWith(tmp.querySelector(".hs-results"));
  }

  body.addEventListener("toggle", (e) => {
    if (e.target.matches?.(".hm-details")) s.editOpen = e.target.open;
  }, true);

  body.addEventListener("input", (e) => {
    const t = e.target;
    if (t.matches("[data-venue-q]")) {
      s.query = t.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(search, 220);
    } else if (t.matches("[data-spot-name]")) s.spot.name = t.value;
    else if (t.matches("[data-spot-paste]")) s.spot.paste = t.value;
  });

  // Enter in the venue search picks nothing and must not save the form.
  body.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.matches("[data-venue-q]")) e.preventDefault();
  });

  body.addEventListener("click", async (e) => {
    const t = e.target.closest("button");
    if (!t || t.disabled) return;
    const d = t.dataset;
    const id = s.gameId;

    if (d.venueChange !== undefined) {
      s.where = "search"; s.venue = null; paintWhere();
      body.querySelector("[data-venue-q]")?.focus();
      void search();
    } else if (d.pick !== undefined) {
      s.venue = s.results[Number(d.pick)] ?? null; s.where = "current"; paintWhere();
    } else if (d.newSpot !== undefined) {
      s.where = "spot"; s.spot = { name: s.query.trim().slice(0, 160), paste: "" }; paintWhere();
      body.querySelector(s.spot.name ? "[data-spot-paste]" : "[data-spot-name]")?.focus();
    } else if (d.whereKeep !== undefined) {
      s.where = "current"; s.venue = null; paintWhere();
    } else if (d.splitCost !== undefined) {
      openSplitSheet(s.game);
    } else if (d.shareGame !== undefined) {
      void shareGame(s.game);
    } else if (d.hostAgain !== undefined) {
      s.close();
      s.onHostAgain?.(s.game);
    } else if (d.cohost) {
      const on = d.on === "1";
      void run(t, () => hostAct(id, "/cohosts", { userId: d.cohost, cohost: on }),
        on ? "Co-host named." : "Co-host removed.");
    } else if (d.remove) {
      const who = nameOf(d.remove);
      if (!(await confirmSheet({ title: `Remove ${who}?`, text: "They will be told, and cannot rejoin this game.", yes: "Remove" }))) return;
      void run(t, () => hostAct(id, "/remove", { userId: d.remove }), `${who} was removed.`);
    } else if (d.cancelGame !== undefined) {
      if (s.game.kind === "event") {
        if (!(await confirmSheet({ title: "Cancel this event?", text: "Everyone who paid gets their money back.", yes: "Cancel event" }))) return;
        void run(t, () => cancelPaidEvent(id).then(() => fetchGame(id)), "Event cancelled.");
        return;
      }
      if (!(await confirmSheet({ title: "Cancel this game?", text: "It's cancelled for everyone, and each player is told.", yes: "Cancel game" }))) return;
      void run(t, () => cancelGame(id), "Game cancelled.");
    }
  });

  body.addEventListener("submit", (e) => {
    const form = e.target.closest(".hm-edit");
    if (!form) return;
    e.preventDefault();
    const g = s.game;
    const f = new FormData(form);
    const patch = {};
    const when = new Date(String(f.get("startsAt")));
    if (!Number.isNaN(when.getTime()) && when.getTime() !== new Date(g.startsAt).getTime()) {
      patch.startsAt = when.toISOString();
    }
    const minutes = Number(f.get("durationMinutes"));
    if (minutes !== g.durationMinutes) patch.durationMinutes = minutes;
    const cap = Number(f.get("capacity"));
    if (cap !== g.capacity) patch.capacity = cap;
    const notes = String(f.get("notes") ?? "").trim();
    if (notes !== (g.notes ?? "")) patch.notes = notes;

    if (s.where === "spot") {
      const name = s.spot.name.trim();
      const at = parseCoords(s.spot.paste);
      if (!name) { toast("Give the new place a name."); return; }
      if (!at) { toast("Paste the place's coordinates, like 34.0522, -118.2437."); return; }
      patch.venue = { name, kind: g.venue.kind, ...at };
    } else if (s.where === "search") {
      toast("Pick a place from the list, or keep the current one."); return;
    } else if (s.venue) {
      patch.venueId = s.venue.id;
    }

    if (!Object.keys(patch).length) { toast("Nothing changed."); return; }
    void run(form.querySelector("[type=submit]"), async () => {
      const game = await hostAct(s.gameId, "", patch, "PATCH");
      Object.assign(s, { where: "current", venue: null, spot: { name: "", paste: "" }, query: "", results: [], editOpen: false });
      return game;
    }, "Saved. Joined players were told.");
  });
}
