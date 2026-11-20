/**
 * The game result sheet: sides, start, record. The host runs it.
 *
 * One sheet drives the whole life of a result. Before the lock, the host
 * (or a co-host) puts each checked-in player on Side A or Side B and taps
 * Start once both sides have someone. After the lock the sides are
 * read-only and the host records what happened: a win, a draw or "not
 * played". That is the result at once; for a short while the host can
 * record again to fix a mistake: the form stays folded behind "Fix a
 * mistake" until asked for. Players see the same sheet, read-only. A caller
 * that has the recap card passes `onShare`, and the sheet offers to share it.
 * The server decides everything; this file only shows what
 * GET /api/games/:id/result says the viewer may do, and surfaces the
 * server's own error messages.
 *
 * Once check-in has closed, the host also confirms who was there ("Who
 * was here", games/roster.ts): every player who held a spot, starting from
 * what the check-ins say. It is a second source beside the phones, fixable
 * for an hour, then written to the public record.
 *
 * The outcome vocabulary comes from GET /api/meta, and the rule numbers
 * (how long a correction stays open, when sides lock on their own) from the
 * result itself; none are restated here. Sides are 0 and 1 in the API; they
 * are labelled neutrally as Side A and Side B.
 */

import { openSheet, getUser, toast, ICON } from "./shared.js";
import { apiGet, apiSend, clockText, firstName, loadMeta, esc, titleCase, whenLabel, sportIcon, avatar, personLink } from "./api.js";
import { eventResultHtml, openPrizeSheet, submitEventResult, togglePlace } from "./events.js";

const sideName = (i) => `Side ${i === 1 ? "B" : "A"}`;

/** "Side A won", "Draw", "Not played": the result's headline in words. */
export function outcomeLabel(outcome, winningSide) {
  if (outcome === "win") return `${sideName(winningSide)} won`;
  return titleCase(String(outcome ?? "").replace(/_/g, " "));
}

/** "21–18", or "" when no score was given. */
export const scoreLabel = (score) => (Array.isArray(score) ? `${score[0]}–${score[1]}` : "");

const fetchResult = (id) => apiGet(`/api/games/${id}/result`).then((b) => b.result);
const act = (id, path, body) => apiSend(`/api/games/${id}/${path}`, "POST", body).then((b) => b.result);

/** "7:15 PM" today, "Sat 7:15 PM" on another day. */
function clock(iso) {
  const d = new Date(iso);
  const today = d.toDateString() === new Date().toDateString();
  return d.toLocaleString([], { ...(today ? {} : { weekday: "short" }), hour: "numeric", minute: "2-digit" });
}

const POLL_MS = 20_000;

// ── sheet ─────────────────────────────────────────────────────────────

/**
 * Open the result sheet for one game. `onChange` runs after any action
 * succeeds, so the page underneath can refresh its own card. `onShare`,
 * when given, shares that card.
 */
