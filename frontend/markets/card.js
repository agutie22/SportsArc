/**
 * Pro market cards: the game card in the Markets view, its
 * larger headline version, and the scoreboard tile in the strip.
 *
 * Every price button carries data-trade (a contract symbol) and
 * data-outcome; bindTrade() on any root opens the trade sheet from them.
 * A card's chance carries an odds placeholder that odds.js fills with the
 * last 24 hours.
 * Events seen here are remembered by ticker so the sheet opens instantly.
 */

import { esc } from "../api.js";
import { centsText, chanceText, volumeText, whenText } from "./client.js";
import { oddsSlot, watchOdds } from "./odds.js";

/** Events rendered this page view, by ticker (child markets included). */
export const EVENTS = new Map();

export function remember(e) {
  if (!e) return;
  EVENTS.set(e.ticker, e);
  if (e.lines?.spread) EVENTS.set(e.lines.spread.ticker, e.lines.spread);
  if (e.lines?.total) EVENTS.set(e.lines.total.ticker, e.lines.total);
}

const SIDES = ["mk-a", "mk-b", "mk-c"];

/** The favorite and its chance, for the big number. */
function favorite(e) {
  const priced = e.contracts.filter((c) => c.chance !== null);
  if (!priced.length) return null;
  return priced.reduce((a, b) => (b.chance > a.chance ? b : a));
}

/** One price button: contract c as side i (mk-a, mk-b, mk-c), opening the trade sheet. */
export function priceButton(c, i, outcome = "yes", text = c.short) {
  const p = c[outcome]?.buy;
  return `
    <button type="button" class="mk-price ${SIDES[i] ?? "mk-c"}" data-trade="${esc(c.symbol)}" data-outcome="${outcome}"
            ${p ? "" : "disabled"} aria-label="Buy ${esc(outcome === "no" ? `not ${text}` : text)} at ${esc(centsText(p))}">
      <span class="mk-price-label">${esc(text)}</span><span class="mk-price-cents">${esc(centsText(p))}</span>
    </button>`;
}

/** Over/under and spread lines under a game card. */
function lines(e) {
  const out = [];
  for (const kind of ["total", "spread"]) {
    const line = e.lines?.[kind];
    const c = line?.contracts?.[0];
    if (!c || !c.yes.buy) continue;
    out.push(`
      <button type="button" class="mk-line" data-trade="${esc(c.symbol)}" data-outcome="yes">
        <span>${esc(c.short)}</span><span class="mk-line-cents">${esc(centsText(c.yes.buy))}</span>
      </button>`);
  }
  return out.length ? `<div class="mk-lines">${out.join("")}</div>` : "";
}

/** A game (moneyline) card. `headline` adds the probability bar and a larger number. */
export function gameMarketCard(e, { headline = false } = {}) {
  remember(e);
  const fav = favorite(e);
  const two = e.contracts.length === 2;
  const bar = headline && two && e.contracts.every((c) => c.chance !== null)
    ? `<div class="mk-bar" aria-hidden="true">
         <span class="mk-bar-a" style="flex:${e.contracts[0].chance}"></span><span class="mk-bar-b" style="flex:${e.contracts[1].chance}"></span>
       </div>`
    : "";
  return `
    <article class="mk-card${headline ? " mk-headline" : ""}" aria-label="${esc(e.title)}">
      <div class="mk-meta">
        <span>${headline ? "Featured game · " : ""}${esc(e.league)}</span>
        <span class="${whenText(e.startsAt) === "Live" ? "mk-live" : ""}">${esc(whenText(e.startsAt))}</span>
      </div>
      <h3 class="mk-title">${esc(e.title)}</h3>
      ${fav ? `
        <div class="mk-chance">
          <span class="mk-chance-num">${esc(chanceText(fav.chance))}</span>
          <span class="mk-chance-text">chance ${esc(fav.label)} ${e.kind === "moneyline" ? "win" : ""}</span>
        </div>
        ${oddsSlot(fav, `Chance ${fav.label} win`)}` : ""}
      ${bar}
      <div class="mk-prices">${e.contracts.slice(0, 3).map((c, i) => priceButton(c, i)).join("")}</div>
      ${lines(e)}
      <div class="mk-foot">${esc(volumeText(e.volumeUsd))} · on Gemini</div>
    </article>`;
}

