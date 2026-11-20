/**
 * Pro markets on Home: the parts markets/index.js registers as a Home
 * section (modules.js registerHomeSection), which feed.js draws without
 * knowing what they are.
 *
 *   widget   "Tonight on Gemini" in the right rail: your team's next game
 *            first when you picked one (teams.js), then the next few games
 *            with the favorite's chance, your side on a game you hold, and
 *            your picks so far
 *   feedTab  Markets, after Following · Latest. Two views on one switch:
 *              Games       the featured game, what people you follow took
 *                          (price then and now, or how it settled), then
 *                          each sport's featured game
 *              Your picks  a summary (record, net, net over time, last 10),
 *                          open picks (when, worth, P&L, pays if it wins,
 *                          paid → now), settled ones by day with Share on a
 *                          win; with nothing yet, tonight's games to start.
 *                          The list follows the filter, league and sort set
 *                          in the rail (or the phone switch above it)
 *            Its rail: on Games, the account card and positions (rail.js);
 *            on Your picks, the tools that manage the list (picks-rail.js).
 *            On phones the rail is replaced by one bar at the top, and Your
 *            picks gets Needs you and the switch above the list.
 *
 * Full per-sport lists stay on Games › Markets; this is the social view.
 * Which view is open, and whether every settled pick shows, live on the
 * tab's own element, not in this module, so a kept Home and a fresh one
 * never share them.
 */

import { agoText, avatar, clockText, dayHeading, esc, firstName, usd } from "../api.js";
import { bindTrade, gameMarketCard, priceButton, remember } from "./card.js";
import {
  centsText, chanceText, every, featured, featuredTeam, followingPicks, me, onChanged, pickHistory, pnlText, whenText,
} from "./client.js";
import { meter, openTotals, recordText, renderRail } from "./rail.js";
import { bindPicksTools, paintPicksRail, phoneTools, pickKey } from "./picks-rail.js";
import { ICON } from "../shared.js";

/** Rail rows in "Tonight on Gemini". */
const WIDGET_GAMES = 4;
/** "Tonight": live, or starting within this long. */
const SOON_MS = 24 * 3600_000;
/** Games offered when you have no picks yet. */
const EMPTY_GAMES = 2;
/** Settled picks shown before "Show more". */
const SETTLED_SHOWN = 5;
/** Results in the "Last 10" row. */
const FORM_N = 10;
/** Past this long after the start a game is over, though Gemini has not settled it yet. */
const GAME_OVER_MS = 5 * 3600_000;

/** Each sport's next games, taking turns between sports, live or starting soon. */
function soonest(sports, n) {
  const lists = sports.map((s) => [...(s.upcoming ?? [])]);
  const out = [];
  const limit = Date.now() + SOON_MS;
  while (out.length < n && lists.some((l) => l.length)) {
    for (const l of lists) {
      const e = l.shift();
      if (e && (!e.startsAt || Date.parse(e.startsAt) <= limit)) out.push(e);
      if (out.length >= n) break;
    }
  }
  return out;
}

function favoriteOf(e) {
  const priced = e.contracts.filter((c) => c.chance !== null);
  return priced.length ? priced.reduce((a, b) => (b.chance > a.chance ? b : a)) : null;
}

const pnlSpan = (v) => `<span class="${v > 0 ? "mk-up" : v < 0 ? "mk-down" : ""}">${esc(pnlText(v))}</span>`;
const sideText = (p) => (p.outcome === "no" ? `Not ${p.label}` : p.label);

// ── pure helpers over pickHistory() ───────────────────────────────────

const byNewest = (a, b) => Date.parse(b.settledAt) - Date.parse(a.settledAt);