export async function openResultSheet(gameId, { onChange, onShare } = {}) {
  const { body, sheet } = openSheet({ id: "result-sheet", title: "Game result", className: "sheet-result" });
  body.innerHTML = `<div class="skel skel-line" style="width:50%;height:22px"></div>
    <div class="skel skel-line" style="width:80%"></div><div class="skel skel-line" style="width:65%"></div>`;

  const state = {
    gameId, game: null, result: null, event: null, places: [], meta: null, busy: false, draft: {},
    fixOpen: false, onChange, onShare,
    /** The host's unsaved answers for "Who was here", by user id. */
    roster: null,
  };
  try {
    const [game, result, meta] = await Promise.all([
      apiGet(`/api/games/${gameId}`).then((b) => b.game),
      fetchResult(gameId),
      loadMeta(),
    ]);
    const event = game.kind === "event"
      ? await apiGet(`/api/web3/events/games/${gameId}`).catch(() => null)
      : null;
    Object.assign(state, { game, result, meta, event });
  } catch (err) {
    body.innerHTML = `<p class="empty empty-sm">${esc(err.message)}</p>`;
    return;
  }
  if (!sheet.isConnected) return;
  sheet.querySelector(".sheet-title").textContent = `${titleCase(state.game.sport)} result`;
  paint(body, state);
  bind(body, state);

  // Other players act too: keep the sheet current while something is open.
  const timer = setInterval(async () => {
    if (!sheet.isConnected) { clearInterval(timer); return; }
    // A final result and "none" never change from here; the rest can.
    const live = ["picking", "locked"].includes(state.result.status) ||
      Boolean(state.result.correctUntil) || Boolean(state.result.roster?.canConfirm);
    // Unsaved roster answers would be lost to a repaint: wait until they are saved.
    if (!live || state.busy || state.roster || body.querySelector(".res-propose")?.contains(document.activeElement)) return;
    try {
      [state.result, state.game] = await Promise.all([
        fetchResult(gameId),
        apiGet(`/api/games/${gameId}`).then((b) => b.game),
      ]);
      if (state.game.kind === "event") {
        state.event = await apiGet(`/api/web3/events/games/${gameId}`).catch(() => state.event);
      }
      if (sheet.isConnected) paint(body, state);
    } catch { /* next tick */ }
  }, POLL_MS);
}

function paint(body, s) {
  const r = s.result;
  // A recorded result folds its form away until the host asks to fix it.
  const showForm = r.viewer.canRecord && (r.status !== "settled" || s.fixOpen);
  body.innerHTML = `
    ${head(s.game, r)}
    ${eventResultHtml(s.event, s.game, s.places)}
    ${r.outcome ? resultCard(r) : ""}
    ${showForm ? recordForm(r, s.meta, s.draft) : afterResult(r, s)}
    ${sidesBoard(r, s.game)}
    ${r.status === "picking" ? pickingControls(r, s.game) : lockLine(r)}
    ${notes(r, s.game)}
    ${rosterBox(r, s)}`;
}

/**
 * "Who was here": the host marks each player who held a spot as here or not
 * here, starting from the check-ins. Everyone else sees the host's answer
 * once it is in.
 */
