/**
 * The Markets view on the Games page: the featured game across the top,
 * then Games, Totals and Spreads as card grids. Totals and spreads show each
 * game's most even line.
 */

import { esc } from "../api.js";
import { bindTrade, gameMarketCard, lineMarketCard } from "./card.js";
import { every, markets } from "./client.js";
import { stripOrder } from "./strip.js";

const KINDS = [
  { id: "games", label: "Games" },
  { id: "total", label: "Totals" },
  { id: "spread", label: "Spreads" },
];

/** The chip last chosen: a preference kept across sports. */
let KIND = "games";

export function renderTab(sport, el) {
  el.className = "mk-tab";
  bindTrade(el);

  const paint = async (fresh = false) => {
    let b;
    let error = null;
    try { b = await markets(sport, { fresh }); } catch (err) { error = err.message; }
    if (!el.isConnected) return;
    const games = b ? stripOrder(b.events) : [];
    const has = (k) => k === "games" || games.some((e) => e.lines?.[k]?.contracts?.length);
    // A sport without that kind shows Games, and the choice stays for the next sport.
    const kind = has(KIND) ? KIND : "games";
    const featured = kind === "games" && b?.headline ? b.headline : null;
    const cards = kind === "games"
      ? games.filter((e) => e.ticker !== featured?.ticker).map((e) => gameMarketCard(e))
      : games.filter((e) => e.lines?.[kind]?.contracts?.length).map((e) => lineMarketCard(e, kind));
    el.innerHTML = `
      <div class="mk-kinds" role="group" aria-label="Market type">
        ${KINDS.filter((k) => has(k.id)).map((k) => `
          <button type="button" class="chip${k.id === kind ? " chip-active" : ""}" data-kind="${k.id}" aria-pressed="${k.id === kind}">${esc(k.label)}</button>`).join("")}
      </div>
      ${featured ? gameMarketCard(featured, { headline: true }) : ""}
      ${error ? `<div class="empty">${esc(error)}</div>`
        : cards.length ? `<div class="mk-grid">${cards.join("")}</div>`
          : `<div class="empty">No ${esc(sport)} markets open on Gemini right now.</div>`}
      <p class="mk-disclaimer">Markets are listed and settled by Gemini. Prices update every 15 seconds.</p>`;
  };

  el.addEventListener("click", (e) => {
    const b = e.target.closest("[data-kind]");
    if (!b) return;
    KIND = b.dataset.kind;
    void paint();
  });
  el.innerHTML = `<div class="mk-grid">${'<div class="mk-card mk-skel"><div class="skel skel-line" style="width:60%"></div><div class="skel skel-line" style="width:80%"></div></div>'.repeat(3)}</div>`;
  void paint();
  every(el, 15_000, () => void paint(true));
}