/** Net over settled picks, oldest to newest, as a line from $0. */
export function netLine(picks, w = 560, h = 64) {
  const pts = [0];
  [...picks].sort((a, b) => -byNewest(a, b))
    .forEach((p) => pts.push(pts[pts.length - 1] + Number(p.payout) - Number(p.cost)));
  if (pts.length < 3) return "";
  const lo = Math.min(0, ...pts);
  const hi = Math.max(0, ...pts);
  const span = hi - lo || 1;
  const x = (i) => ((i / (pts.length - 1)) * (w - 8) + 4).toFixed(1);
  const y = (v) => (6 + (1 - (v - lo) / span) * (h - 12)).toFixed(1);
  const line = pts.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  const end = pts[pts.length - 1];
  return `
    <svg class="mk-sum-line ${end >= 0 ? "up" : "down"}" viewBox="0 0 ${w} ${h}" role="img"
         aria-label="${esc(`Net over your last ${pts.length - 1} settled picks, now ${pnlText(end)}`)}">
      <line class="mk-sum-zero" x1="4" x2="${w - 4}" y1="${y(0)}" y2="${y(0)}"/>
      <polygon class="mk-sum-area" points="${x(0)},${y(0)} ${line} ${x(pts.length - 1)},${y(0)}"/>
      <polyline class="mk-sum-stroke" points="${line}"/>
      <circle class="mk-sum-end" cx="${x(pts.length - 1)}" cy="${y(end)}" r="4"/>
    </svg>`;
}

/** The last n results Gemini settled, oldest on the left: won filled, lost a ring. Sold-out picks are not results. */
export function formDots(picks, n = FORM_N) {
  const last = picks.filter((p) => !p.soldOut).sort(byNewest).slice(0, n).reverse();
  if (!last.length) return "";
  const words = last.map((p) => (p.won ? "won" : "lost")).join(", ");
  return `
    <div class="mk-form">
      <span>Last ${last.length}</span>
      <span class="mk-form-dots" role="img" aria-label="${esc(`Last ${last.length}, oldest first: ${words}`)}">
        ${last.map((p) => `<span class="mk-form-dot${p.won ? "" : " lost"}"></span>`).join("")}
      </span>
    </div>`;
}

// ── rail widget: Tonight on Gemini ────────────────────────────────────

/** Your side on a game, from the positions on its ticker: "You: Celtics +$1.30". */
function youLine(held) {
  if (!held?.length) return "";
  const pnl = held.reduce((sum, p) => sum + (Number(p.pnl) || 0), 0);
  const what = held.length === 1 ? sideText(held[0]) : `${held.length} picks`;
  return `<span class="mk-you"><span class="mk-you-dot" aria-hidden="true"></span>You: ${esc(what)} ${pnlSpan(pnl)}</span>`;
}