function rosterBox(r, s) {
  const ro = r.roster;
  if (!ro || !ro.players.length) return "";
  const me = getUser()?.id;
  const answer = (p) => s.roster?.[p.id] ?? p.hostPresent ?? p.checkedIn;
  if (ro.canConfirm) {
    const pick = (p) => {
      const on = answer(p);
      return `<div class="res-seg res-seg-sm" role="group" aria-label="Was ${esc(p.name ?? "this player")} here?">
        ${[true, false].map((v) => `<button type="button" class="res-seg-btn${on === v ? " is-on" : ""}" data-roster-pick="${v}"
          data-user="${esc(p.id)}" aria-pressed="${on === v}">${v ? "Here" : "Not here"}</button>`).join("")}
      </div>`;
    };
    const fixing = Boolean(ro.confirmedAt);
    return `
      <h4 class="res-title">Who was here</h4>
      <ul class="res-list">${ro.players.map((p) => `
        <li class="res-player${p.id === me ? " is-you" : ""}">
          <span class="res-player-name">${esc(p.name ?? "Player")}<small class="res-sub">${p.checkedIn ? "checked in" : "no check-in"}</small></span>
          ${pick(p)}
        </li>`).join("")}</ul>
      <div class="res-actions">
        <button type="button" class="btn-game" data-roster-confirm>${fixing ? "Save the fix" : "Confirm who was here"}</button>
      </div>
      <p class="res-hint">${fixing
        ? `You can fix this until ${esc(clock(ro.correctUntil))}. Then it's final and goes on the public record.`
        : `It starts from the check-ins. Fix anyone who's wrong. You have until ${esc(clock(ro.confirmBy))}.`}</p>`;
  }
  if (!ro.confirmedAt) return "";
  const here = ro.players.filter((p) => p.hostPresent === true).length;
  const missing = ro.players.length - here;
  const by = ro.confirmedBy?.id === me ? "you" : "the host";
  return `<p class="res-locked">${ICON.check}<span>Confirmed by ${by}: ${here} here${missing ? `, ${missing} not here` : ""}.</span></p>`;
}

/** Under a recorded result: "Fix a mistake" for the host, Share when the caller has the card. */
function afterResult(r, s) {
  if (r.status !== "settled") return "";
  const fix = r.viewer.canRecord
    ? `<button type="button" class="btn-game btn-game-ghost" data-fix>Fix a mistake</button>` : "";
  const share = s.onShare
    ? `<button type="button" class="btn-game" data-share-recap>${ICON.share}Share the recap</button>` : "";
  if (!fix && !share) return "";
  return `
    <div class="res-actions res-after">${fix}${share}</div>
    ${fix && r.correctUntil
      ? `<p class="res-hint">After ${esc(clock(r.correctUntil))} the result is final and counts on everyone's record.</p>`
      : ""}`;
}

// ── pieces ────────────────────────────────────────────────────────────

const STATUS = {
  picking: ["Picking sides", "live"],
  none: ["No result", "dim"],
  locked: ["Result pending", "live"],
};

/** The pill: what the result is, not the system's state. Recorded while fixable, then final. */
function statusOf(r) {
  if (r.status === "settled") return r.correctUntil ? ["Recorded", "ok"] : ["Final", "ok"];
  return STATUS[r.status] ?? [titleCase(r.status), "dim"];
}

const hostFirst = (g) => firstName(g.host?.name, "the host");

function head(g, r) {
  const [label, tone] = statusOf(r);
  const host = g.host?.name ? ` · hosted by ${g.host.name}` : "";
  return `
    <div class="res-head">
      <span class="res-icon">${sportIcon(g.sport)}</span>
      <div class="res-head-text">
        <strong>${esc(whenLabel(g.startsAt))}</strong>
        <span>${esc(g.venue.name + host)}</span>
      </div>
      <span class="res-status res-tone-${tone}">${esc(label)}</span>
    </div>`;
}

function sidesBoard(r, g) {
  const me = getUser()?.id;
  // Role only tints the avatar; it is already public on the game itself.
  const roles = new Map((g.players ?? []).map((p) => [p.id, p.role]));
  const picking = r.status === "picking";
  const winner = r.status === "settled" && r.outcome === "win" ? r.winningSide : null;
  // The host moves players between sides from any row: A, none, B.
  const mover = (p, at) => (r.viewer.canSetSides
    ? `<div class="res-seg res-seg-sm" role="group" aria-label="Side for ${esc(p.name ?? "this player")}">
        ${[0, null, 1].map((to) => `<button type="button" class="res-seg-btn${to === at ? " is-on" : ""}${to === null ? "" : ` res-seg-${to}`}"
          data-pick="${to === null ? "" : to}" data-user="${esc(p.id)}" aria-pressed="${to === at}">${to === null ? "–" : sideName(to).slice(-1)}</button>`).join("")}
      </div>`
    : "");
  const row = (p, at) => `
      <li class="res-player${p.id === me ? " is-you" : ""}">
        ${avatar({ ...p, role: roles.get(p.id) ?? null }, "xs", { href: `#/u/${p.id}` })}
        <a class="res-player-name" href="#/u/${esc(p.id)}">${esc(p.name ?? "Player")}</a>
        ${p.id === me ? `<span class="res-you">You</span>` : ""}
        ${mover(p, at)}
      </li>`;
  const side = (i) => `
    <section class="res-side res-side-${i}${winner === i ? " is-winner" : ""}">
      <header class="res-side-head">
        <span class="res-side-dot"></span>
        <strong>${sideName(i)}</strong>
        <span class="res-side-count">${r.sides[i].length}</span>
        ${winner === i ? `<span class="res-side-win">${ICON.trophy}Won</span>` : ""}
      </header>
      ${r.sides[i].length
        ? `<ul class="res-list">${r.sides[i].map((p) => row(p, i)).join("")}</ul>`
        : `<p class="res-side-empty">${picking ? "Nobody yet" : "Nobody"}</p>`}
    </section>`;

  const bench = r.unassigned.length
    ? `<div class="res-bench">
         <h5 class="res-label">${picking ? "Checked in, no side yet" : "Sat out"}</h5>
         <ul class="res-list">${r.unassigned.map((p) => row(p, null)).join("")}</ul>
       </div>`
    : "";

  return `
    <h4 class="res-title">Sides</h4>
    <div class="res-sides">${side(0)}${side(1)}</div>
    ${bench}`;
}

function pickingControls(r, g) {
  const everyone = [...r.sides[0], ...r.sides[1], ...r.unassigned];
  const host = r.viewer.runsResult;

  let hint = "";
  if (!everyone.length) {
    hint = host
      ? "Nobody has checked in yet. Put players on a side once they check in at the venue."
      : "Nobody has checked in yet.";
  } else if (!host) {
    hint = "The host sets the sides and starts the game.";
  } else if (!r.viewer.canStart) {
    hint = g.checkInWindow === "early"
      ? "Start opens when check-in does."
      : "Start unlocks once both sides have a player.";
  }
  return `
    ${r.viewer.canStart
      ? `<div class="res-start">
           <button type="button" class="btn-game" data-start>${ICON.play}Start game</button>
           <p class="res-hint">Starting locks the sides. Players who check in after that are not on the result.</p>
         </div>`
      : ""}
    ${hint ? `<p class="res-hint">${esc(hint)}</p>` : ""}
    ${r.checkInClosesAt
      ? `<p class="res-hint res-autolock">Sides lock on their own at <strong>${esc(clock(r.checkInClosesAt))}</strong> if nobody taps start.</p>`
      : ""}`;
}

function lockLine(r) {
  if (!r.lockedAt) {
    return `<p class="res-hint">Nobody was checked in when check-in closed, so this game has no result.</p>`;
  }
  const at = clockText(r.lockedAt);
  const me = getUser()?.id;
  const who = r.lockedBy?.id === me ? "you" : firstName(r.lockedBy?.name, "the host");
  const how = r.lockedAutomatically ? "when check-in closed" : `when ${esc(who)} started the game`;
  return `<p class="res-locked">${ICON.check}<span>Sides locked at ${esc(at)}, ${how}.</span></p>`;
}

/** Below the sides while it waits on the host: who records it, and that seated players hear when it's in. */
function notes(r, g) {
  if (r.status !== "locked" || !r.lockedAt || r.viewer.canRecord) return "";
  const me = getUser()?.id;
  const seated = [...r.sides[0], ...r.sides[1], ...r.unassigned].some((p) => p.id === me);
  const host = esc(hostFirst(g));
  return `<p class="res-note">${seated
    ? `${host} records the result. You'll get a notification when it's in.`
    : `Waiting for ${host} to record the result.`}</p>`;
}

/** "Recorded by Maya", or "by you": the host or co-host who recorded it. */
function recorderLine(r) {
  if (!r.recordedBy) return "";
  const you = r.recordedBy.id === getUser()?.id;
  const name = you ? "<strong>you</strong>" : personLink(r.recordedBy, { fallback: "the host" });
  const at = r.recordedAt ? ` at ${esc(clock(r.recordedAt))}` : "";
  return `<p class="res-by">Recorded by ${name}${at}</p>`;
}

function resultCard(r) {
  const score = scoreLabel(r.score);
  return `
    <div class="res-proposal res-proposal-settled">
      <div class="res-kicker">
        <span>${r.correctUntil ? "Result" : "Final result"}</span>
        ${r.correctUntil ? `<span>Fixable until ${esc(clock(r.correctUntil))}</span>` : ""}
      </div>
      <div class="res-outcome">
        <strong>${esc(outcomeLabel(r.outcome, r.winningSide))}</strong>
        ${score ? `<span class="res-score">${esc(score)}</span>` : ""}
      </div>
      ${recorderLine(r)}
    </div>`;
}

function recordForm(r, meta, draft) {
  const outcomes = meta?.resultOutcomes ?? [];
  const fixing = r.status === "settled";
  // A win expands into one choice per side; the rest are one choice each.
  const choices = outcomes.flatMap((o) =>
    o === "win" ? [0, 1].map((i) => ({ value: `win:${i}`, label: `${sideName(i)} won`, needsSide: true }))
      : [{ value: o, label: outcomeLabel(o), needsSide: o !== "not_played" }]);
  // Someone who sat out has one choice; start there.
  // With nobody on one side, "not played" is the only choice; start there.
  const pick = draft.choice ?? (r.viewer.canRecordWin ? "" : "not_played");
  const hideScore = pick === "not_played";

  return `
    <form class="res-propose" novalidate>
      <h4 class="res-title">${fixing ? "Fix a mistake" : "Record the result"}</h4>
      <div class="res-choices" role="radiogroup" aria-label="Outcome">
        ${choices.map((c) => {
          const off = c.needsSide && !r.viewer.canRecordWin;
          return `<label class="res-choice${off ? " is-off" : ""}">
            <input type="radio" name="choice" value="${esc(c.value)}" ${pick === c.value ? "checked" : ""} ${off ? "disabled" : ""}>
            <span>${esc(c.label)}</span>
          </label>`;
        }).join("")}
      </div>
      ${!r.viewer.canRecordWin
        ? `<p class="res-hint">A side has nobody on it, so the only result is that the game was not played.</p>`
        : ""}
      <fieldset class="res-scorebox"${hideScore ? " hidden" : ""}>
        <legend class="res-label">Score <span>(optional)</span></legend>
        <label><span>${sideName(0)}</span><input name="s0" type="number" inputmode="numeric" min="0" step="1" value="${esc(draft.s0 ?? "")}"></label>
        <span class="res-dash">–</span>
        <label><span>${sideName(1)}</span><input name="s1" type="number" inputmode="numeric" min="0" step="1" value="${esc(draft.s1 ?? "")}"></label>
      </fieldset>
      <p class="res-error" role="alert" hidden></p>
      <div class="res-actions">
        ${fixing ? `<button type="button" class="btn-game btn-game-ghost" data-fix-cancel>Cancel</button>` : ""}
        <button type="submit" class="btn-game">${fixing ? "Save the fix" : "Record result"}</button>
      </div>
      <p class="res-hint">${fixing
        ? "This replaces the recorded result."
        : `This is the result as soon as you record it. You can fix a mistake for ${esc(String(r.correctionWindowMinutes))} minutes.`}</p>
    </form>`;
}

/** Mirror the API's checks so most mistakes never leave the form. */
function readResult(form) {
  const f = new FormData(form);
  const choice = String(f.get("choice") ?? "");
  if (!choice) return { error: "Pick what happened." };
  const [outcome, sideRaw] = choice.split(":");
  const body = { outcome };
  if (outcome === "win") body.winningSide = Number(sideRaw);
  if (outcome === "not_played") return { body };

  const a = String(f.get("s0") ?? "").trim(), b = String(f.get("s1") ?? "").trim();
  if (!a && !b) return { body };
  if (!a || !b) return { error: "Enter both scores, or leave both empty." };
  const score = [Number(a), Number(b)];
  if (!score.every((n) => Number.isInteger(n) && n >= 0)) return { error: "Scores are whole numbers." };
  if (outcome === "draw" && score[0] !== score[1]) return { error: "A draw needs a level score." };
  if (outcome === "win" && score[body.winningSide] <= score[1 - body.winningSide]) {
    return { error: "The winning side needs the higher score." };
  }
  body.score = score;
  return { body };
}

// ── actions ───────────────────────────────────────────────────────────

function bind(body, s) {
  const run = async (btn, path, payload, okMsg) => {
    if (s.busy) return;
    s.busy = true;
    if (btn) btn.disabled = true;
    try {
      s.result = await act(s.gameId, path, payload);
      if (okMsg) toast(okMsg);
      s.onChange?.();
      return true;
    } catch (err) {
      const box = body.querySelector(".res-error");
      if (path === "result" && box) { box.textContent = err.message; box.hidden = false; }
      else toast(err.message);
      if (btn) btn.disabled = false;
      return false;
    } finally {
      s.busy = false;
    }
  };
  const repaint = () => { if (body.isConnected) paint(body, s); };

  body.addEventListener("click", async (e) => {
    const ev = e.target.closest("[data-ev-place], [data-ev-ran], [data-ev-post], [data-ev-prize]");
    if (ev && !ev.disabled && !s.busy) {
      if (ev.matches("[data-ev-prize]")) { openPrizeSheet(s.gameId, { onChange: s.onChange }); return; }
      if (ev.matches("[data-ev-place]")) {
        const max = s.event?.terms?.split?.length || 1;
        togglePlace(s.places, ev.dataset.evPlace, max);
        repaint();
        return;
      }
      s.busy = true;
      ev.disabled = true;
      try {
        const placements = ev.matches("[data-ev-ran]") ? [] : [...s.places];
        s.event = await submitEventResult(s.gameId, placements);
        s.places = [];
        toast(ev.matches("[data-ev-ran]") ? "Confirmed. It ran." : "Result posted.");
        s.onChange?.();
      } catch (err) {
        toast(err.message);
      } finally {
        s.busy = false;
      }
      repaint();
      return;
    }
    const rp = e.target.closest("[data-roster-pick]");
    if (rp && !s.busy) {
      s.roster = { ...(s.roster ?? {}), [rp.dataset.user]: rp.dataset.rosterPick === "true" };
      repaint();
      return;
    }
    const rc = e.target.closest("[data-roster-confirm]");
    if (rc && !rc.disabled) {
      const players = s.result.roster?.players ?? [];
      const present = Object.fromEntries(players.map((p) => [p.id, s.roster?.[p.id] ?? p.hostPresent ?? p.checkedIn]));
      const fixing = Boolean(s.result.roster?.confirmedAt);
      if (await run(rc, "roster", { present }, fixing ? "Fix saved." : "Thanks. Who was here is confirmed.")) {
        s.roster = null;
        repaint();
      }
      return;
    }
    if (e.target.closest("[data-fix]")) { s.fixOpen = true; repaint(); return; }
    if (e.target.closest("[data-fix-cancel]")) { s.fixOpen = false; s.draft = {}; repaint(); return; }
    const sh = e.target.closest("[data-share-recap]");
    if (sh && s.onShare && !sh.disabled) {
      sh.disabled = true;
      try { await s.onShare(); } finally { sh.disabled = false; }
      return;
    }
    const t = e.target.closest("[data-pick], [data-start]");
    if (!t || t.disabled) return;
    const side = (v) => (v === "" ? null : Number(v));
    if (t.matches("[data-pick]")) {
      if (await run(t, "side", { userId: t.dataset.user, side: side(t.dataset.pick) })) repaint();
    } else if (t.matches("[data-start]")) {
      if (await run(t, "start", {}, "Sides locked. Good game.")) repaint();
    }
  });

  body.addEventListener("change", (e) => {
    const form = e.target.closest(".res-propose");
    if (!form) return;
    s.draft = { choice: form.choice.value, s0: form.s0.value, s1: form.s1.value };
    if (e.target.name !== "choice") return;
    // Only a new choice clears the error. A score's change fires on blur,
    // as the submit button is pressed; moving the layout then loses the tap.
    form.querySelector(".res-scorebox").hidden = s.draft.choice === "not_played";
    form.querySelector(".res-error").hidden = true;
  });

  body.addEventListener("submit", async (e) => {
    const form = e.target.closest(".res-propose");
    if (!form) return;
    e.preventDefault();
    const box = form.querySelector(".res-error");
    const { body: payload, error } = readResult(form);
    if (error) { box.textContent = error; box.hidden = false; return; }
    box.hidden = true;
    const fixing = s.result.status === "settled";
    if (await run(form.querySelector("[type=submit]"), "result", payload, fixing ? "Fix saved." : "Result recorded.")) {
      s.draft = {};
      s.fixOpen = false;
      repaint();
    }
  });
}
