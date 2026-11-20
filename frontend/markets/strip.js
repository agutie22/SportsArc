/**
 * The scoreboard strip under the sport tabs: one tile per upcoming game,
 * pro leagues first, scrolling sideways. A tile opens the trade sheet on
 * its first team. Prices refresh every 15 s while it is on screen.
 *
 * Under ALL it mixes every sport's next games (GET /api/markets/featured),
 * each tile labelled with its league on the time line, so the strip stays
 * the same height as one sport.
 */

import { bindTrade, scoreTile } from "./card.js";
import { every, featured, markets, onChanged } from "./client.js";

const PRO = new Set(["NBA", "WNBA", "NFL", "NHL", "MLB", "EPL", "MLS", "LALIGA", "LIGAMX", "UCL", "SERIEA", "BUNDESLIGA", "ATP", "WTA"]);
const MAX_TILES = 14;

/**
 * Every sport's next games as one strip, taking turns between sports (each
 * sport's list already puts pro games first), so one busy league cannot
 * fill it.
 */
function mixed(sports) {
  const lists = sports.map((s) => [...(s.upcoming ?? [])]);
  const out = [];
  while (lists.some((l) => l.length)) {
    for (const l of lists) if (l.length) out.push(l.shift());
  }
  return out;
}

/** Pro games first (in start order), then the rest. */
export function stripOrder(events) {
  const games = events.filter((e) => e.kind === "moneyline" && e.contracts.length >= 2);
  return [...games.filter((e) => PRO.has(e.leagueCode)), ...games.filter((e) => !PRO.has(e.leagueCode))];
}

export function renderStrip(sport, el) {
  el.classList.add("mk-strip");
  el.setAttribute("aria-label", "Pro markets");
  el.innerHTML = `<div class="mk-strip-label"><span class="mk-strip-league">…</span><span class="mk-strip-sub">on Gemini</span></div>
    <div class="mk-strip-tiles" role="list"></div>`;
  bindTrade(el);

  const paint = async (fresh = false) => {
    let games = [];
    try { games = sport ? stripOrder((await markets(sport, { fresh })).events) : mixed(await featured({ fresh })); } catch { games = []; }
    if (!el.isConnected) return;
    games = games.slice(0, MAX_TILES);
    const box = el.closest(".games-strip");
    if (!games.length) { box?.setAttribute("hidden", ""); return; }
    box?.removeAttribute("hidden");
    el.querySelector(".mk-strip-league").textContent = sport ? (games[0].league || games[0].leagueCode) : "Top games";
    el.querySelector(".mk-strip-tiles").innerHTML = games
      .map((e) => `<div role="listitem">${scoreTile(e, { league: !sport })}</div>`).join("");
  };
  void paint();
  every(el, 15_000, () => void paint(true));
  onChanged(el, () => void paint(true));
}

