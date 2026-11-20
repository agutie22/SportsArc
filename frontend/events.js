/**
 * Paid events on top of a game: the fee and prize on a card, registering
 * and leaving (the fee comes back), the host putting up the prize, and the
 * host posting who placed. Every one of those is a PIN signature
 * the server relays, so the player pays no gas. The screens say "$10".
 *
 * The host sheet (host.js) collects the terms and calls publishEvent.
 * Games and the result sheet call in here; they do not talk to the
 * events API themselves.
 */

import { toast, openSheet } from "./shared.js";
import { apiGet, apiSend, esc, ordinal, personLink, sleep, usd } from "./api.js";
import { choosePayout, openAddMoneySheet, runSignature } from "./money.js";


/** "$10.00" from the API as "$10". */
const shown = (v) => usd(v, { short: true });

function needsLine(t) {
  if (!t) return "";
  if (t.status === "void" || t.status === "cancelled" || t.status === "expired") return "Refunded";
  if (t.status === "final") return t.place ? `${ordinal(t.place)} place · verified event` : "Paid out";
  if (t.status === "posted" && t.finalAt) {
    const left = new Date(t.finalAt).getTime() - Date.now();
    if (left > 0) {
      const min = Math.max(1, Math.round(left / 60000));
      return min >= 60 ? `Result in ${Math.round(min / 60)} h` : `Result in ${min} min`;
    }
    return "Paying out";
  }
  if (t.status === "draft") return "Finish setup";
  const needs = Math.max(0, (t.minPlayers ?? 0) - (t.entrants ?? 0));
  if (t.status === "open" && needs > 0) return `Needs ${needs} more to run`;
  if (t.status === "open") return "Ready to run";
  return "";
}

function priceLine(t) {
  const fee = t.free ? "" : `${shown(t.entryFeeUsd)} entry`;
  const prize = t.prizeUsd ? `${shown(t.prizeUsd)} prize` : "";
  return [fee, prize].filter(Boolean).join(" · ");
}

/** A shortfall ("You need $4.00 more") offers Add. True when it handled the error. */
function shortfall(err) {
  if (err?.code !== "LOW_BALANCE") return false;
  const msg = String(err.message).replace(/(\$\d+)\.00/g, "$1");
  toast(msg, { action: { label: "Add", onClick: () => void openAddMoneySheet() } });
  return true;
}

/** Sign the challenge a start call returned, then confirm until it settles. */
async function pinAndConfirm(started, confirmPath, settled) {
  if (!started?.challenge) throw new Error("Nothing to sign. Try again.");
  toast("Confirm with your PIN.");
  const signature = await runSignature(started.challenge);
  let body = await apiSend(confirmPath, "POST", { signature });
  for (let i = 0; !settled(body) && i < 6; i++) {
    await sleep(2000);
    body = await apiSend(confirmPath, "POST", {});
  }
  if (!settled(body)) throw new Error("Still waiting for the network. Check back in a minute.");
  return body;
}

const termsSettled = (b) => b.terms && b.terms.status !== "draft" && !b.terms.pending;
const entrySettled = (b) => b.entry && (b.entry.state === "entered" || b.entry.state === "left");
const prizeSettled = (b) => b.prize && (b.prize.state === "funded" || b.prize.state === "failed");

/**
 * After the game exists: the host signs the terms, then (when they
 * put an amount in) signs the prize. Throws if either signature does not
 * finish; a prize failure means the event itself is already open.
 */
export async function publishEvent(game, { entryFee, minPlayers, prize, prizeAmount }) {
  const id = game.id;
  const started = await apiSend(`/api/web3/events/games/${id}/terms`, "POST", {
    entryFee: entryFee ? String(entryFee) : "0",
    minPlayers,
    prize: prize ? "top3" : undefined,
  });
  await pinAndConfirm(started, `/api/web3/events/games/${id}/confirm`, termsSettled);
  if (!prize || !prizeAmount) return;
  try {
    const funded = await apiSend(`/api/web3/events/games/${id}/prize`, "POST", { amount: String(prizeAmount) });
    const done = await pinAndConfirm(funded, `/api/web3/events/prizes/${funded.prize.id}/confirm`, prizeSettled);
    if (done.prize?.state === "failed") throw new Error("The prize did not go through. The event is open; you can fund it from the game.");
  } catch (err) {
    if (shortfall(err)) throw new Error("The event is open. Add money, then fund the prize from the game.");
    if (/event is open/i.test(err.message)) throw err;
    throw new Error(`The event is open, but the prize was not funded: ${err.message}`);
  }
}