/** A child market (total or spread) on its own: its most even line, both ways. */
export function lineMarketCard(parent, kind) {
  const line = parent.lines?.[kind];
  const c = line?.contracts?.[0];
  if (!c) return "";
  remember(parent);
  const yes = c.short;
  const no = kind === "total" ? yes.replace(/^Over/, "Under") : `Not ${yes}`;
  return `
    <article class="mk-card" aria-label="${esc(parent.title)} ${esc(kind)}">
      <div class="mk-meta"><span>${esc(parent.league)} · ${kind === "total" ? "Total points" : "Point spread"}</span>
        <span>${esc(whenText(parent.startsAt))}</span></div>
      <h3 class="mk-title">${esc(parent.title)}</h3>
      <div class="mk-chance">
        <span class="mk-chance-num">${esc(chanceText(c.chance))}</span>
        <span class="mk-chance-text">chance of ${esc(yes)}</span>
      </div>
      ${oddsSlot(c, `Chance of ${yes}`)}
      <div class="mk-prices">${priceButton(c, 0, "yes", yes)}${priceButton(c, 1, "no", no)}</div>
      <div class="mk-foot">on Gemini</div>
    </article>`;
}

/**
 * Time beside a league on the ALL strip. Today keeps "7:30 PM"; a later day
 * uses a short form ("Tmr 5:15p", "Fri 12:00p") so league and time share
 * one line and the tile stays as tall as a single-sport tile.
 */
function tileWhen(text) {
  if (!text || text === "Live") return text;
  const today = /^(?:Tonight|Today) (.+)$/.exec(text);
  if (today) return today[1];
  const day = /^(Tomorrow|[A-Z][a-z]{2}) (.+)$/.exec(text);
  if (!day) return text;
  const time = day[2].replace(" AM", "a").replace(" PM", "p");
  return `${day[1] === "Tomorrow" ? "Tmr" : day[1]} ${time}`;
}

/** A scoreboard tile for the strip. `league` puts the league on the time line (the mixed strip under ALL). */
export function scoreTile(e, { league = false } = {}) {
  remember(e);
  const rows = e.contracts.slice(0, 2).map((c, i) => `
    <span class="mk-tile-row"><span>${esc(c.short)}</span><span class="${SIDES[i]}-ink">${esc(centsText(c.yes.buy))}</span></span>`).join("");
  const first = e.contracts[0];
  const when = whenText(e.startsAt);
  const live = when === "Live" ? " mk-live" : "";
  const shown = league ? tileWhen(when) : when;
  const kicker = league
    ? `<span class="mk-tile-kicker"><span class="mk-tile-league">${esc(e.league)}</span><span class="mk-tile-when${live}">${esc(shown)}</span></span>`
    : `<span class="mk-tile-when${live}">${esc(when)}</span>`;
  return `
    <button type="button" class="mk-tile" data-trade="${esc(first?.symbol ?? "")}" data-outcome="yes"
            aria-label="${esc(e.title)}${league ? `, ${esc(e.league)}` : ""}, ${esc(when)}">
      ${kicker}
      ${rows}
    </button>`;
}

/** Open the trade sheet from any price button under `root`, and paint its odds lines (odds.js). */
export function bindTrade(root) {
  if (!root || root.dataset.tradeBound) return;
  root.dataset.tradeBound = "1";
  watchOdds(root);
  root.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-trade]");
    if (!b || !b.dataset.trade) return;
    const trade = await import("./trade.js");
    void trade.openTradeBySymbol(b.dataset.trade, b.dataset.outcome === "no" ? "no" : "yes");
  });
}
