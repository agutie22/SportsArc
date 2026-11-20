/**
 * Pro markets: the API calls and the small formatters every markets file
 * shares. The UI says "$" and "chance", never "USDC" or "probability".
 */

import { apiGet, apiSend, clockText, usd } from "../api.js";

let ME = null;

/**
 * The account card's data (GET /api/markets/me), shared by everything on
 * the page. `fresh` refetches, e.g. after a fill.
 */
export function me({ fresh = false } = {}) {
  if (!fresh && ME) return ME;
  ME = apiGet("/api/markets/me").then((b) => b.account).catch(() => {
    ME = null;
    return { allowed: false };
  });
  return ME;
}

/** Forget the cached account (sign-out, connect, disconnect). */
export function forgetMe() {
  ME = null;
}
// Sign-out, or a profile edit (a birth date decides the adult gate).
document.addEventListener("sportsarc:user-changed", () => forgetMe());

const listCache = new Map();   // sport → { at, promise, value }
const FRESH_MS = 15_000;
const KEEP_MS = 5 * 60_000;

/**
 * A sport's markets. Stale-while-revalidate: a copy under 15 s old is used
 * as is; an older one (up to 5 min) is answered at once while a refresh
 * runs behind it, so switching sports never waits on the network twice.
 * `fresh` (the 15 s repaint timers) waits for new data.
 */
export function markets(sport, { fresh = false } = {}) {
  const hit = listCache.get(sport);
  const age = hit ? Date.now() - hit.at : Infinity;
  if (!fresh && hit && age < FRESH_MS) return hit.promise;
  const load = () => {
    const promise = apiGet("/api/markets", { sport }).then((b) => {
      listCache.set(sport, { at: Date.now(), promise: Promise.resolve(b), value: b });
      return b;
    });
    promise.catch(() => {
      // A failed refresh keeps any older copy and lets the next call try again.
      const cur = listCache.get(sport);
      if (cur?.loading !== promise) return;
      if (cur.value) listCache.set(sport, { at: cur.at, promise: Promise.resolve(cur.value), value: cur.value });
      else listCache.delete(sport);
    });
    // Keep serving the old value while the new one loads.
    listCache.set(sport, { at: hit?.value ? hit.at : Date.now(), promise: hit?.value ? Promise.resolve(hit.value) : promise, value: hit?.value, loading: promise });
    return promise;
  };
  if (!fresh && hit?.value && age < KEEP_MS) {
    if (!hit.loading) load();
    return Promise.resolve(hit.value);
  }
  if (hit?.loading) return hit.loading;
  return load();
}

/** Load a sport's markets ahead of a click; errors are ignored. */
export function prefetch(sport) {
  void markets(sport).catch(() => {});
}

/** Each sport's featured game, for the Markets view under ALL. */
let featuredHit = null;
/** Also Home's band and "Tonight on Gemini" (home.js); one request per 15 s however many ask. */
function featuredBody({ fresh = false } = {}) {
  if (!fresh && featuredHit && Date.now() - featuredHit.at < 15_000) return featuredHit.promise;
  const promise = apiGet("/api/markets/featured");
  promise.catch(() => { if (featuredHit?.promise === promise) featuredHit = null; });
  featuredHit = { at: Date.now(), promise };
  return promise;
}
export const featured = (opts) => featuredBody(opts).then((b) => b.sports);
/** The viewer's team's next game on Gemini ({ key, school, game }), or null (teams.js). */
export const featuredTeam = (opts) => featuredBody(opts).then((b) => b.team ?? null);

/** Picks people you follow posted (Home › Markets). */
export const followingPicks = () => apiGet("/api/markets/following").then((b) => b.picks);
/** Your settled picks and record (Home › Markets › Your picks). */
export const pickHistory = () => apiGet("/api/markets/history");

export const eventByTicker = (ticker) =>
  apiGet(`/api/markets/event/${encodeURIComponent(ticker)}`).then((b) => b.event);