export function renderTonight(body, section) {
  section.classList.add("mk-tonight");
  // Hidden until the first answer has games: no empty card while Gemini is slow.
  if (!body.children.length) section.hidden = true;
  bindTrade(section);
  const paint = async (fresh = false) => {
    let games = [];
    let account = null;
    let team = null;
    try {
      [games, team, account] = await Promise.all([
        featured({ fresh }).then((s) => soonest(s, WIDGET_GAMES)), featuredTeam().catch(() => null), me(),
      ]);
    } catch { games = []; }
    games = [...games].sort((x, y) => Date.parse(x.startsAt) - Date.parse(y.startsAt));
    if (team?.game) games = [team.game, ...games.filter((e) => e.ticker !== team.game.ticker)].slice(0, WIDGET_GAMES);
    // A Home the tab cache holds is painted too, so it is current when shown again.
    if (!games.length) { section.hidden = true; return; }
    section.hidden = false;
    const sum = account ? openTotals(account) : { count: 0, pnl: 0 };
    const held = new Map();
    for (const p of account?.positions ?? []) held.set(p.eventTicker, [...(held.get(p.eventTicker) ?? []), p]);
    body.innerHTML = games.map((e) => {
      remember(e);
      const fav = favoriteOf(e);
      const when = whenText(e.startsAt);
      const [a, b] = e.contracts;
      const mine = held.get(e.ticker);
      const ours = team?.game?.ticker === e.ticker;
      const bar = a && b && a.chance !== null && b.chance !== null
        ? `<span class="mk-bar mk-bar-thin" aria-hidden="true"><span class="mk-bar-a" style="flex:${a.chance}"></span><span class="mk-bar-b" style="flex:${b.chance}"></span></span>`
        : "";
      return `
        <button type="button" class="mk-tonight-row${ours ? " mk-tonight-team" : ""}" data-trade="${esc(fav?.symbol ?? a?.symbol ?? "")}" data-outcome="yes"
                aria-label="${esc(`${e.title}, ${when}${fav ? `, ${fav.label} ${chanceText(fav.chance)}` : ""}${mine ? `, you hold ${mine.length === 1 ? sideText(mine[0]) : `${mine.length} picks`}` : ""}`)}">
          <span class="mk-tonight-when${when === "Live" ? " mk-live" : ""}">${esc(when === "Live" ? "LIVE" : when.replace(/^(Today|Tonight) /, ""))}</span>
          <span class="mk-tonight-main">
            ${ours ? `<span class="mk-tonight-tag">Your team · ${esc(team.school)}</span>` : ""}
            <span class="mk-tonight-line">
              <strong>${esc(a?.short ?? "")} <span class="mk-vs">vs</span> ${esc(b?.short ?? "")}</strong>
              ${fav ? `<span class="${fav === a ? "mk-a-ink" : "mk-b-ink"}">${esc(chanceText(fav.chance))}</span>` : ""}
            </span>
            ${bar}
            ${youLine(mine)}
          </span>
        </button>`;
    }).join("") + `
      <div class="mk-tonight-foot">
        <a href="#/markets/picks">${sum.count ? `Your ${sum.count} pick${sum.count === 1 ? "" : "s"} ${pnlSpan(sum.pnl)}` : "Your picks"}</a>
        <a href="#/markets">All markets</a>
      </div>`;
  };
  void paint();
  every(body, 15_000, () => void paint(true));
  onChanged(body, () => void paint(true));
}

// ── the Markets feed tab ──────────────────────────────────────────────

const VIEWS = [["games", "Games"], ["picks", "Your picks"]];

/** The last Your picks answer per tab element, so "Show more" and the rail's controls redraw without a fetch. */
const LAST_PICKS = new WeakMap();
/** Each tab element's two rail boxes: Games (account + positions) and Your picks (picks-rail.js). */
const RAIL_BOXES = new WeakMap();

export function renderMarketsTab(el, rail, view = null) {
  if (!rail.querySelector(".mk-rail-games")) {
    const games = document.createElement("div");
    games.className = "mk-rail-games";
    const picks = document.createElement("div");
    picks.className = "mk-rail mk-rail-picks";
    rail.append(games, picks);
    renderRail("", games);
  }
  RAIL_BOXES.set(el, { games: rail.querySelector(".mk-rail-games"), picks: rail.querySelector(".mk-rail-picks") });

  if (!el.dataset.mkHome) {
    el.dataset.mkHome = "1";
    el.dataset.view = "games";
    el.innerHTML = `
      <div class="mk-home">
        <div class="mk-home-bar"></div>
        <div class="mk-home-views" role="tablist" aria-label="Markets">
          ${VIEWS.map(([id, label]) => `<button type="button" role="tab" data-mk-view="${id}">${label}</button>`).join("")}
        </div>
        <div class="mk-home-body"></div>
      </div>`;
    bindTrade(el);
    const redraw = () => { const last = LAST_PICKS.get(el); if (last) drawPicks(el, last); };
    const refresh = () => void paintPicks(el);
    // The list's rows and the phone tools here; the rail's controls in its own box.
    const picksBox = RAIL_BOXES.get(el).picks;
    bindPicksTools(el, el, picksBox, { redraw, refresh });
    bindPicksTools(picksBox, el, picksBox, { redraw, refresh });
    el.addEventListener("click", (e) => {
      const b = e.target.closest("[data-mk-view]");
      if (b) { showView(el, b.dataset.mkView); return; }
      if (e.target.closest("[data-mk-more]")) {
        el.dataset.settledAll = "1";
        redraw();
      }
    });
    every(el, 15_000, () => { if (!el.hidden && el.dataset.view === "games") void paintGames(el, true); });
    onChanged(el, () => { if (!el.hidden) showView(el, el.dataset.view); });
  }
  showView(el, view ?? el.dataset.view ?? "games");
}

