/**
 * The rail beside Home › Markets › Your picks. The center list (home.js) is
 * where every pick and its history lives; the rail manages it:
 *
 *   Needs you      picks settled since you last looked (Share a win), games
 *                  you hold starting within the hour (Trade), and picks that
 *                  moved 10¢ or more since you made them (Review selects it)
 *   Portfolio      what the account is worth, its change over 1D / 1W / 1M /
 *                  All (GET /api/markets/portfolio), available, in play, P&L
 *   Show           Open · Settled · All, a league, and the sort: they filter
 *                  the center list, whose section heads say what is applied
 *   Selected pick  the pick clicked in the list: its numbers, Add more (the
 *                  trade sheet) and Sell (all or half, at the bid, confirmed);
 *                  on phones the same card opens in a sheet (openPickSheet)
 *   Where your money is   what is in play by league; if all win, if all lose
 *   Activity       buys, sales and settlements (GET /api/markets/activity)
 *
 * Phones have no rail: phoneTools() puts Needs you (as chips) and the
 * Open · Settled · All switch above the list instead, and tapping a pick
 * opens the trade sheet as before.
 *
 * What the list shows (filter, league, sort, the selected pick) is page
 * state on the tab's element (dataset), shared with home.js. The rail's own
 * state (range, the series, activity, a sale waiting for its confirm) is
 * kept per tab element in RAIL.
 */

import { agoText, esc, usd } from "../api.js";
import { openComposeSheet } from "../compose.js";
import { ICON, openSheet, toast } from "../shared.js";
import { bindTrade } from "./card.js";
import { activityList, centsText, disconnect, forgetMe, markSeen, pnlText, portfolioSeries, sell, whenText } from "./client.js";
import { meter, openTotals } from "./rail.js";

/** Rows the Activity card shows; the rest are in its sheet. */
const ACTIVITY_SHOWN = 5;
/** "Starts soon": within this long. */
const SOON_MS = 60 * 60_000;
/** A move worth a look, in cents since the pick. */
const BIG_MOVE = 10;
/** Without a "seen" mark yet, settled picks this recent count as new. */
const NEW_WINDOW_MS = 24 * 3600_000;
/** Settled rows "Needs you" lists at most; the rest are under Settled. */
const NEW_SETTLED_MAX = 3;
const RANGES = [["1d", "1D"], ["1w", "1W"], ["1m", "1M"], ["all", "All"]];
const RANGE_WORD = { "1d": "past day", "1w": "past week", "1m": "past month", all: "all time" };

const RAIL = new WeakMap();
const railState = (el) => {
  if (!RAIL.has(el)) RAIL.set(el, { range: "1w", points: null, activity: null, confirm: null });
  return RAIL.get(el);
};

export const pickKey = (p) => `${p.symbol}|${p.outcome}`;
const sideText = (p) => (p.outcome === "no" ? `Not ${p.label}` : p.label);
const signed = (v) => `<span class="${v > 0 ? "mk-up" : v < 0 ? "mk-down" : ""}">${esc(pnlText(v))}</span>`;

// ── pure helpers ──────────────────────────────────────────────────────

/** What the account is worth: available plus open positions at value (cost when unpriced). */
export function accountValue(a) {
  if (!a?.connected || a.usdAvailable === null || a.usdAvailable === undefined) return null;
  return (a.positions ?? []).reduce((sum, p) => sum + (Number(p.value ?? p.cost) || 0), Number(a.usdAvailable) || 0);
}

/** "Needs you": settled since `seenAt`, starting within the hour, and big moves, in that order. */
export function needsYou(a, history, now = Date.now()) {
  const since = history?.seenAt ? Date.parse(history.seenAt) : now - NEW_WINDOW_MS;
  // A pick you sold out of is your own doing: nothing to tell you.
  const settled = (history?.picks ?? [])
    .filter((p) => !p.soldOut && Date.parse(p.settledAt) > since)
    .sort((x, y) => Date.parse(y.settledAt) - Date.parse(x.settledAt))
    .slice(0, NEW_SETTLED_MAX)
    .map((p) => ({ kind: p.won ? "won" : "lost", pick: p, net: (Number(p.payout) || 0) - (Number(p.cost) || 0) }));
  const open = a?.positions ?? [];
  const soon = open
    .filter((p) => p.startsAt && Date.parse(p.startsAt) > now && Date.parse(p.startsAt) - now <= SOON_MS)
    .map((p) => ({ kind: "soon", pick: p, mins: Math.max(1, Math.round((Date.parse(p.startsAt) - now) / 60_000)) }));
  const moves = open
    .map((p) => ({ p, d: p.chanceNow === null || p.chanceNow === undefined ? 0 : p.chanceNow - Math.round(Number(p.avgPrice) * 100) }))
    .filter(({ d }) => Math.abs(d) >= BIG_MOVE)
    .map(({ p, d }) => ({ kind: "move", pick: p, d }));
  return [...settled, ...soon, ...moves];
}