export const quote = (body) => apiSend("/api/markets/quote", "POST", body).then((b) => b.quote);
export const order = (body) => apiSend("/api/markets/order", "POST", body);
/** Sell all of one side you hold (or half: `part: "half"`), at the bid; the rail and the strip refresh after. */
export async function sell({ symbol, outcome, part = "all" }) {
  const answer = await apiSend("/api/markets/sell", "POST", { symbol, outcome, part, clientOrderId: crypto.randomUUID() });
  document.dispatchEvent(new CustomEvent(CHANGED));
  return answer;
}
/** Buys, sales and settlements, newest first (Your picks › Activity). */
export const activityList = () => apiGet("/api/markets/activity").then((b) => b.items);
/** The account's value over a range: "1d" | "1w" | "1m" | "all" (Your picks › Portfolio). */
export const portfolioSeries = (range) => apiGet(`/api/markets/portfolio?range=${encodeURIComponent(range)}`).then((b) => b.points);
/** Settled picks up to now are seen ("Needs you"). */
export const markSeen = () => apiSend("/api/markets/seen", "POST", {}, { stale: ["/api/markets/history"] }).then((b) => b.seenAt);
export const terms = () => apiGet("/api/markets/terms").then((b) => b.terms);
export const acceptTerms = () => apiSend("/api/markets/terms/accept", "POST", {});
export const disconnect = () => apiSend("/api/markets/disconnect", "POST", {});
export const connectUrl = (sport) => `/api/markets/connect?sport=${encodeURIComponent(sport)}`;

/** Fired on document after a buy, so the rail and the strip refresh. */
export const CHANGED = "sportsarc:markets-changed";

// ── formatting ──────────────────────────────────────────────────────

/** "0.62" → "62¢". */
export const centsText = (p) => (p ? `${Math.round(Number(p) * 100)}¢` : "—");

/** 62 → "62%". */
export const chanceText = (c) => (c === null || c === undefined ? "—" : `${c}%`);

/** "+$0.60" / "−$1.20". */
export const pnlText = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return "";
  return `${n >= 0 ? "+" : "−"}${usd(Math.abs(n))}`;
};

/** Volume as "$1.2M traded". */
export function volumeText(v) {
  const n = Number(v) || 0;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M traded`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)}K traded`;
  return n > 0 ? `$${Math.round(n)} traded` : "New market";
}

/** "Live", "Tonight 7:30", "Tomorrow 7:00", "Fri 7:00", "Nov 21". */
export function whenText(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  if (d <= now) return "Live";
  const time = clockText(d);
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(now)) / 86_400_000);
  if (diff === 0) return d.getHours() >= 17 ? `Tonight ${time}` : `Today ${time}`;
  if (diff === 1) return `Tomorrow ${time}`;
  if (diff < 7) return `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** Run `fn` after every buy while `el` is on the page; the listener removes itself after. */
/**
 * A kept page (app.js swap) is taken out of the document while another tab
 * shows and put back later, so being disconnected is not the same as being
 * gone. Past this long out of the document it never comes back (app.js
 * keeps pages 5 minutes), and its listeners can go.
 */
const GONE_MS = 6 * 60_000;

/** Tracks how long `el` has been out of the document; true once it is gone for good. */
function goneWatch(el) {
  let outSince = 0;
  return () => {
    if (el.isConnected) { outSince = 0; return false; }
    outSince ||= Date.now();
    return Date.now() - outSince > GONE_MS;
  };
}

export function onChanged(el, fn) {
  const gone = goneWatch(el);
  const handler = () => {
    if (gone()) { document.removeEventListener(CHANGED, handler); return; }
    if (el.isConnected) fn();
  };
  document.addEventListener(CHANGED, handler);
}

/** Re-run `fn` every `ms` while `el` is on the page and the tab is visible; paused while its page is kept. */
export function every(el, ms, fn) {
  const gone = goneWatch(el);
  const timer = setInterval(() => {
    if (gone()) { clearInterval(timer); return; }
    if (el.isConnected && document.visibilityState === "visible") fn();
  }, ms);
  return () => clearInterval(timer);
}