function showView(el, view) {
  el.dataset.view = view === "picks" ? "picks" : "games";
  const boxes = RAIL_BOXES.get(el);
  if (boxes) {
    boxes.games.hidden = el.dataset.view === "picks";
    boxes.picks.hidden = el.dataset.view !== "picks";
  }
  el.querySelectorAll("[data-mk-view]").forEach((b) => {
    const on = b.dataset.mkView === el.dataset.view;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", String(on));
  });
  void paintBar(el);
  if (el.dataset.view === "picks") void paintPicks(el);
  else void paintGames(el);
}

/** Phones: the rail is gone, so the account comes back as one bar of three cells, a link to Your picks. */
async function paintBar(el) {
  const [a, history] = await Promise.all([me(), pickHistory().catch(() => null)]);
  const bar = el.querySelector(".mk-home-bar");
  if (!bar) return;
  if (!a.allowed || !a.enabled || !a.connected) { bar.innerHTML = ""; return; }
  const sum = openTotals(a);
  const record = recordText(history?.record ?? null);
  bar.innerHTML = `
    <a class="mk-hb2" href="#/markets/picks"
       aria-label="${esc(`Your picks: ${usd(a.usdAvailable)} available, ${sum.count ? `${sum.count} open, ${pnlText(sum.pnl)}` : "none open"}, record ${record}`)}">
      <span class="mk-hb2-cell"><span class="mk-hb2-k">Available</span><span class="mk-hb2-v">${esc(usd(a.usdAvailable))}</span></span>
      <span class="mk-hb2-cell">
        <span class="mk-hb2-k">${sum.count ? `${sum.count} open` : "Open"}</span>
        <span class="mk-hb2-v">${sum.count ? pnlSpan(sum.pnl) : "—"}</span>
      </span>
      <span class="mk-hb2-cell"><span class="mk-hb2-k">Record</span><span class="mk-hb2-v">${esc(record)}</span></span>
      <span class="mk-chev" aria-hidden="true">›</span>
    </a>`;
}

const skel = `<div class="mk-card mk-skel"><div class="skel skel-line" style="width:40%"></div><div class="skel skel-line" style="width:70%"></div></div>`;

async function paintGames(el, fresh = false) {
  const body = el.querySelector(".mk-home-body");
  if (!body.querySelector(".mk-home-games")) body.innerHTML = skel.repeat(2);
  let sports = null;
  let picks = [];
  let error = null;
  try {
    [sports, picks] = await Promise.all([featured({ fresh }), followingPicks().catch(() => [])]);
  } catch (err) {
    error = err.message;
  }
  // Painted even while the tab cache holds Home out of the document; only a changed view drops it.
  if (el.dataset.view !== "games") return;
  if (error) { body.innerHTML = `<div class="empty">${esc(error)}</div>`; return; }
  if (!sports.length) { body.innerHTML = `<div class="empty">No markets open on Gemini right now.</div>`; return; }

  // The closest pro game across sports leads; each other sport's featured game follows.
  const [lead, ...rest] = sports.map((s) => s.headline).filter(Boolean);
  body.innerHTML = `
    <div class="mk-home-games">
      ${lead ? gameMarketCard(lead, { headline: true }) : ""}
      <section class="mk-home-section" aria-label="From people you follow">
        <h3 class="mk-home-h">From people you follow</h3>
        ${picks.length
          ? picks.map(friendPick).join("")
          : `<p class="empty-inline">Nobody you follow has posted a pick in the last few days.</p>`}
      </section>
      ${rest.length ? `<h3 class="mk-home-h">Featured in each sport</h3>${rest.map((e) => gameMarketCard(e)).join("")}` : ""}
      <a class="mk-home-more" href="#/sport/?view=markets">Every game, by sport, on Games › Markets</a>
      <p class="mk-disclaimer">Markets are listed and settled by Gemini. Prices update every 15 seconds.</p>
    </div>`;
}