/** The host cancels. A draft ends at once; an open event needs the PIN, and everyone is refunded. */
export async function cancelPaidEvent(gameId) {
  const started = await apiSend(`/api/web3/events/games/${gameId}/cancel`, "POST", {});
  if (!started.challenge) return started;
  return pinAndConfirm(started, `/api/web3/events/games/${gameId}/confirm`, (b) =>
    b.terms?.status === "cancelled" || b.terms?.status === "draft" || !b.isEvent);
}

export async function openRegisterSheet(gameId, { onChange } = {}) {
  const sheet = openSheet({ id: "event-register", title: "Enter event", className: "sheet-result sheet-pay" });
  const body = sheet.body;
  body.innerHTML = `<div class="skel skel-line" style="width:40%"></div>`;
  let status;
  try { status = await apiGet(`/api/web3/events/games/${gameId}`); }
  catch (err) { body.innerHTML = `<p class="res-hint">${esc(err.message)}</p>`; return; }
  if (!sheet.sheet.isConnected) return;
  const t = status.terms;
  if (!t || !status.can?.enter) {
    body.innerHTML = `<p class="res-hint">${esc(needsLine(t) || "Registration is not open.")}</p>`;
    return;
  }
  const price = t.free ? "Free to enter" : shown(t.entryFeeUsd);
  const prize = t.prizeUsd ? `${shown(t.prizeUsd)} prize` : "";
  body.innerHTML = `
    <p class="ev-price">${esc(price)}${prize ? ` <span>· ${esc(prize)}</span>` : ""}</p>
    <p class="res-hint">${t.free
      ? "Confirm with your PIN to take a spot. There is nothing to pay."
      : `You pay ${esc(shown(t.entryFeeUsd))}. The host receives the rest after ${t.fee ? `a ${esc(shown(t.fee.perEntryUsd))} fee` : "the platform fee"}.`}</p>
    <p class="res-hint">${esc(needsLine(t))}</p>
    <div class="pay-actions"><button type="button" class="btn-game" data-go>Register</button></div>`;
  body.querySelector("[data-go]").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const payout = t.free ? "wallet" : await choosePayout(shown(t.entryFeeUsd), {
        title: `Enter · ${shown(t.entryFeeUsd)}`,
        hint: "If the event does not run, this comes back. Where should it go?",
        walletNote: "It comes back to your SportsArc wallet.",
      });
      const started = await apiSend(`/api/web3/events/games/${gameId}/register`, "POST", { payout });
      await pinAndConfirm(started, `/api/web3/events/games/${gameId}/register/confirm`, entrySettled);
      toast("You're in.");
      sheet.close();
      onChange?.();
    } catch (err) {
      if (!shortfall(err) && err?.message !== "Cancelled. Nothing was sent.") toast(err.message);
      if (body.isConnected) btn.disabled = false;
    }
  });
}

export async function leaveEvent(gameId) {
  const started = await apiSend(`/api/web3/events/games/${gameId}/leave`, "POST", {});
  await pinAndConfirm(started, `/api/web3/events/games/${gameId}/leave/confirm`, (b) => b.entry?.state === "left");
}

