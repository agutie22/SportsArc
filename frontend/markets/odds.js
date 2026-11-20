/**
 * Odds over time on market cards: a sparkline of a contract's chance over
 * the last 24 hours, and how far it moved. (An open pick's move since it
 * was made is the paid → now meter in rail.js.)
 *
 * A card leaves a placeholder, <div class="mk-odds" data-odds="SYMBOL"
 * data-now="CHANCE">, and watchOdds(root) paints every placeholder under
 * root, now and after each repaint (the 15 s timers rewrite the cards).
 * Series come from GET /api/markets/odds, one request per batch of new
 * symbols; each answer is kept a minute by symbol. The live chance the card
 * already shows is the last point, so the line always ends at "now".
 */

import { apiGet, esc } from "../api.js";

const HOURS = 24;
const KEEP_MS = 60_000;
/** The y scale never spans less than this, so a 1-point wobble stays flat. */
const MIN_SPAN = 10;
const W = 120;
const H = 28;

/** symbol → { at, series } — a cache by id, shared by every page. */
const seen = new Map();
let inflight = null;

async function load(symbols) {
  const want = symbols.filter((s) => !(Date.now() - (seen.get(s)?.at ?? 0) < KEEP_MS));
  if (want.length) {
    if (inflight) await inflight.catch(() => {});
    inflight = apiGet("/api/markets/odds", { symbols: want.join(","), hours: HOURS }).then((b) => {
      const at = Date.now();
      for (const s of want) seen.set(s, { at, series: b.series?.[s] ?? [] });
    });
    try { await inflight; } catch { /* no line is better than an error on a card */ }
    inflight = null;
  }
  return new Map(symbols.map((s) => [s, seen.get(s)?.series ?? []]));
}

/** Points (seconds, chance) with the live chance appended; null when there is nothing to draw. */
function withNow(series, now) {
  const end = Math.floor(Date.now() / 1000);
  const pts = series.filter(([t]) => t <= end);
  if (Number.isFinite(now)) pts.push([end, now]);
  return pts.length >= 2 ? pts : null;
}

/** The SVG polyline for a series over the last HOURS. */
function spark(pts) {
  const end = pts[pts.length - 1][0];
  const start = end - HOURS * 3600;
  const ys = pts.map(([, c]) => c);
  let lo = Math.min(...ys);
  let hi = Math.max(...ys);
  if (hi - lo < MIN_SPAN) {
    const mid = (hi + lo) / 2;
    lo = Math.max(0, mid - MIN_SPAN / 2);
    hi = Math.min(100, lo + MIN_SPAN);
  }
  const x = (t) => (Math.max(t, start) - start) / (end - start) * W;
  const y = (c) => H - 2 - ((c - lo) / (hi - lo)) * (H - 4);
  // A step line: a chance holds until the next change.
  const path = [];
  pts.forEach(([t, c], i) => {
    if (i > 0) path.push(`${x(t).toFixed(1)},${y(pts[i - 1][1]).toFixed(1)}`);
    path.push(`${x(t).toFixed(1)},${y(c).toFixed(1)}`);
  });
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
    <polyline points="${path.join(" ")}" fill="none" stroke="currentColor" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

function paintOne(el, series) {
  const pts = withNow(series, Number(el.dataset.now));
  if (!pts) { el.hidden = true; return; }
  const moved = pts[pts.length - 1][1] - pts[0][1];
  const dir = moved > 0 ? "up" : moved < 0 ? "down" : "flat";
  const text = moved === 0 ? "No change in 24h" : `${moved > 0 ? "▲" : "▼"} ${Math.abs(moved)} pt${Math.abs(moved) === 1 ? "" : "s"} in 24h`;
  el.hidden = false;
  el.classList.add(`mk-odds-${dir}`);
  el.innerHTML = `${spark(pts)}<span class="mk-odds-text">${esc(text)}</span>`;
  el.setAttribute("aria-label", `${el.dataset.label ?? "Chance"}: ${text}`);
}

async function paint(root) {
  const els = [...root.querySelectorAll("[data-odds]:not([data-odds-done])")];
  if (!els.length) return;
  for (const el of els) el.dataset.oddsDone = "1";
  const series = await load([...new Set(els.map((el) => el.dataset.odds))]);
  for (const el of els) if (el.isConnected) paintOne(el, series.get(el.dataset.odds) ?? []);
}

/** Paint the odds placeholders under `root`, and again whenever its cards are rewritten. */
export function watchOdds(root) {
  if (!root || root.dataset.oddsWatched) return;
  root.dataset.oddsWatched = "1";
  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    void Promise.resolve().then(() => { queued = false; return paint(root); });
  };
  new MutationObserver(schedule).observe(root, { childList: true, subtree: true });
  schedule();
}

/** A card's placeholder for one contract's line. */
export function oddsSlot(c, label) {
  if (!c?.symbol || c.chance === null || c.chance === undefined) return "";
  return `<div class="mk-odds" data-odds="${esc(c.symbol)}" data-now="${esc(c.chance)}" data-label="${esc(label ?? "")}" hidden></div>`;
}