/** A friend's pick: the price they took and the price now, then Same side; once settled, how it did. */
function friendPick(p) {
  const m = p.market;
  const first = firstName(p.author.name);
  const side = m.outcome === "no" ? `not ${m.label}` : m.label;
  const then = Number(m.price);
  const now = p.priceNow === null ? null : Number(p.priceNow);
  const move = p.result
    ? "final"
    : now === null
      ? ""
      : `<span class="${now > then ? "mk-up" : now < then ? "mk-down" : ""}">now ${esc(centsText(p.priceNow))}</span>`;
  const took = m.price ? `Took at ${esc(centsText(m.price))}` : "";
  const end = p.result
    ? `<span class="mk-result mk-result-${p.result}">${p.result === "won" ? "Won" : "Lost"}</span>`
    : `<button type="button" class="mk-fr-btn" data-trade="${esc(m.symbol)}" data-outcome="${esc(m.outcome)}"
              ${now === null ? "disabled" : ""} aria-label="${esc(`Take ${side} too${now === null ? "" : `, ${centsText(p.priceNow)}`}`)}">
        Same side<strong>${esc(centsText(p.priceNow))}</strong>
      </button>`;
  return `
    <div class="mk-fr">
      ${avatar(p.author, "sm")}
      <span class="mk-friend-main">
        <span><strong>${esc(first)}</strong> took <strong>${esc(side)}</strong></span>
        <span class="mk-friend-sub">${esc(m.title)} · ${esc(m.league)} · ${esc(agoText(p.createdAt))}</span>
        ${took || move ? `<span class="mk-fr-move">${[took, move].filter(Boolean).join(" · ")}</span>` : ""}
      </span>
      ${end}
    </div>`;
}

// ── Your picks ────────────────────────────────────────────────────────

async function paintPicks(el) {
  const body = el.querySelector(".mk-home-body");
  if (!body.querySelector(".mk-picks")) body.innerHTML = skel.repeat(2);
  let a = null;
  let history = null;
  let sports = [];
  let error = null;
  try {
    [a, history] = await Promise.all([me({ fresh: true }), pickHistory()]);
    // Nothing yet: tonight's games, so the first pick is one tap away.
    if (!(a?.positions ?? []).length && !(history?.picks ?? []).length) sports = await featured().catch(() => []);
  } catch (err) {
    error = err.message;
  }
  if (el.dataset.view !== "picks") return;
  if (error) { body.innerHTML = `<div class="empty">${esc(error)}</div>`; return; }
  const data = { a, history, sports };
  LAST_PICKS.set(el, data);
  drawPicks(el, data, { refetch: true });
}

const SORT_WORD = { start: "by start", pnl: "by P&L", size: "by size", new: "newest first" };
const netOf = (p) => (Number(p.payout) || 0) - (Number(p.cost) || 0);

/** The open picks the filter, league and sort show. */
function openShown(open, { league, sort }) {
  const list = open.filter((p) => !league || (p.league || "Other") === league);
  const at = (p) => (p.startsAt ? Date.parse(p.startsAt) : Infinity);
  if (sort === "start") return [...list].sort((x, y) => at(x) - at(y));
  if (sort === "pnl") return [...list].sort((x, y) => (Number(y.pnl) || 0) - (Number(x.pnl) || 0));
  if (sort === "size") return [...list].sort((x, y) => (Number(y.cost) || 0) - (Number(x.cost) || 0));
  return list;
}

