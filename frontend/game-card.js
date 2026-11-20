/**
 * One game as a card or as a one-line row, and what their buttons do. Used
 * by every list on the Games page (games.js).
 *
 * The card leads with when and where; sport, level and length sit under
 * them. It shows at most three controls: Manage for the host and co-hosts,
 * one main button, and a "more" menu. The main button is the next thing the
 * viewer can do, in this order: Check in, record the result, Register or
 * Join, then Sides / Result once check-in has opened.
 * Everything else lives in the menu: Sides / Result when it is not the main
 * button, Share link, the event prize (added by events.js) and Leave.
 *
 * The row is the same game in one line: time, sport, venue, host and spots
 * left, with the main button and the menu. For a host the main button is
 * Manage unless something is due now (check in, a result).
 *
 * Tapping a card or a row (anywhere but its controls) opens the whole game
 * in a sheet (game-sheet.js), with the same controls in its footer. Joining
 * shows "You're in"; leaving and checking in each get a sheet that says
 * what will happen. On phones the "more" menu opens as an action sheet.
 *
 * Event terms (events.js) are looked up after the cards are painted;
 * decorateCards adds the price line and the Register button. Rows carry the
 * same markup the decorator looks for, so they are decorated the same way.
 */

import { $$, toast, ICON } from "./shared.js";
import { openGameSheet, openJoinedSheet, openLeaveSheet, openCheckInSheet, openActionSheet } from "./game-sheet.js";
import { apiSend, clockText, esc, titleCase, whenLabel, sportIcon, personLink } from "./api.js";
import { openVenueSheet } from "./venue.js";
import { openResultSheet } from "./results.js";
import { shareGame } from "./host.js";
import { decorateEvents, leaveEvent, openRegisterSheet } from "./events.js";
import { ROLE_LABEL, openManageSheet } from "./manage.js";

const joinGame = (id) => apiSend(`/api/games/${id}/join`, "POST");
const leaveGame = (id) => apiSend(`/api/games/${id}/leave`, "POST");
const checkInToGame = (id, coords) => apiSend(`/api/games/${id}/checkin`, "POST", coords);

/** What a waiting result asks for (resultNeed from /api/my/results/open). */
const NEEDS = { record: "Record result" };

/** Every game painted so far, by id: Share and Leave need more than the id. */
const PAINTED = new Map();

/** One "more" menu item: an icon, the label, and (in the phone action sheet) what it does. */
const item = (attrs, icon, label, sub = "", danger = false) =>
  `<button type="button" class="gc-menu-item${danger ? " gc-menu-danger" : ""}" ${attrs}>${icon}<span>${esc(label)}${
    sub ? `<small>${esc(sub)}</small>` : ""}</span></button>`;