/** The host puts up prize money (more than once is fine). */
export function openPrizeSheet(gameId, { onChange } = {}) {
  const sheet = openSheet({ id: "event-prize", title: "Put up a prize", className: "sheet-result sheet-pay" });
  const body = sheet.body;
  body.innerHTML = `
    <p class="res-hint">This goes to the placed players if the event runs, and back to you if it does not. Winners split it 60 / 30 / 10.</p>
    <label class="hs-sec"><span class="hs-label">Amount</span>
      <input class="hs-input" data-amt inputmode="decimal" placeholder="200" value="200"></label>
    <div class="pay-actions"><button type="button" class="btn-game" data-go>Put up the prize</button></div>`;
  body.querySelector("[data-go]").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const amount = body.querySelector("[data-amt]").value.trim();
    if (!amount) return;
    btn.disabled = true;
    try {
      const started = await apiSend(`/api/web3/events/games/${gameId}/prize`, "POST", { amount });
      const done = await pinAndConfirm(started, `/api/web3/events/prizes/${started.prize.id}/confirm`, prizeSettled);
      if (done.prize?.state === "failed") throw new Error("The prize did not go through. Nothing was taken.");
      toast("Prize added.");
      sheet.close();
      onChange?.();
    } catch (err) {
      if (!shortfall(err)) toast(err.message);
      if (body.isConnected) btn.disabled = false;
    }
  });
}

/** Price, status and the extra buttons on each event card in a list. */
/** What entering costs, for the game sheet: the fee or "Free", and the prize. Null until terms are out. */
export async function eventCost(gameId) {
  const r = await apiGet("/api/web3/events/terms", { ids: gameId }).catch(() => null);
  const t = r?.terms?.[gameId];
  if (!t) return null;
  return {
    free: Boolean(t.free),
    label: t.free ? "Free" : shown(t.entryFeeUsd),
    sub: t.prizeUsd ? `${shown(t.prizeUsd)} prize` : t.free ? "Nothing to pay" : "to enter",
  };
}

export async function decorateEvents(root, { onChange } = {}) {
  const cards = [...root.querySelectorAll("[data-game-card]")];
  const events = cards.filter((c) => c.dataset.kind === "event" && !c.dataset.eventDecorated);
  if (!events.length) return;
  let r;
  try {
    r = await apiGet("/api/web3/events/terms", { ids: events.map((c) => c.dataset.gameCard).join(",") });
  } catch {
    return;
  }
  if (!root.isConnected) return;
  for (const card of events) {
    const t = r.terms?.[card.dataset.gameCard];
    card.dataset.eventDecorated = "1";
    const meta = card.querySelector(".game-meta");
    const line = t ? priceLine(t) : "";
    const status = needsLine(t);
    if (meta && (line || status)) {
      meta.insertAdjacentHTML("afterbegin",
        `${line ? `<span class="game-event">${esc(line)}</span>` : ""}` +
        `${status ? `<span class="game-event game-event-status">${esc(status)}</span>` : ""}`);
    }
    const action = card.querySelector(".game-action");
    if (!action || !t) continue;
    if (t.status === "draft") {
      action.insertAdjacentHTML("afterbegin", `<button class="btn-game" data-event-finish="${esc(card.dataset.gameCard)}">Finish setup</button>`);
    } else if (t.takesPrize && t.status === "open" && card.hasAttribute("data-host")) {
      // The host's own event: in the card's "more" menu, above Leave.
      const menu = card.querySelector(".gc-menu");
      const item = `<button type="button" class="gc-menu-item" data-event-prize="${esc(card.dataset.gameCard)}">Add to the prize</button>`;
      const leave = menu?.querySelector(".gc-menu-danger");
      if (leave) leave.insertAdjacentHTML("beforebegin", item);
      else menu?.insertAdjacentHTML("beforeend", item);
    }
    const enter = card.querySelector("[data-enter]");
    if (enter && t.entryFeeUsd && !t.free) enter.textContent = `Enter · ${shown(t.entryFeeUsd)}`;
    if (enter && (t.status !== "open" || (t.mine && t.mine !== "failed" && t.mine !== "left"))) enter.remove();
  }
  root.querySelectorAll("[data-event-prize]").forEach((b) => {
    if (b.dataset.bound) return;
    b.dataset.bound = "1";
    b.addEventListener("click", () => openPrizeSheet(b.dataset.eventPrize, { onChange }));
  });
  root.querySelectorAll("[data-event-finish]").forEach((b) => {
    if (b.dataset.bound) return;
    b.dataset.bound = "1";
    b.addEventListener("click", () => void finishSetup(b.dataset.eventFinish, onChange));
  });
}