/** The settled picks the league and sort show; newest first unless sorted by P&L or size. */
function settledShown(settled, { league, sort }) {
  const list = settled.filter((p) => !league || (p.league || "Other") === league);
  if (sort === "pnl") return [...list].sort((x, y) => netOf(y) - netOf(x));
  if (sort === "size") return [...list].sort((x, y) => (Number(y.cost) || 0) - (Number(x.cost) || 0));
  return [...list].sort(byNewest);
}

function drawPicks(el, data, { refetch = false } = {}) {
  const { a, history, sports } = data;
  const body = el.querySelector(".mk-home-body");
  if (!body || el.dataset.view !== "picks") return;
  const boxes = RAIL_BOXES.get(el);
  const open = a?.positions ?? [];
  const settled = [...(history?.picks ?? [])].sort(byNewest);
  if (boxes) paintPicksRail(el, boxes.picks, data, { refetch });
  if (!open.length && !settled.length) {
    body.innerHTML = `<div class="mk-picks">${emptyPicks(soonest(sports, EMPTY_GAMES))}</div>`;
    return;
  }
  const filter = el.dataset.picksFilter || "all";
  const opts = { league: el.dataset.picksLeague || "", sort: el.dataset.picksSort || "start" };
  const railOn = Boolean(boxes?.picks.offsetParent);
  const sel = railOn ? el.dataset.picksSel || "" : "";
  const openList = filter === "settled" ? [] : openShown(open, opts);
  const settledList = filter === "open" ? [] : settledShown(settled, opts);
  const byDate = opts.sort === "start" || opts.sort === "new";
  const all = el.dataset.settledAll === "1";
  const shown = all ? settledList : settledList.slice(0, SETTLED_SHOWN);
  const pnl = openList.reduce((sum, p) => sum + (Number(p.pnl) || 0), 0);
  const scope = opts.league ? ` · ${esc(opts.league)}` : "";
  const of = (n, total) => (n === total ? `${n}` : `${n} of ${total}`);
  body.innerHTML = `
    <div class="mk-picks">
      ${phoneTools(el, data)}
      ${settled.length ? summary(a, history, settled) : ""}
      ${filter === "settled" ? "" : `
        <section class="mk-home-section" aria-label="Open picks">
          <div class="mk-sec-head">
            <h3 class="mk-home-h">Open${scope}</h3>
            ${openList.length ? `<span class="mk-sec-note">${of(openList.length, open.length)} · ${SORT_WORD[opts.sort] ?? ""} · ${pnlSpan(pnl)}</span>` : ""}
          </div>
          ${openList.length
            ? openList.map((p) => openPick(p, pickKey(p) === sel)).join("")
            : open.length
              ? `<p class="empty-inline">No open picks in ${esc(opts.league)}. <button type="button" class="mk-link" data-mk-league="">Show every league</button></p>`
              : `<p class="empty-inline">No open picks. <a href="#/markets">Pick a side on tonight's games</a>.</p>`}
        </section>`}
      ${filter === "open" || !settled.length ? "" : `
        <section class="mk-home-section" aria-label="Settled picks">
          <div class="mk-sec-head">
            <h3 class="mk-home-h">Settled${scope}</h3>
            <span class="mk-sec-note">${of(settledList.length, settled.length)}${byDate ? "" : ` · ${SORT_WORD[opts.sort]}`}</span>
          </div>
          ${!settledList.length
            ? `<p class="empty-inline">Nothing settled in ${esc(opts.league)}. <button type="button" class="mk-link" data-mk-league="">Show every league</button></p>`
            : byDate ? byDay(shown) : shown.map((p) => settledPick(p, false, { withDay: true })).join("")}
          ${settledList.length > shown.length
            ? `<button type="button" class="btn-game btn-game-ghost mk-show-more" data-mk-more>Show ${settledList.length - shown.length} more</button>`
            : ""}
        </section>`}
      <p class="mk-disclaimer">Only you see this list. A pick you share shows the side, never the size.</p>
    </div>`;
}

