/**
 * The rail beside the Markets views: Games › Markets (above it on phones)
 * and Home › Markets.
 *
 *   the account     money available to trade, then three numbers: in play
 *                   (what open positions are worth), open P&L, and the
 *                   settled record. A real Gemini link adds Add money and
 *                   Disconnect; without one, what connecting gets you
 *   positions       each open position: side, value, P&L, and a meter from
 *                   the price paid to the price now; listed and settled by
 *                   Gemini, adults only
 *
 * Refreshes every 30 s and right after a buy.
 */

import { ICON, toast } from "../shared.js";
import { esc, usd } from "../api.js";
import { centsText, connectUrl, disconnect, every, forgetMe, me, onChanged, pickHistory, pnlText } from "./client.js";
import { bindTrade } from "./card.js";

/** Positions the rail lists; the rest are on Your picks. */
const RAIL_POSITIONS = 8;

export function renderRail(sport, el) {
  el.classList.add("mk-rail");
  bindTrade(el);

  const paint = async (fresh = false) => {
    const [a, history] = await Promise.all([me({ fresh }), pickHistory().catch(() => null)]);
    if (!el.isConnected) return;
    if (!a.allowed || !a.enabled) { el.innerHTML = ""; return; }
    el.innerHTML = a.connected
      ? `${accountCard(a, history?.record ?? null)}${positionsCard(a)}`
      : connectCard(a, sport);
  };

  el.addEventListener("click", async (e) => {
    if (!e.target.closest("[data-mk-disconnect]")) return;
    try {
      await disconnect();
      forgetMe();
      toast("Gemini disconnected");
      void paint(true);
    } catch (err) {
      toast(err.message);
    }
  });

  void paint();
  every(el, 30_000, () => void paint(true));
  onChanged(el, () => void paint(true));
}

/** Open positions together: what they are worth now and their P&L. */
export function openTotals(a) {
  const ps = a.positions ?? [];
  return {
    count: ps.length,
    inPlay: ps.reduce((sum, p) => sum + (Number(p.value ?? p.cost) || 0), 0),
    pnl: ps.reduce((sum, p) => sum + (Number(p.pnl) || 0), 0),
  };
}

export const recordText = (r) => (r ? `${r.won}–${r.lost}` : "—");

/** "+13¢", "−4¢", "unchanged". */
const moveText = (d) => (d === 0 ? "unchanged" : `${d > 0 ? "+" : "−"}${Math.abs(d)}¢`);

function connectCard(a, sport) {
  return `
    <section class="widget mk-account">
      <div class="mk-rail-head"><h4 class="widget-title">Trade pro markets</h4></div>
      <ul class="mk-connect-list">
        <li><span class="mk-connect-ic">${ICON.trendUp}</span><span><strong>Live prices</strong>Pro and college games, updated every 15 seconds.</span></li>
        <li><span class="mk-connect-ic">${ICON.card}</span><span><strong>Your own account</strong>Money stays on Gemini. SportsArc never holds it.</span></li>
        <li><span class="mk-connect-ic">${ICON.people}</span><span><strong>Picks with friends</strong>Share a side, never the size.</span></li>
      </ul>
      ${a.trading === "oauth" ? `<a class="btn-post mk-wide" href="${esc(connectUrl(sport))}">Connect Gemini</a>` : ""}
      <p class="mk-account-note">Adults only · US accounts</p>
    </section>`;
}