/** In play by league, biggest first: the top three, the rest as "Other". */
export function exposure(positions) {
  const by = new Map();
  for (const p of positions) {
    const k = p.league || "Other";
    const g = by.get(k) ?? { league: k, value: 0, count: 0 };
    g.value += Number(p.value ?? p.cost) || 0;
    g.count += 1;
    by.set(k, g);
  }
  const list = [...by.values()].sort((x, y) => y.value - x.value);
  if (list.length <= 3) return list;
  const rest = list.slice(2).reduce((o, g) => ({ league: "Other", value: o.value + g.value, count: o.count + g.count }), { league: "Other", value: 0, count: 0 });
  return [...list.slice(0, 2), rest];
}

// ── the cards ─────────────────────────────────────────────────────────

const IC = {
  won: ICON.check,
  lost: ICON.close,
  soon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`,
  move: ICON.trendUp,
};

function needRow(n, { chip = false } = {}) {
  const p = n.pick;
  const side = sideText(p);
  let title;
  let sub;
  let action;
  if (n.kind === "won" || n.kind === "lost") {
    title = `${side} ${n.kind === "won" ? "won" : "lost"}`;
    sub = `${signed(n.net)} · ${p.sold ? "sold" : "settled"} ${esc(agoText(p.settledAt))}`;
    action = n.kind === "won"
      ? `<button type="button" class="mk-att-go" data-mk-share="${esc(p.symbol)}" data-outcome="${esc(p.outcome)}" data-title="${esc(p.title)}" data-side="${esc(side)}">Share</button>`
      : `<button type="button" class="mk-att-go" data-mk-filter="settled">View</button>`;
  } else if (n.kind === "soon") {
    title = `${side} starts in ${n.mins} min`;
    sub = `${p.outcome === "no" ? "NO" : "YES"} · worth ${esc(usd(p.value ?? p.cost))} · pays ${esc(usd(Number(p.qty) || 0))}`;
    action = `<button type="button" class="mk-att-go" data-trade="${esc(p.symbol)}" data-outcome="${esc(p.outcome)}">Trade</button>`;
  } else {
    title = `${side} ${n.d > 0 ? "+" : "−"}${Math.abs(n.d)}¢ since your pick`;
    sub = `Paid ${esc(centsText(p.avgPrice))} · now ${p.chanceNow}¢`;
    action = `<button type="button" class="mk-att-go" data-mk-pick="${esc(p.symbol)}" data-outcome="${esc(p.outcome)}">Review</button>`;
  }
  const cls = n.kind === "lost" ? "mk-att-lost" : n.kind === "won" ? "mk-att-won" : n.kind === "soon" ? "mk-att-soon" : "mk-att-move";
  if (chip) {
    // On phones the whole chip is the action.
    const attrs = action.match(/ (data-[^>]*)>/)?.[1] ?? "";
    const label = n.kind === "soon" ? `${side} in ${n.mins} min` : n.kind === "move" ? `${side} ${n.d > 0 ? "+" : "−"}${Math.abs(n.d)}¢` : title;
    return `<button type="button" class="mk-att-chip ${cls}" ${attrs}><span class="mk-att-ic" aria-hidden="true">${IC[n.kind]}</span>${esc(label)}${
      n.kind === "won" || n.kind === "lost" ? ` ${signed(n.net)}` : ""}</button>`;
  }
  return `
    <div class="mk-att-row ${cls}">
      <span class="mk-att-ic" aria-hidden="true">${IC[n.kind]}</span>
      <span class="mk-att-main"><strong>${esc(title)}</strong><span class="mk-att-sub">${sub}</span></span>
      ${action}
    </div>`;
}

function needsCard(list) {
  if (!list.length) return "";
  const anySettled = list.some((n) => n.kind === "won" || n.kind === "lost");
  return `
    <section class="widget" aria-label="Needs you">
      <div class="mk-rail-head"><h4 class="widget-title">Needs you</h4><span class="mk-count">${list.length}</span></div>
      <div class="mk-att">${list.map((n) => needRow(n)).join("")}</div>
      ${anySettled ? `<button type="button" class="mk-att-clear" data-mk-seen>Mark settled as seen</button>` : ""}
    </section>`;
}

/** The value line: the range's points, then now. */
function valueLine(points, now) {
  const vals = [...(points ?? []).map((p) => Number(p.value)), now];
  if (vals.length < 2) return "";
  const w = 288;
  const h = 60;
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const span = hi - lo || 1;
  const x = (i) => ((i / (vals.length - 1)) * (w - 8) + 4).toFixed(1);
  const y = (v) => (6 + (1 - (v - lo) / span) * (h - 12)).toFixed(1);
  const line = vals.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  const up = vals[vals.length - 1] >= vals[0];
  return `
    <svg class="mk-pf-line${up ? "" : " down"}" viewBox="0 0 ${w} ${h}" role="img"
         aria-label="${esc(`Value from ${usd(vals[0])} to ${usd(now)}`)}">
      <polygon class="area" points="${x(0)},${h - 2} ${line} ${x(vals.length - 1)},${h - 2}"/>
      <polyline class="stroke" points="${line}"/>
      <circle class="end" cx="${x(vals.length - 1)}" cy="${y(now)}" r="4"/>
    </svg>`;
}

function portfolioCard(a, st) {
  const value = accountValue(a);
  if (value === null) return "";
  const t = openTotals(a);
  const first = st.points?.length ? Number(st.points[0].value) : null;
  const change = first === null ? null : value - first;
  const pct = first ? (change / first) * 100 : null;
  const linked = a.trading === "oauth";
  return `
    <section class="widget mk-pf" aria-label="Portfolio">
      <div class="mk-rail-head">
        <h4 class="widget-title">Portfolio</h4>
        ${a.practice ? `<span class="mk-count">Practice</span>` : linked ? `<span class="mk-badge mk-badge-on">Connected</span>` : ""}
      </div>
      <div class="mk-pf-value">${esc(usd(value))}</div>
      <div class="mk-pf-change ${change > 0 ? "mk-up" : change < 0 ? "mk-down" : ""}">${change === null
        ? `<span>No history yet. It builds as you check in.</span>`
        : `${esc(pnlText(change))}${pct === null ? "" : ` (${pct >= 0 ? "+" : "−"}${Math.abs(pct).toFixed(1)}%)`} <span>${RANGE_WORD[st.range]}</span>`}</div>
      ${st.points === null ? `<div class="mk-pf-line skel" style="height:60px"></div>` : valueLine(st.points, value)}
      <div class="mk-range" role="group" aria-label="Range">
        ${RANGES.map(([id, label]) => `<button type="button" data-mk-range="${id}" aria-pressed="${st.range === id}">${label}</button>`).join("")}
      </div>
      <dl class="mk-stats">
        <div><dt>Available</dt><dd>${esc(usd(a.usdAvailable))}</dd></div>
        <div><dt>In play</dt><dd>${esc(usd(t.inPlay))}</dd></div>
        <div><dt>Open P&amp;L</dt><dd class="${t.pnl > 0 ? "mk-up" : t.pnl < 0 ? "mk-down" : ""}">${esc(pnlText(t.pnl))}</dd></div>
      </dl>
      ${a.siteUrl || linked ? `
        <div class="mk-pf-actions">
          ${a.siteUrl ? `<a class="btn-game btn-game-ghost" href="${esc(a.siteUrl)}" target="_blank" rel="noopener">Add money on Gemini</a>` : ""}
          ${linked ? `<button type="button" class="mk-icon-btn" data-mk-disconnect aria-label="Disconnect Gemini" title="Disconnect Gemini">${ICON.unlink}</button>` : ""}
        </div>` : ""}
      ${a.practice ? `<p class="mk-account-note">${ICON.info}Practice money at live Gemini prices</p>` : ""}
    </section>`;
}

/** The leagues in the picks the current filter covers, with counts. */
function leagueCounts(open, settled, filter) {
  const scope = filter === "open" ? open : filter === "settled" ? settled : [...open, ...settled];
  const by = new Map();
  for (const p of scope) by.set(p.league || "Other", (by.get(p.league || "Other") ?? 0) + 1);
  return { total: scope.length, list: [...by.entries()].sort((x, y) => y[1] - x[1]) };
}

function controlsCard(el, open, settled) {
  const f = el.dataset.picksFilter || "all";
  const lg = el.dataset.picksLeague || "";
  const sort = el.dataset.picksSort || "start";
  const leagues = leagueCounts(open, settled, f);
  return `
    <section class="widget mk-ctl" aria-label="Show">
      <h4 class="widget-title">Show</h4>
      ${filterSwitch(f, open.length, settled.length)}
      ${leagues.list.length > 1 ? `
        <span class="mk-ctl-label">League</span>
        <div class="mk-chips">
          <button type="button" class="mk-chip" data-mk-league="" aria-pressed="${!lg}">All<b>${leagues.total}</b></button>
          ${leagues.list.map(([name, n]) => `<button type="button" class="mk-chip" data-mk-league="${esc(name)}" aria-pressed="${lg === name}">${esc(name)}<b>${n}</b></button>`).join("")}
        </div>` : ""}
      <label class="mk-sort">Sort by
        <select data-mk-sort aria-label="Sort picks">
          ${[["start", "Starts soonest"], ["pnl", "P&L, best first"], ["size", "Size, largest first"], ["new", "Newest"]]
            .map(([v, t]) => `<option value="${v}"${v === sort ? " selected" : ""}>${esc(t)}</option>`).join("")}
        </select>
      </label>
    </section>`;
}

/** Open · Settled · All, as the rail's switch and the phone's. */
export function filterSwitch(f, nOpen, nSettled) {
  const opt = [["open", `Open ${nOpen}`], ["settled", `Settled ${nSettled}`], ["all", "All"]];
  return `<div class="mk-seg" role="group" aria-label="Which picks">
    ${opt.map(([v, t]) => `<button type="button" data-mk-filter="${v}" aria-pressed="${f === v}">${esc(t)}</button>`).join("")}
  </div>`;
}

function selectedCard(el, open, st) {
  const key = el.dataset.picksSel;
  const p = key ? open.find((x) => pickKey(x) === key) : null;
  if (!p) {
    return open.length
      ? `<section class="widget mk-sel-empty" aria-label="Selected pick"><p class="empty-inline">Select an open pick in the list to manage it here.</p></section>`
      : "";
  }
  const no = p.outcome === "no";
  const pnl = p.pnl === null ? null : Number(p.pnl);
  const cost = Number(p.cost) || 0;
  const pct = pnl !== null && cost ? (pnl / cost) * 100 : null;
  const when = whenText(p.startsAt);
  const worth = Number(p.value ?? NaN);
  const confirming = st.confirm === key;
  const half = st.part === "half";
  const qtyNum = Number(p.qty) || 0;
  return `
    <section class="widget" aria-label="Selected pick">
      <div class="mk-sel-top">
        <span class="mk-side-chip${no ? " mk-side-no" : ""}">${no ? "NO" : "YES"}</span><strong>${esc(sideText(p))}</strong>
        ${when ? `<span class="mk-sel-when${when === "Live" ? " mk-live" : ""}">${esc(when === "Live" ? "LIVE" : when)}</span>` : ""}
        <button type="button" class="mk-sel-x" data-mk-unselect aria-label="Close">${ICON.close}</button>
      </div>
      <div class="mk-sel-game">${esc([p.title, p.league].filter(Boolean).join(" · "))}</div>
      <dl class="mk-sel-grid">
        <div><dt>Contracts</dt><dd>${esc(p.qty)}</dd></div>
        <div><dt>Avg price</dt><dd>${esc(centsText(p.avgPrice))}</dd></div>
        <div><dt>Worth now</dt><dd>${esc(usd(p.value ?? p.cost))}</dd></div>
        <div><dt>P&amp;L</dt><dd class="${pnl > 0 ? "mk-up" : pnl < 0 ? "mk-down" : ""}">${pnl === null ? "—" : `${esc(pnlText(pnl))}${pct === null ? "" : ` (${pct >= 0 ? "+" : "−"}${Math.abs(pct).toFixed(0)}%)`}`}</dd></div>
      </dl>
      ${meter(p, { delta: true })}
      ${confirming ? `
        <div class="mk-sel-confirm" role="alert">
          <p>${half
            ? `Sell half (about ${esc(String(Math.floor(qtyNum * 50) / 100))}) at the bid now, for about <strong>${esc(usd(worth / 2))}</strong>? You keep the rest.`
            : `Sell all ${esc(p.qty)} at the bid now, for about <strong>${esc(usd(worth))}</strong>? ${pnl === null ? "" : `That locks in ${signed(pnl)}.`}`}</p>
          <div class="mk-sel-actions">
            <button type="button" class="btn-game btn-game-ghost" data-mk-sell-cancel>Keep it</button>
            <button type="button" class="btn-game btn-game-bad" data-mk-sell-go="${esc(key)}" data-part="${half ? "half" : "all"}">Sell now</button>
          </div>
        </div>` : `
        <div class="mk-sel-actions">
          <button type="button" class="btn-game btn-game-ghost" data-trade="${esc(p.symbol)}" data-outcome="${esc(p.outcome)}">Add more</button>
          <button type="button" class="btn-game" data-mk-sell="${esc(key)}" ${Number.isFinite(worth) ? "" : "disabled"}>${Number.isFinite(worth) ? `Sell · ${esc(usd(worth))}` : "No bid now"}</button>
        </div>
        <p class="mk-sel-note">Pays ${esc(usd(qtyNum))} if you hold it and it wins.${Number.isFinite(worth) && qtyNum >= 2
          ? ` <button type="button" class="mk-sel-half" data-mk-sell="${esc(key)}" data-part="half">Sell half</button>` : ""}</p>`}
    </section>`;
}

function exposureCard(open) {
  if (!open.length) return "";
  const groups = exposure(open);
  const cost = open.reduce((s, p) => s + (Number(p.cost) || 0), 0);
  const pays = open.reduce((s, p) => s + (Number(p.qty) || 0), 0);
  return `
    <section class="widget" aria-label="Where your money is">
      <div class="mk-rail-head"><h4 class="widget-title">Where your money is</h4></div>
      <div class="mk-exp-bar" role="img" aria-label="${esc(groups.map((g) => `${g.league} ${usd(g.value)}`).join(", "))}">
        ${groups.map((g) => `<span style="flex:${Math.max(g.value, 0.01).toFixed(2)}"></span>`).join("")}
      </div>
      <ul class="mk-exp-legend">
        ${groups.map((g) => `<li><i></i><span>${esc(g.league)} · ${g.count} pick${g.count === 1 ? "" : "s"}</span><b>${esc(usd(g.value))}</b></li>`).join("")}
      </ul>
      <dl class="mk-case">
        <div><dt>If all win</dt><dd class="mk-up">${esc(pnlText(pays - cost))}</dd></div>
        <div><dt>If all lose</dt><dd class="mk-down">${esc(pnlText(-cost))}</dd></div>
      </dl>
    </section>`;
}

function activityRow(i) {
  const side = i.outcome === "no" ? `Not ${i.label}` : i.label;
  const what = i.kind === "buy" ? `Bought ${i.qty} ${side} at ${centsText(i.price)}`
    : i.kind === "sell" ? `Sold ${i.qty} ${side} at ${centsText(i.price)}`
    : `${side} settled · ${i.kind}`;
  const amt = Number(i.amount);
  return `<li><span class="mk-act-what">${esc(what)}</span><span class="mk-act-amt ${amt > 0 ? "mk-up" : ""}">${esc(amt > 0 ? `+${usd(amt)}` : usd(amt))}</span>
    <span class="mk-act-sub">${esc(i.title)} · ${esc(agoText(i.at))}</span></li>`;
}

function activityCard(st) {
  if (st.activity === null) return `<section class="widget" aria-label="Activity"><h4 class="widget-title">Activity</h4><div class="skel skel-line" style="width:70%;margin-top:12px"></div></section>`;
  if (!st.activity.length) return "";
  return `
    <section class="widget" aria-label="Activity">
      <div class="mk-rail-head"><h4 class="widget-title">Activity</h4></div>
      <ul class="mk-act">${st.activity.slice(0, ACTIVITY_SHOWN).map(activityRow).join("")}</ul>
      ${st.activity.length > ACTIVITY_SHOWN ? `<button type="button" class="mk-act-more" data-mk-activity-all>All activity</button>` : ""}
    </section>`;
}

// ── painting ──────────────────────────────────────────────────────────

/**
 * Paint the rail from the same answer the center list drew (`data`:
 * { a, history }), and fetch what only the rail shows (the value series,
 * activity) the first time or when asked (`refetch`).
 */
export function paintPicksRail(el, box, data, { refetch = false } = {}) {
  const st = railState(el);
  st.data = data;
  const open = data.a?.positions ?? [];
  const settled = data.history?.picks ?? [];
  box.innerHTML = [
    needsCard(needsYou(data.a, data.history)),
    data.a?.connected ? portfolioCard(data.a, st) : "",
    open.length || settled.length ? controlsCard(el, open, settled) : "",
    selectedCard(el, open, st),
    exposureCard(open),
    activityCard(st),
  ].join("");
  if (refetch || st.points === null) void loadSeries(el, box);
  if (refetch || st.activity === null) void loadActivity(el, box);
}

async function loadSeries(el, box) {
  const st = railState(el);
  const range = st.range;
  try {
    const points = await portfolioSeries(range);
    if (st.range !== range) return;
    st.points = points;
  } catch {
    st.points = [];
  }
  if (box.isConnected && st.data) paintPicksRail(el, box, st.data);
}

async function loadActivity(el, box) {
  const st = railState(el);
  try { st.activity = await activityList(); } catch { st.activity = []; }
  if (box.isConnected && st.data) paintPicksRail(el, box, st.data);
}

/** Phones: Needs you as chips and the Open · Settled · All switch, above the list. */
export function phoneTools(el, data) {
  const open = data.a?.positions ?? [];
  const settled = data.history?.picks ?? [];
  if (!open.length && !settled.length) return "";
  const list = needsYou(data.a, data.history);
  return `
    <div class="mk-phone-tools">
      ${list.length ? `<div class="mk-att-strip" aria-label="Needs you">${list.map((n) => needRow(n, { chip: true })).join("")}</div>` : ""}
      ${filterSwitch(el.dataset.picksFilter || "all", open.length, settled.length)}
    </div>`;
}

// ── what the controls do ──────────────────────────────────────────────

/** True while the rail is on screen (Home hides its right column under 900px). */
const railShown = (box) => Boolean(box?.offsetParent);

/**
 * Wire the rail's controls on `root` (the rail box, and the tab element for
 * the phone tools and the list's rows). `redraw()` repaints the list and
 * the rail from the last answer; `refresh()` fetches again.
 */
export function bindPicksTools(root, el, box, { redraw, refresh }) {
  if (root.dataset.picksTools) return;
  root.dataset.picksTools = "1";
  if (root === box) bindTrade(box);
  root.addEventListener("change", (e) => {
    const s = e.target.closest("[data-mk-sort]");
    if (s) { el.dataset.picksSort = s.value; redraw(); }
  });
  root.addEventListener("click", async (e) => {
    const t = e.target.closest("[data-mk-filter], [data-mk-league], [data-mk-pick], [data-mk-unselect], [data-mk-range], [data-mk-seen], [data-mk-sell], [data-mk-sell-cancel], [data-mk-sell-go], [data-mk-share], [data-mk-disconnect], [data-mk-activity-all]");
    if (!t || t.disabled) return;
    const d = t.dataset;
    const st = railState(el);
    if (d.mkFilter !== undefined) {
      el.dataset.picksFilter = d.mkFilter;
      el.dataset.picksLeague = "";
      redraw();
    } else if (d.mkLeague !== undefined) {
      el.dataset.picksLeague = d.mkLeague;
      redraw();
    } else if (d.mkPick !== undefined) {
      // With the rail on screen a pick is selected and managed there; on phones it opens the trade sheet.
      if (railShown(box)) {
        const key = `${d.mkPick}|${d.outcome === "no" ? "no" : "yes"}`;
        el.dataset.picksSel = el.dataset.picksSel === key && root !== box ? "" : key;
        st.confirm = null;
        redraw();
        if (root === box) el.querySelector(`[data-mk-pick="${CSS.escape(d.mkPick)}"][data-outcome="${CSS.escape(d.outcome)}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
      } else {
        openPickSheet(el, `${d.mkPick}|${d.outcome === "no" ? "no" : "yes"}`, refresh);
      }
    } else if (d.mkUnselect !== undefined) {
      el.dataset.picksSel = "";
      st.confirm = null;
      redraw();
    } else if (d.mkRange) {
      st.range = d.mkRange;
      st.points = null;
      redraw();
      void loadSeries(el, box);
    } else if (d.mkSeen !== undefined) {
      t.disabled = true;
      try {
        const at = await markSeen();
        if (st.data?.history) st.data.history.seenAt = at;
        redraw();
      } catch (err) { toast(err.message); t.disabled = false; }
    } else if (d.mkSell) {
      st.confirm = d.mkSell;
      st.part = d.part === "half" ? "half" : "all";
      redraw();
    } else if (d.mkSellCancel !== undefined) {
      st.confirm = null;
      redraw();
    } else if (d.mkSellGo) {
      const [symbol, outcome] = d.mkSellGo.split("|");
      t.disabled = true;
      t.textContent = "Selling…";
      try {
        const r = await sell({ symbol, outcome, part: d.part === "half" ? "half" : "all" });
        st.confirm = null;
        el.dataset.picksSel = r.closed === false ? el.dataset.picksSel : "";
        toast(`Sold ${r.fill.qty} for ${usd(r.fill.cost)}${r.practice ? " (practice)" : ""}.`);
        st.activity = null;
        refresh();
      } catch (err) {
        toast(err.message);
        st.confirm = null;
        redraw();
      }
    } else if (d.mkShare) {
      openComposeSheet({ market: { symbol: d.mkShare, outcome: d.outcome === "no" ? "no" : "yes", title: d.title, label: d.side } });
    } else if (d.mkDisconnect !== undefined) {
      try { await disconnect(); forgetMe(); toast("Gemini disconnected"); refresh(); }
      catch (err) { toast(err.message); }
    } else if (d.mkActivityAll !== undefined) {
      openActivitySheet(st.activity ?? []);
    }
  });
}