async function finishSetup(gameId, onChange) {
  try {
    const s = await apiGet(`/api/web3/events/games/${gameId}`);
    const t = s.terms;
    if (!t) throw new Error("This event has no terms yet.");
    const started = await apiSend(`/api/web3/events/games/${gameId}/terms`, "POST", {
      entryFee: String(t.entryFeeUsd).replace("$", ""),
      minPlayers: t.minPlayers,
      prize: t.split ?? undefined,
    });
    await pinAndConfirm(started, `/api/web3/events/games/${gameId}/confirm`, termsSettled);
    toast("Event is open.");
    onChange?.();
  } catch (err) {
    if (!shortfall(err)) toast(err.message);
  }
}

/** "1st place · verified event" on a profile's games, once a result is posted. */
export async function annotateProfileGames(root) {
  const cards = [...root.querySelectorAll("[data-pf-game]")];
  if (!cards.length) return;
  let r;
  try {
    r = await apiGet("/api/web3/events/terms", { ids: cards.map((c) => c.dataset.pfGame).join(",") });
  } catch {
    return;
  }
  for (const card of cards) {
    const t = r.terms?.[card.dataset.pfGame];
    if (!t?.place) continue;
    card.querySelector(".game-line1")?.insertAdjacentHTML("beforeend",
      `<span class="game-badge game-badge-in">${esc(ordinal(t.place))} place · verified event</span>`);
  }
}

/**
 * The money result inside the result sheet: who placed, or "It ran" when
 * there is no prize. Empty when this game is not an event.
 */
export function eventResultHtml(event, game, places) {
  if (!event?.isEvent || !event.terms) return "";
  const t = event.terms;
  const posted = t.result;
  const postedLine = posted?.placements?.length
    ? posted.placements.map((p) => `${ordinal(p.place)} ${personLink(p.user, { fallback: "Player" })}${p.prizeUsd && p.prizeUsd !== "$0.00" ? ` · ${esc(shown(p.prizeUsd))}` : ""}`).join("<br>")
    : posted ? "It ran. No prize to pay." : "";
  const countdown = needsLine(t);
  let form = "";
  if (event.can?.postResult) {
    const paid = t.split?.length && t.prizeUsd && t.prizeUsd !== "$0.00";
    const max = paid ? t.split.length : 0;
    const checked = (game.players ?? []).filter((p) => p.checkedIn);
    if (!paid) {
      form = `<button type="button" class="btn-game" data-ev-ran>It ran</button>
        <p class="res-hint">Confirm with your PIN. Entry fees go to you after a short window.</p>`;
    } else {
      form = `
        <p class="res-hint">Tap players in order, ${ORDINAL.slice(0, max).join(", ")}. ${max === 1 ? "One place." : `${max} places.`} Confirm with your PIN.</p>
        <ul class="res-list">${checked.map((p) => {
          const at = places.indexOf(p.id);
          return `<li><button type="button" class="ev-place${at >= 0 ? " is-on" : ""}" data-ev-place="${esc(p.id)}">
            <span>${at >= 0 ? esc(ordinal(at + 1)) : ""}</span>${esc(p.name ?? "Player")}</button></li>`;
        }).join("")}</ul>
        <button type="button" class="btn-game" data-ev-post ${places.length ? "" : "disabled"}>Post result</button>`;
    }
  }
  return `
    <section class="ev-result">
      <h4 class="res-title">Event ${countdown ? `<span class="hm-dim">${esc(countdown)}</span>` : ""}</h4>
      ${postedLine ? `<p class="res-hint">${postedLine}</p>` : ""}
      ${form}
      ${event.can?.addPrize ? `<button type="button" class="btn-game btn-game-ghost" data-ev-prize>Add to the prize</button>` : ""}
    </section>`;
}

/** Toggle a player in the place order. `max` is how many places the prize pays. */
export function togglePlace(places, userId, max) {
  const i = places.indexOf(userId);
  if (i >= 0) places.splice(i, 1);
  else if (places.length < max) places.push(userId);
  return places;
}

export async function submitEventResult(gameId, placements) {
  const started = await apiSend(`/api/web3/events/games/${gameId}/result`, "POST", { placements });
  return pinAndConfirm(started, `/api/web3/events/games/${gameId}/confirm`, (b) =>
    b.terms && (b.terms.status === "posted" || b.terms.status === "final" || b.terms.status === "void"));
}