function accountCard(a, record) {
  const t = openTotals(a);
  const linked = a.trading === "oauth";
  const actions = [
    a.siteUrl ? `<a class="btn-game btn-game-ghost" href="${esc(a.siteUrl)}" target="_blank" rel="noopener">Add money on Gemini</a>` : "",
    linked ? `<button type="button" class="mk-icon-btn" data-mk-disconnect aria-label="Disconnect Gemini" title="Disconnect Gemini">${ICON.unlink}</button>` : "",
  ].join("");
  return `
    <section class="widget mk-account">
      <div class="mk-rail-head">
        <h4 class="widget-title">${a.practice ? "Your account" : "Gemini account"}</h4>
        ${a.practice ? `<span class="mk-badge mk-badge-practice" title="Practice money at live Gemini prices">Practice</span>` : `<span class="mk-badge mk-badge-on">Connected</span>`}
      </div>
      <div class="mk-balance-block">
        <span class="mk-balance-label">${a.practice ? "Practice money · live Gemini prices" : "Available to trade"}</span>
        <span class="mk-balance">${esc(usd(a.usdAvailable))}</span>
      </div>
      <dl class="mk-stats">
        <div><dt>In play</dt><dd>${esc(usd(t.inPlay))}</dd></div>
        <div><dt>Open P&amp;L</dt><dd class="${t.pnl >= 0 ? "mk-up" : "mk-down"}">${esc(pnlText(t.pnl))}</dd></div>
        <div><dt>Record</dt><dd>${esc(recordText(record))}</dd></div>
      </dl>
      ${actions ? `<div class="mk-account-actions">${actions}</div>` : ""}
      ${a.practice ? `<p class="mk-account-note">${ICON.info}Live Gemini prices</p>` : ""}
    </section>`;
}

/** 0–100¢ track: a tick at the price paid, a fill to the price now. `delta` adds the move in cents. */
export function meter(p, { delta = false } = {}) {
  const paid = Math.round(Number(p.avgPrice) * 100);
  const now = p.chanceNow;
  if (!Number.isFinite(paid) || now === null || now === undefined) return "";
  const lo = Math.min(paid, now);
  const dir = now > paid ? "up" : now < paid ? "down" : "";
  const ink = dir === "up" ? "mk-up" : dir === "down" ? "mk-down" : "";
  return `
    <span class="mk-meter ${dir}" aria-hidden="true">
      ${dir ? `<span class="mk-meter-fill" style="left:${lo}%;width:${Math.abs(now - paid)}%"></span>` : ""}
      <span class="mk-meter-paid" style="left:${paid}%"></span>
    </span>
    <span class="mk-meter-text"><span>Paid ${paid}¢</span><span class="${ink}">Now ${now}¢${delta ? ` · ${moveText(now - paid)}` : ""}</span></span>`;
}

function positionsCard(a) {
  const all = a.positions ?? [];
  const rows = all.slice(0, RAIL_POSITIONS).map((p) => {
    const no = p.outcome === "no";
    const pnl = p.pnl === null ? null : Number(p.pnl);
    const value = usd(p.value === null ? p.cost : p.value);
    return `
      <button type="button" class="mk-pos" data-trade="${esc(p.symbol)}" data-outcome="${esc(p.outcome)}"
              aria-label="${esc(`${p.label}, ${no ? "no" : "yes"}, worth ${value}${pnl === null ? "" : `, ${pnlText(pnl)}`}`)}">
        <span class="mk-pos-top">
          <span class="mk-side-chip${no ? " mk-side-no" : ""}">${no ? "NO" : "YES"}</span>
          <strong>${esc(p.label)}</strong>
          <span class="mk-pos-val">${esc(value)}</span>
        </span>
        <span class="mk-pos-sub">
          <span>${esc(p.title)} · ${esc(p.qty)} at ${esc(centsText(p.avgPrice))}</span>
          ${pnl === null ? "" : `<span class="mk-pnl ${pnl > 0 ? "mk-up" : pnl < 0 ? "mk-down" : ""}">${esc(pnlText(pnl))}</span>`}
        </span>
        ${meter(p)}
      </button>`;
  }).join("");
  return `
    <section class="widget mk-positions">
      <div class="mk-rail-head">
        <h4 class="widget-title">Open positions</h4>
        ${all.length ? `<span class="mk-count">${all.length}</span>` : ""}
      </div>
      <div class="widget-body">
        ${rows || `<p class="empty-inline">No positions yet. Pick a side on any game.</p>`}
      </div>
      <div class="mk-pos-foot"><a href="#/markets/picks">All your picks</a><span>Settled by Gemini · adults only</span></div>
    </section>`;
}