/** "Today", "Tomorrow", "Sat" within the week, then "Nov 21". */
function shortDay(iso) {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return "Today";
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  if (d.toDateString() === tomorrow.toDateString()) return "Tomorrow";
  if (Math.abs(d - now) / 86400000 < 6) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/**
 * The badges and controls for one game. A `row` has room for one button,
 * so a host's Manage takes the main spot unless something is due now, and
 * what it displaces moves into the menu.
 */
function controls(g, { row = false } = {}) {
  const id = esc(g.id);
  const event = g.kind === "event";
  // A league game is played by its two rosters: nobody joins it from a card.
  const league = g.kind === "league";
  const upcoming = new Date(g.startsAt).getTime() > Date.now();
  const full = g.spotsLeft === 0;
  const seated = g.viewerStatus === "joined" || g.viewerStatus === "waitlist";
  const inGame = Boolean(g.viewerRole) || g.viewerStatus === "joined";
  const closed = g.checkInWindow === "closed";
  const cancelled = g.status === "cancelled";

  // The result sheet: sides while check-in is open, the result after.
  const hasResult = inGame && g.checkInWindow !== "early" && !cancelled;
  const need = NEEDS[g.resultNeed] ?? "";
  const resultLabel = g.checkInWindow === "open" ? "Sides" : "Result";

  let main = "";
  let kind = "";
  let label = "";
  if (g.viewerStatus === "joined" && g.checkInWindow === "open" && !g.viewerCheckedIn) {
    label = "Check in";
    main = `<button class="btn-game btn-game-checkin" data-checkin="${id}">${label}</button>`;
    kind = "checkin";
  } else if (need && hasResult) {
    main = `<button class="btn-game" data-result="${id}">${need}</button>`;
    kind = "need";
  } else if (event && upcoming && !cancelled && g.viewerStatus !== "joined") {
    label = "Register";
    main = `<button class="btn-game" data-enter="${id}">${label}</button>`;
    kind = "register";
  } else if (!event && !league && upcoming && !cancelled && !seated && !closed) {
    // A host who is not playing can still take a slot like anyone else.
    label = full ? "Join waitlist" : g.viewerRole ? "Join as player" : "Join";
    main = `<button class="btn-game" data-join="${id}">${label}</button>`;
    kind = "join";
  } else if (hasResult) {
    main = `<button class="btn-game btn-game-ghost" data-result="${id}">${resultLabel}</button>`;
    kind = "result";
  }

  const manageMain = row && g.viewerRole && (kind === "" || kind === "join" || kind === "result");
  const manageBtn = g.viewerRole
    ? `<button class="btn-game btn-game-ghost" data-manage="${id}">Manage</button>` : "";
  // A host's "Join as player" waits in the row's menu while Manage is the button.
  const menuJoin = manageMain && kind === "join"
    ? item(`data-join="${id}"`, ICON.plus, full ? "Join waitlist" : "Join as player") : "";
  if (manageMain) { main = manageBtn; kind = "manage"; }
  const resultIsMain = kind === "need" || kind === "result";

  // Nobody leaves once check-in has closed, or after checking in; the server
  // refuses the first. An event is left only before its check-in opens.
  const canLeave = event
    ? g.viewerStatus === "joined" && g.checkInWindow === "early"
    : seated && !closed && !g.viewerCheckedIn;

  const waiting = g.viewerStatus === "waitlist";
  const menu = [
    row && g.viewerRole && !manageMain ? item(`data-manage="${id}"`, ICON.people, "Manage") : "",
    menuJoin,
    hasResult && !resultIsMain ? item(`data-result="${id}"`, ICON.trophy, resultLabel) : "",
    !cancelled ? item(`data-share="${id}"`, ICON.share, "Share link", "Send the game to a friend") : "",
    canLeave
      ? item(`${event ? "data-event-leave" : "data-leave"}="${id}"`, ICON.logout,
        waiting ? "Leave waitlist" : event ? "Leave event" : "Leave game",
        waiting ? "You lose your place in line" : g.waitlistCount ? "Your spot goes to the first on the waitlist" : "Your spot opens for anyone",
        true)
      : "",
  ].join("");
  const more = menu
    ? `<details class="gc-more">
         <summary class="icon-btn" aria-label="More actions" title="More">${ICON.more}</summary>
         <div class="gc-menu">${menu}</div>
       </details>`
    : "";

  const badges = [
    event ? `<span class="game-badge game-badge-role">Event</span>` : "",
    cancelled ? `<span class="game-badge">Cancelled</span>` : "",
    g.viewerRole ? `<span class="game-badge game-badge-role">${ROLE_LABEL[g.viewerRole]}</span>` : "",
    g.viewerStatus === "waitlist" ? `<span class="game-badge game-badge-wait">On waitlist</span>` : "",
    // The need is the main button's label; the badge only stands in for it.
    need && !hasResult ? `<span class="game-badge game-badge-need">${need}</span>` : "",
  ].join("");

  const action = row ? `${main}${more}` : `${manageBtn}${main}${more}`;
  return { badges, action, upcoming, full, main, kind, label, canLeave };
}

/** Calls to action a compact link may show: what the viewer can step into now. */
const GLANCE_CTA = new Set(["join", "register", "checkin"]);

/**
 * One game in a few words, for a compact link to it (a post, a rail row),
 * from the same rules as the card: where it stands ("3 spots left", "full",
 * "happening now", "ended", "cancelled") and `cta`, the label of the one
 * thing the viewer can do now when that is joining, registering or
 * checking in ("" otherwise: never a Join on a game that has started).
 */
export function gameGlance(g) {
  const c = controls(g);
  const ends = new Date(g.startsAt).getTime() + (g.durationMinutes ?? 0) * 60_000;
  const state = g.status === "cancelled" ? "cancelled"
    : c.upcoming
      ? c.full ? (g.waitlistCount ? `full · ${g.waitlistCount} waiting` : "full")
        : `${g.spotsLeft} spot${g.spotsLeft === 1 ? "" : "s"} left`
      : Date.now() < ends ? "happening now" : "ended";
  return { state, cta: GLANCE_CTA.has(c.kind) ? c.label : "" };
}

/** Spots, waitlist and check-in, as one line of small facts. */
function metaLine(g, { upcoming, full }) {
  const spots = upcoming
    ? `${g.joinedCount}/${g.capacity} in${full ? " · full" : ` · ${g.spotsLeft} left`}`
    : `${g.joinedCount}/${g.capacity} in`;
  return `
    <div class="game-meta">
      <span class="game-spots ${full || !upcoming ? "game-spots-full" : ""}">${spots}</span>
      ${g.waitlistCount ? `<span class="game-wait">${g.waitlistCount} waiting</span>` : ""}
      ${g.checkInWindow === "open"
        ? `<span class="game-checkin-live">&#9679; ${g.checkedInCount}/${g.joinedCount} checked in</span>`
        : ""}
      ${g.viewerCheckedIn ? `<span class="game-checked">&#10003; You're checked in</span>` : ""}
    </div>`;
}

function peopleLine(g) {
  return `Host ${personLink(g.host, { fallback: "—" })}`;
}

const levelOf = (g) => (g.skillLevel === "any" ? "All levels" : titleCase(g.skillLevel));

/** The full card for one game. */
export function gameCard(g) {
  PAINTED.set(g.id, g);
  const id = esc(g.id);
  const c = controls(g);
  const dist = g.distanceKm !== undefined ? ` · ${g.distanceKm} km away` : "";

  return `
    <article class="game-card" data-game-card="${id}" data-kind="${esc(g.kind ?? "pickup")}"${g.isHost ? " data-host" : ""}>
      <div class="game-icon" title="${esc(titleCase(g.sport))}">${sportIcon(g.sport)}</div>
      <div class="game-body" data-open="${id}">
        <div class="game-line1">
          <h4 class="gc-when">${esc(whenLabel(g.startsAt))}</h4>
          ${c.badges}
        </div>
        <p class="game-where"><button class="game-venue" data-venue="${esc(g.venue.id)}"
          title="See the regulars here">${esc(g.venue.name)}</button>${esc(dist)}</p>
        <p class="gc-what">${esc(titleCase(g.sport))} · ${esc(levelOf(g))} · ${g.durationMinutes} min</p>
        ${metaLine(g, c)}
        <p class="gc-people">${peopleLine(g)}</p>
        ${g.notes ? `<p class="game-notes">${esc(g.notes)}</p>` : ""}
      </div>
      <div class="game-action">${c.action}</div>
    </article>`;
}

/**
 * One game as a single line. `showDay` puts the day under the time, for a
 * list that is not already under a day heading.
 */
export function gameRow(g, { showDay = false } = {}) {
  PAINTED.set(g.id, g);
  const id = esc(g.id);
  const c = controls(g, { row: true });
  const dist = g.distanceKm !== undefined ? ` · ${g.distanceKm} km` : "";
  const spots = !c.upcoming ? `${g.joinedCount}/${g.capacity} in`
    : c.full ? (g.waitlistCount ? `${g.waitlistCount} waiting` : "Full") : `${g.spotsLeft} left`;
  const filled = Math.min(100, Math.round((100 * g.joinedCount) / Math.max(1, g.capacity)));

  return `
    <article class="game-card game-row" data-game-card="${id}" data-kind="${esc(g.kind ?? "pickup")}"${g.isHost ? " data-host" : ""}>
      <button type="button" class="gr-toggle" data-open="${id}" aria-label="Open the game at ${esc(g.venue.name)}, ${esc(whenLabel(g.startsAt))}">
        <span class="gr-time">${esc(clockText(g.startsAt))}${showDay ? `<small>${esc(shortDay(g.startsAt))}</small>` : ""}</span>
        <span class="gr-icon" title="${esc(titleCase(g.sport))}">${sportIcon(g.sport)}</span>
        <span class="gr-what">
          <span class="gr-venue"><span class="gr-venue-name">${esc(g.venue.name)}</span>${c.badges}</span>
          <span class="gr-sub">${esc(titleCase(g.sport))} · ${esc(levelOf(g))}${esc(dist)}</span>
        </span>
        <span class="gr-host">${esc(g.host?.name || "—")}<small>Host</small></span>
        <span class="gr-spots${c.full || !c.upcoming ? " is-full" : ""}">${esc(spots)}<i><b style="width:${filled}%"></b></i></span>
      </button>
      <div class="game-action">${c.action}</div>
    </article>`;
}

/** Add the event lines (and their buttons) to the cards under `root`. */
export function decorateCards(root, { onChange } = {}) {
  if (!root) return;
  void decorateEvents(root, { onChange });
}

/** The controls a game's sheet shows: the fresh game merged with what its list painted (resultNeed, distanceKm). */
export function sheetControls(g) {
  const merged = { ...PAINTED.get(g.id), ...g };
  PAINTED.set(g.id, merged);
  return controls(merged);
}

/** The copy of a game the last list or sheet painted, if any. */
export const paintedGame = (id) => PAINTED.get(id);

/**
 * What a clicked game control does, wherever the game shows: the Games
 * page's cards and sheets (bindCards) and Home's game modal
 * (game-preview.js). `refresh` reloads what that surface shows after a
 * change, `hostAgain(game)` is passed on to the Manage sheet, and
 * `open(id)` opens a game a card was tapped on.
 */
export function gameActions({ refresh, hostAgain, open = null }) {
  const act = async (btn, fn, ok) => {
    btn.disabled = true;
    try { ok(await fn()); await refresh(); }
    catch (err) { toast(err.message); btn.disabled = false; }
  };

  return function handle(t) {
    const d = t.dataset;
    if (d.open) open?.(d.open);
    else if (d.venue) void openVenueSheet(d.venue);
    else if (d.manage) void openManageSheet(d.manage, { onChange: refresh, onHostAgain: hostAgain });
    else if (d.result) void openResultSheet(d.result, { onChange: refresh });
    else if (d.enter) void openRegisterSheet(d.enter, { onChange: refresh });
    else if (d.share) { const g = PAINTED.get(d.share); if (g) void shareGame(g); }
    else if (d.join) {
      void act(t, () => joinGame(d.join), (r) => openJoinedSheet(r.game, { onShare: shareGame }));
    } else if (d.leave || d.eventLeave) {
      const id = d.leave || d.eventLeave;
      const g = PAINTED.get(id);
      if (!g) return;
      const event = Boolean(d.eventLeave);
      openLeaveSheet(g, {
        event,
        onLeave: async () => {
          await (event ? leaveEvent(id) : leaveGame(id));
          toast(g.viewerStatus === "waitlist" ? "You left the waitlist." : event ? "You left the event." : "You left the game.");
          await refresh();
        },
      });
    } else if (d.checkin) {
      const g = PAINTED.get(d.checkin);
      if (!g) return;
      void openCheckInSheet(g, {
        checkIn: async (coords) => { await checkInToGame(g.id, coords); toast("Checked in."); await refresh(); },
      });
    }
  };
}

/**
 * Wire every card under `root`, now and later, with one listener.
 * `refresh` reloads the lists after a change; `hostAgain(game)` is passed on
 * to the Manage sheet.
 */
export function bindCards(root, { refresh, hostAgain }) {
  const PHONE = "(max-width: 760px)";
  const handle = gameActions({
    refresh,
    hostAgain,
    // ↑ / ↓ in the sheet step through the cards in the order they are shown.
    open: (id) => {
      const ids = [...root.querySelectorAll("[data-game-card]")].map((c) => c.dataset.gameCard)
        .filter((v, i, all) => all.indexOf(v) === i);
      openGameSheet(id, { ids, painted: paintedGame, controlsOf: sheetControls, handle });
    },
  });

  root.addEventListener("click", (e) => {
    // One menu open at a time; a click anywhere else closes it.
    for (const m of $$(".gc-more[open]", root)) if (!m.contains(e.target)) m.open = false;
    if (e.target.closest(".gc-menu-item")) e.target.closest(".gc-more").open = false;

    // On phones the "more" menu is an action sheet instead of a dropdown.
    const summary = e.target.closest(".gc-more > summary");
    if (summary && matchMedia(PHONE).matches) {
      e.preventDefault();
      const card = summary.closest("[data-game-card]");
      const g = PAINTED.get(card?.dataset.gameCard);
      openActionSheet(summary.parentElement.querySelector(".gc-menu"),
        g ? `${whenLabel(g.startsAt)} · ${g.venue.name}` : "Game");
      return;
    }

    const t = e.target.closest(
      "[data-venue], [data-join], [data-leave], [data-event-leave], [data-enter], [data-manage], [data-result], [data-share], [data-checkin]");
    if (t) { if (!t.disabled) handle(t); return; }
    // Anywhere else on a card or row opens the game, unless it is a link or another control.
    const open = e.target.closest("[data-open]");
    if (open && !e.target.closest("a, button:not([data-open]), summary, details, input, select")) handle(open);
  });
}
