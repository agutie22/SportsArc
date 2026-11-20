/**
 * The Markets view under ALL: one featured game per sport Gemini lists
 * (GET /api/markets/featured), each with a link to that sport's full
 * Markets view. The rail beside it shows positions across every sport.
 */

import { esc, titleCase } from "../api.js";
import { bindTrade, gameMarketCard } from "./card.js";
import { every, featured } from "./client.js";

export function renderAllTab(_sport, el) {
  el.className = "mk-tab mk-all";
  bindTrade(el);
  el.innerHTML = `<div class="mk-card mk-skel"><div class="skel skel-line" style="width:40%"></div><div class="skel skel-line" style="width:70%"></div></div>`.repeat(2);

  const paint = async (fresh = false) => {
    let sports = null;
    let error = null;
    try { sports = await featured({ fresh }); } catch (err) { error = err.message; }
    if (!el.isConnected) return;
    if (error) { el.innerHTML = `<div class="empty">${esc(error)}</div>`; return; }
    if (!sports.length) { el.innerHTML = `<div class="empty">No markets open on Gemini right now.</div>`; return; }
    el.innerHTML = `
      <h2 class="mk-all-title">Featured in each sport</h2>
      ${sports.map((s) => `
        <section class="mk-all-sport" aria-label="${esc(titleCase(s.sport))}">
          <div class="mk-all-head">
            <h3 class="mk-all-name">${esc(titleCase(s.sport))}</h3>
            <a class="mk-all-more" href="#/sport/${esc(s.sport)}?view=markets">All ${s.count} ${esc(s.sport)} markets →</a>
          </div>
          ${gameMarketCard(s.headline, { headline: true })}
        </section>`).join("")}
      <p class="mk-disclaimer">Markets are listed and settled by Gemini. Prices update every 15 seconds.</p>`;
  };
  void paint();
  every(el, 15_000, () => void paint(true));
}