/**
 * Phones have no rail, so a tapped pick opens the selected-pick card in a
 * bottom sheet: Add more (the trade sheet) and Sell, confirmed, like the rail.
 */
function openPickSheet(el, key, refresh) {
  const open = railState(el).data?.a?.positions ?? [];
  const st = { confirm: null };
  const holder = { dataset: { picksSel: key } };
  const { body, close } = openSheet({ id: "mk-pick-sheet", title: "Your pick", bottom: true });
  const paint = () => {
    body.innerHTML = selectedCard(holder, open, st) || `<p class="empty empty-sm">This pick is closed.</p>`;
    body.querySelector("[data-mk-unselect]")?.remove();
  };
  paint();
  body.addEventListener("click", async (e) => {
    const t = e.target.closest("[data-trade], [data-mk-sell], [data-mk-sell-cancel], [data-mk-sell-go]");
    if (!t || t.disabled) return;
    const d = t.dataset;
    if (d.trade) {
      close();
      const trade = await import("./trade.js");
      void trade.openTradeBySymbol(d.trade, d.outcome === "no" ? "no" : "yes");
    } else if (d.mkSell) {
      st.confirm = d.mkSell;
      st.part = d.part === "half" ? "half" : "all";
      paint();
    } else if (d.mkSellCancel !== undefined) {
      st.confirm = null;
      paint();
    } else if (d.mkSellGo) {
      const [symbol, outcome] = d.mkSellGo.split("|");
      t.disabled = true;
      t.textContent = "Selling…";
      try {
        const r = await sell({ symbol, outcome, part: d.part === "half" ? "half" : "all" });
        toast(`Sold ${r.fill.qty} for ${usd(r.fill.cost)}${r.practice ? " (practice)" : ""}.`);
        railState(el).activity = null;
        close();
        refresh();
      } catch (err) {
        toast(err.message);
        st.confirm = null;
        paint();
      }
    }
  });
}

function openActivitySheet(items) {
  const { body } = openSheet({ id: "mk-activity-sheet", title: "Activity" });
  body.innerHTML = items.length
    ? `<ul class="mk-act mk-act-sheet">${items.map(activityRow).join("")}</ul>`
    : `<p class="empty empty-sm">Nothing yet.</p>`;
}
