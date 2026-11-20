/**
 * The trade sheet: pick a side, pick an amount, see what it pays, buy.
 *
 * Full screen on phones, a dialog on desktop (shared.js openSheet). Before
 * the trade view it may show:
 *   connect  no Gemini account connected (oauth mode)
 *   terms    Gemini's prediction market terms, not yet accepted
 * In practice mode neither applies: buys fill at the live Gemini price into
 * the practice account.
 *
 * Quotes come from the server (the same rounding the order uses) 300 ms
 * after the last change, and again every 15 s while the sheet is open. A
 * buy carries a fresh clientOrderId, so a double tap fills once.
 */

import { openSheet, toast, haptic, ICON } from "../shared.js";
import { esc, usd } from "../api.js";
import { openComposeSheet } from "../compose.js";
import { EVENTS, remember } from "./card.js";
import {
  CHANGED, acceptTerms, centsText, chanceText, connectUrl, eventByTicker, every, forgetMe, me, order,
  quote, terms, whenText,
} from "./client.js";

const AMOUNTS = [5, 10, 25, 50];

/** Gemini calls the third soccer outcome "Tie" or "Draw". */
const isDraw = (name) => /^(draw|tie)$/i.test(name ?? "");

/** "If Chicago win", "If it's a draw", "If Over 241.5". */
function ifText(c) {
  if (isDraw(c.name)) return "If it's a draw";
  if (c.name) return `If ${c.name} win`;
  return `If ${c.label}`;
}

/** "GEMI-NBA-2611170000-ORL-BOS-T-O183" → "NBA-2611170000-ORL-BOS-T". */
export function eventTickerOf(symbol) {
  if (!String(symbol).startsWith("GEMI-")) return null;
  const last = symbol.lastIndexOf("-");
  return last > 5 ? symbol.slice(5, last) : null;
}

/** Open the sheet for a contract symbol and side, loading its event if needed. */
export async function openTradeBySymbol(symbol, outcome = "yes") {
  const ticker = eventTickerOf(symbol);
  if (!ticker) return;
  let event = EVENTS.get(ticker);
  if (!event) {
    try {
      event = await eventByTicker(ticker);
      remember(event);
    } catch (err) {
      toast(err.message);
      return;
    }
  }
  const contract = event.contracts.find((c) => c.symbol === symbol);
  if (!contract) { toast("That market is not available right now."); return; }
  await openTrade({ event, contract, outcome });
}

/**
 * The choices the sheet toggles between. A game: each team (and a draw).
 * A total or spread line: that line, yes or no.
 */
function choicesFor(event, contract) {
  const line = event.kind === "total" || event.kind === "spread";
  if (event.kind === "moneyline" || (!line && event.contracts.length > 1)) {
    // The button shows the short name (CHI); sentences use the full one (Chicago).
    return event.contracts.slice(0, 3).map((c, i) => ({ contract: c, outcome: "yes", label: c.short, name: c.label, side: i }));
  }
  const yes = contract.short;
  const no = event.kind === "total" ? yes.replace(/^Over/, "Under") : `Not ${yes}`;
  return [
    { contract, outcome: "yes", label: yes, side: 0 },
    { contract, outcome: "no", label: no, side: 1 },
  ];
}