/** Record, net, the line of net over time, four numbers, and the last 10. */
function summary(a, history, settled) {
  const r = history.record ?? { won: 0, lost: 0, net: "0" };
  const net = Number(r.net) || 0;
  const staked = settled.reduce((sum, p) => sum + (Number(p.cost) || 0), 0);
  const games = r.won + r.lost;
  const t = a ? openTotals(a) : { inPlay: 0 };
  const paysIfAllWin = (a?.positions ?? []).reduce((sum, p) => sum + (Number(p.qty) || 0), 0);
  const ret = staked > 0 ? (net / staked) * 100 : null;
  return `
    <section class="mk-sum" aria-label="Your record">
      <div class="mk-sum-top">
        <div class="mk-sum-fig"><span class="mk-sum-num">${esc(recordText(r))}</span><span class="mk-sum-lbl">Record</span></div>
        <div class="mk-sum-fig"><span class="mk-sum-num ${net > 0 ? "mk-up" : net < 0 ? "mk-down" : ""}">${esc(pnlText(net))}</span><span class="mk-sum-lbl">Net settled</span></div>
      </div>
      ${netLine(settled)}
      <dl class="mk-stats mk-stats-4">
        <div><dt>Win rate</dt><dd>${games ? `${Math.round((r.won / games) * 100)}%` : "—"}</dd></div>
        <div><dt>Return</dt><dd class="${ret > 0 ? "mk-up" : ret < 0 ? "mk-down" : ""}">${ret === null ? "—" : `${ret >= 0 ? "+" : "−"}${Math.abs(ret).toFixed(1)}%`}</dd></div>
        <div><dt>In play</dt><dd>${esc(usd(t.inPlay))}</dd></div>
        <div><dt>Pays if all win</dt><dd>${esc(usd(paysIfAllWin))}</dd></div>
      </dl>
      ${formDots(settled)}
    </section>`;
}

/** When the game is: LIVE with a pulse, a start time, or over and waiting on Gemini. */
function whenTag(startsAt) {
  if (!startsAt) return "";
  const start = Date.parse(startsAt);
  if (Date.now() - start > GAME_OVER_MS) return `<span class="mk-op-when">Awaiting result</span>`;
  const when = whenText(startsAt);
  if (when === "Live") return `<span class="mk-op-when mk-live"><span class="mk-live-dot" aria-hidden="true"></span>LIVE</span>`;
  return `<span class="mk-op-when">${esc(when)}</span>`;
}

/** One open pick. Tapping it selects it for the rail, or opens the trade sheet where there is no rail (picks-rail.js). */
function openPick(p, selected = false) {
  const no = p.outcome === "no";
  const side = sideText(p);
  const pnl = p.pnl === null ? null : Number(p.pnl);
  const worth = usd(p.value === null ? p.cost : p.value);
  const pays = usd(Number(p.qty) || 0);
  const when = whenText(p.startsAt);
  const game = [p.title, p.league, `${p.qty} at ${centsText(p.avgPrice)}`].filter(Boolean).join(" · ");
  return `
    <button type="button" class="mk-op${selected ? " is-sel" : ""}" data-mk-pick="${esc(p.symbol)}" data-outcome="${esc(p.outcome)}" aria-pressed="${selected}"
            aria-label="${esc(`${side}, ${no ? "no" : "yes"}${when ? `, ${when}` : ""}, worth ${worth}${pnl === null ? "" : `, ${pnlText(pnl)}`}, pays ${pays} if it wins`)}">
      <span class="mk-op-head">
        <span class="mk-side-chip${no ? " mk-side-no" : ""}">${no ? "NO" : "YES"}</span>
        <strong class="mk-op-side">${esc(side)}</strong>
        ${whenTag(p.startsAt)}
      </span>
      <span class="mk-op-game">${esc(game)}</span>
      <span class="mk-op-nums">
        <span><span class="mk-op-k">${p.value === null ? "Paid" : "Worth"}</span><strong>${esc(worth)}</strong></span>
        <span><span class="mk-op-k">P&amp;L</span><strong>${pnl === null ? "—" : pnlSpan(pnl)}</strong></span>
        <span><span class="mk-op-k">Pays if it wins</span><strong>${esc(pays)}</strong></span>
      </span>
      ${meter(p, { delta: true })}
    </button>`;
}

/** Settled picks (newest first) under day headings. */
function byDay(picks) {
  let day = null;
  return picks.map((p) => {
    const d = dayHeading(p.settledAt);
    const head = d === day ? "" : `<h4 class="mk-day">${esc(d)}</h4>`;
    day = d;
    return head + settledPick(p, d === "Today");
  }).join("");
}

/** A pick you sold out of: an arrow out, neither won nor lost. */
const SOLD_MARK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7M9 7h8v8"/></svg>`;

function settledPick(p, today, { withDay = false } = {}) {
  const side = sideText(p);
  const net = netOf(p);
  const at = !p.settledAt ? ""
    : today ? agoText(p.settledAt)
    : withDay ? `${dayHeading(p.settledAt)} ${clockText(p.settledAt)}`
    : clockText(p.settledAt);
  const share = p.won && !p.soldOut
    ? `<button type="button" class="mk-icon-btn" data-mk-share="${esc(p.symbol)}" data-outcome="${esc(p.outcome)}"
              data-title="${esc(p.title)}" data-side="${esc(side)}" aria-label="${esc(`Share your ${side} pick`)}" title="Share">${ICON.share}</button>`
    : `<span class="mk-st-gap" aria-hidden="true"></span>`;
  return `
    <div class="mk-st ${p.soldOut ? "mk-st-sold" : p.won ? "mk-st-won" : "mk-st-lost"}">
      <span class="mk-st-mark" role="img" aria-label="${p.soldOut ? "Sold" : p.won ? "Won" : "Lost"}">${p.soldOut ? SOLD_MARK : p.won ? ICON.check : ICON.close}</span>
      <span class="mk-pick-main"><strong>${esc(side)}</strong><span class="mk-pick-sub">${esc([p.title, p.soldOut ? "you sold it" : p.sold ? "part sold" : "", at].filter(Boolean).join(" · "))}</span></span>
      <span class="mk-st-money"><strong>${pnlSpan(net)}</strong><span>${esc(usd(p.cost))} → ${esc(usd(p.payout))}</span></span>
      ${share}
    </div>`;
}

/** No picks at all: what this view will hold, and the next games to start with. */
function emptyPicks(games) {
  const rows = games.map((e) => {
    remember(e);
    const when = whenText(e.startsAt);
    return `
      <div class="mk-empty-game">
        <span class="mk-empty-game-t"><span>${esc(e.title)} · ${esc(e.league)}</span><span class="${when === "Live" ? "mk-live" : ""}">${esc(when === "Live" ? "LIVE" : when)}</span></span>
        <div class="mk-prices">${e.contracts.slice(0, 2).map((c, i) => priceButton(c, i)).join("")}</div>
      </div>`;
  }).join("");
  return `
    <section class="mk-empty" aria-label="No picks yet">
      <span class="mk-empty-ic" aria-hidden="true">${ICON.trendUp}</span>
      <h3 class="mk-empty-h">Make your first pick</h3>
      <p class="mk-empty-p">Pick a side on a pro or college game. Your picks, what they're worth, and your record show up here.</p>
      ${rows ? `<div class="mk-empty-games">${rows}</div>` : ""}
      <a class="btn-game btn-game-ghost" href="#/markets">See every game</a>
    </section>`;
}