export async function openTrade({ event, contract, outcome = "yes" }) {
  const account = await me();
  if (!account.allowed) { toast("Pro markets are for adults only."); return; }
  if (!account.enabled) { toast("Pro markets are not switched on."); return; }

  const choices = choicesFor(event, contract);
  let pick = Math.max(0, choices.findIndex((c) => c.contract.symbol === contract.symbol && c.outcome === outcome));
  let dollars = 10;
  let current = null;      // the last quote
  let quoting = 0;
  let busy = false;

  const view = openSheet({ id: "trade", title: event.title, className: "sheet-trade" });
  const { sheet, body } = view;

  const state = () => {
    if (!account.connected) return "connect";
    if (!account.practice && !account.termsAccepted) return "terms";
    return "trade";
  };

  function paint() {
    const s = state();
    if (s === "connect") return paintConnect();
    if (s === "terms") return void paintTerms();
    paintTrade();
  }

  function paintConnect() {
    const oauth = account.trading === "oauth";
    body.innerHTML = `
      <div class="tr-panel">
        <div class="tr-icon" aria-hidden="true">${ICON.trendUp}</div>
        <h3 class="tr-h">Trade on Gemini</h3>
        <p class="tr-p">Connect your Gemini account to buy. You trade from your own account,
          and Gemini settles every market. Gemini Predictions is for US accounts.</p>
        ${oauth
          ? `<a class="btn-post tr-wide" href="${esc(connectUrl(event.sport))}">Connect Gemini</a>`
          : `<p class="tr-note">Trading is not switched on here.</p>`}
      </div>`;
  }

  async function paintTerms() {
    body.innerHTML = `<div class="tr-panel"><div class="skel skel-line" style="width:70%"></div><div class="skel skel-line" style="width:90%"></div></div>`;
    let t;
    try { t = await terms(); } catch (err) { body.innerHTML = `<div class="tr-panel"><p class="tr-p">${esc(err.message)}</p></div>`; return; }
    body.innerHTML = `
      <div class="tr-panel">
        <h3 class="tr-h">Gemini's prediction market terms</h3>
        <p class="tr-p">Gemini asks you to accept these before your first trade.</p>
        <div class="tr-terms" tabindex="0">${esc(t.content || "")}</div>
        <button type="button" class="btn-post tr-wide" id="tr-accept">I agree</button>
      </div>`;
    body.querySelector("#tr-accept").addEventListener("click", async (e) => {
      e.target.disabled = true;
      try {
        await acceptTerms();
        account.termsAccepted = true;
        paint();
        void requote();
      } catch (err) {
        toast(err.message);
        e.target.disabled = false;
      }
    });
  }

  function paintTrade() {
    const c = choices[pick];
    const chance = c.outcome === "yes" ? c.contract.chance : c.contract.chance === null ? null : 100 - c.contract.chance;
    body.innerHTML = `
      <div class="tr-trade">
        <div class="tr-top">
          <span class="tr-chance">${esc(chanceText(current?.chance ?? chance))}</span>
          <span class="tr-chance-text">${event.kind === "moneyline" ? `chance ${esc(c.name)} ${isDraw(c.name) ? "" : "win"}` : `chance of ${esc(c.label)}`}</span>
        </div>
        <p class="tr-sub">${esc(event.league)} · ${esc(whenText(event.startsAt))}</p>

        <fieldset class="tr-field">
          <legend class="tr-legend">${event.kind === "moneyline" ? "Who wins?" : "Your pick"}</legend>
          <div class="tr-choices">
            ${choices.map((ch, i) => `
              <button type="button" class="tr-choice mk-side-${ch.side}${i === pick ? " is-on" : ""}" data-pick="${i}" aria-pressed="${i === pick}">
                <span class="tr-choice-label">${esc(ch.label)}</span>
                <span class="tr-choice-cents">${esc(centsText(ch.contract[ch.outcome]?.buy))}</span>
              </button>`).join("")}
          </div>
        </fieldset>

        <fieldset class="tr-field">
          <legend class="tr-legend">Amount</legend>
          <label class="tr-amount">
            <span aria-hidden="true">$</span>
            <input type="number" inputmode="decimal" min="1" max="10000" step="1" value="${dollars}" id="tr-dollars" aria-label="Amount in dollars">
          </label>
          <div class="tr-chips">
            ${AMOUNTS.map((a) => `<button type="button" class="chip${a === dollars ? " chip-active" : ""}" data-amount="${a}" aria-pressed="${a === dollars}">$${a}</button>`).join("")}
          </div>
        </fieldset>

        <div class="tr-quote" id="tr-quote" aria-live="polite">${quoteRows()}</div>

        <div class="tr-actions">
          <button type="button" class="btn-post tr-wide" id="tr-buy" ${current && !busy ? "" : "disabled"}>
            ${current ? `Buy ${esc(c.label)} · ${esc(usd(current.cost))}` : "Getting a price…"}
          </button>
          <p class="tr-fine">${account.practice ? "Live Gemini prices" : "Traded on Gemini"} · ${esc(usd(account.usdAvailable))} available</p>
        </div>
      </div>`;

    body.querySelector(".tr-choices").addEventListener("click", (e) => {
      const b = e.target.closest("[data-pick]");
      if (!b) return;
      pick = Number(b.dataset.pick);
      current = null;
      paintTrade();
      void requote();
    });
    body.querySelector(".tr-chips").addEventListener("click", (e) => {
      const b = e.target.closest("[data-amount]");
      if (!b) return;
      dollars = Number(b.dataset.amount);
      current = null;
      paintTrade();
      void requote();
    });
    const input = body.querySelector("#tr-dollars");
    let t = null;
    input.addEventListener("input", () => {
      clearTimeout(t);
      t = setTimeout(() => {
        const v = Number(input.value);
        if (!Number.isFinite(v) || v <= 0) return;
        dollars = v;
        void requote({ keepInput: true });
      }, 300);
    });
    body.querySelector("#tr-buy").addEventListener("click", () => void buy());
  }

  function quoteRows(error) {
    if (error) return `<p class="tr-error">${esc(error)}</p>`;
    if (!current) return `<div class="skel skel-line" style="width:60%"></div><div class="skel skel-line" style="width:45%"></div>`;
    const c = choices[pick];
    return `
      <div class="tr-row"><span>You pay</span><strong>${esc(usd(current.cost))}</strong></div>
      <div class="tr-row"><span>Contracts</span><strong>${esc(current.qty)} at ${esc(centsText(current.price))}</strong></div>
      <div class="tr-row tr-row-win"><span>${esc(ifText(c))}</span><strong>${esc(usd(current.payout))}</strong></div>`;
  }

  async function requote({ keepInput = false } = {}) {
    const seq = ++quoting;
    const c = choices[pick];
    let q = null;
    let error = null;
    try {
      q = await quote({ symbol: c.contract.symbol, outcome: c.outcome, dollars });
    } catch (err) {
      error = err.message;
    }
    if (seq !== quoting || !sheet.isConnected || state() !== "trade") return;
    current = q;
    if (keepInput) {
      // Keep the field the user is typing in; refresh only what depends on the quote.
      body.querySelector("#tr-quote").innerHTML = quoteRows(error);
      const btn = body.querySelector("#tr-buy");
      btn.disabled = !current || busy;
      btn.textContent = current ? `Buy ${c.label} · ${usd(current.cost)}` : "Pick an amount";
      body.querySelectorAll("[data-amount]").forEach((b) => {
        const on = Number(b.dataset.amount) === dollars;
        b.classList.toggle("chip-active", on);
        b.setAttribute("aria-pressed", String(on));
      });
      return;
    }
    paintTrade();
    if (error) body.querySelector("#tr-quote").innerHTML = quoteRows(error);
  }

  async function buy() {
    if (busy || !current) return;
    busy = true;
    haptic(10);
    const btn = body.querySelector("#tr-buy");
    btn.disabled = true;
    btn.textContent = "Buying…";
    const c = choices[pick];
    try {
      const res = await order({
        symbol: c.contract.symbol, outcome: c.outcome, dollars, clientOrderId: crypto.randomUUID(),
      });
      busy = false;
      document.dispatchEvent(new CustomEvent(CHANGED));
      paintDone(res, c);
    } catch (err) {
      busy = false;
      if (err.code === "GEMINI_NOT_CONNECTED") { account.connected = false; forgetMe(); paint(); return; }
      if (err.code === "TERMS_NOT_ACCEPTED") { account.termsAccepted = false; paint(); return; }
      if (err.code === "PRICE_MOVED") {
        toast("The price moved. Check the new price and buy again.");
        current = null;
        await requote();
        return;
      }
      const msg = err.code === "INSUFFICIENT_FUNDS" && account.siteUrl
        ? `${err.message} <a href="${esc(account.siteUrl)}" target="_blank" rel="noopener">Add money on Gemini</a>`
        : esc(err.message);
      body.querySelector("#tr-quote").innerHTML = `<p class="tr-error">${msg}</p>`;
      btn.disabled = false;
      btn.textContent = `Buy ${c.label} · ${usd(current.cost)}`;
    }
  }

  function paintDone(res, c) {
    const f = res.fill;
    body.innerHTML = `
      <div class="tr-panel tr-done">
        <div class="tr-check" aria-hidden="true">${ICON.check}</div>
        <h3 class="tr-h">You're in on ${esc(c.name ?? c.label)}</h3>
        <p class="tr-p">${esc(f.qty)} contracts at ${esc(centsText(f.avgPrice))}${f.partial ? " (part of your order filled)" : ""}.
          Each pays $1 ${esc(ifText(c).replace(/^If/, "if"))}, and Gemini settles it after the game.</p>
        <div class="tr-done-actions">
          <button type="button" class="btn-game btn-game-ghost" id="tr-share">Share to feed</button>
          <button type="button" class="btn-post" id="tr-close">Done</button>
        </div>
      </div>`;
    body.querySelector("#tr-close").addEventListener("click", () => view.close());
    body.querySelector("#tr-share").addEventListener("click", () => {
      view.close();
      openComposeSheet({
        sport: event.sport,
        market: { symbol: c.contract.symbol, outcome: c.outcome, title: event.title, label: c.label },
      });
    });
  }

  paint();
  if (state() === "trade") void requote();
  every(sheet, 15_000, () => {
    if (state() === "trade" && !busy && body.querySelector("#tr-buy")) void requote({ keepInput: true });
  });
}
