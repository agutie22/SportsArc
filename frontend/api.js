/**
 * Thin fetch wrapper. Every endpoint answers {ok:true,...} or
 * {ok:false,error:{code,message}}, so failures surface as thrown Errors
 * carrying the server's message.
 */

import { reportApiFailure } from "./errors.js";

const CRED = { credentials: "same-origin" };

async function readJson(res) {
  try { return await res.json(); } catch { return {}; }
}

/**
 * Warmed GETs: answers fetched ahead of need (a tab the viewer has not
 * opened yet, or one their pointer is on), each used once by the next
 * apiGet of the same URL. A page whose requests are all warm fills in
 * the same frame it draws its skeleton, so the skeleton never shows.
 * Entries go stale after WARM_MS, and a write clears them, so a page
 * never opens on data from before the viewer's own action. A write clears
 * everything unless it names what it touches (`stale`: URL prefixes), as
 * marking notifications read does; when unsure, leave it out.
 */
const WARM_MS = 60_000;
const warmed = new Map();  // url → { promise, at }

const toUrl = (path, params) => (params ? `${path}?${new URLSearchParams(params)}` : path);

function dropWarmed(stale) {
  if (!stale) { warmed.clear(); return; }
  for (const url of warmed.keys()) if (stale.some((p) => url.startsWith(p))) warmed.delete(url);
}

export function warm(path, params) {
  const url = toUrl(path, params);
  const hit = warmed.get(url);
  if (hit && Date.now() - hit.at < WARM_MS) return;
  const promise = api(url);
  promise.catch(() => { if (warmed.get(url)?.promise === promise) warmed.delete(url); });
  warmed.set(url, { promise, at: Date.now() });
}

export async function api(path, { stale, ...opts } = {}) {
  const write = opts.method && opts.method !== "GET";
  if (write) dropWarmed(stale);
  const res = await fetch(path, { ...CRED, ...opts });
  // Again on the answer: a warm started while the write was in flight may hold the old state.
  if (write) dropWarmed(stale);
  const body = await readJson(res);
  if (!res.ok || !body.ok) {
    const err = new Error(body.error?.message ?? `Request failed (${res.status})`);
    err.code = body.error?.code ?? "UNKNOWN";
    err.status = res.status;
    if (res.status >= 500) {
      reportApiFailure(path, res.status, res.headers.get("X-Request-Id") ?? body.error?.reqId, body.error?.code);
      err.reported = true;
    }
    throw err;
  }
  return body;
}

export function apiGet(path, params) {
  const url = toUrl(path, params);
  const hit = warmed.get(url);
  if (hit) {
    warmed.delete(url);
    if (Date.now() - hit.at < WARM_MS) return hit.promise;
  }
  return api(url);
}

/** A write. `stale` narrows which warmed answers it clears (see dropWarmed); default all. */
export const apiSend = (path, method, body, { stale } = {}) =>
  api(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
    stale,
  });

let metaPromise = null;

/**
 * GET /api/meta (sports, skill levels, venue kinds, roles, outcomes),
 * fetched once per page. A failed load is forgotten so the next call
 * retries.
 */
export function loadMeta() {
  metaPromise ??= apiGet("/api/meta").then((b) => b.meta).catch((err) => {
    metaPromise = null;
    throw err;
  });
  return metaPromise;
}

/** Escape untrusted text before it goes anywhere near innerHTML. */
export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const titleCase = (s) => (s ? s[0].toUpperCase() + s.slice(1) : "");

export function timeAgo(iso) {
  const secs = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (secs < 60) return "now";
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  if (secs < 604800) return `${Math.floor(secs / 86400)}d`;
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
}

export function whenLabel(iso) {
  const d = new Date(iso);
  const now = new Date();
  const time = clockText(d);
  if (d.toDateString() === now.toDateString()) return `Today · ${time}`;
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  if (d.toDateString() === tomorrow.toDateString()) return `Tomorrow · ${time}`;
  if ((d - now) / 86400000 < 7) return `${d.toLocaleDateString([], { weekday: "long" })} · ${time}`;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} · ${time}`;
}

/** Wait `ms` milliseconds. */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The first word of a name, or `fallback` when there is none ("Someone"). */
export const firstName = (name, fallback = "Someone") => String(name ?? "").trim().split(/\s+/)[0] || fallback;

/** 1 → "1st", 2 → "2nd", 11 → "11th", 23 → "23rd". */
export function ordinal(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

/** "10:45 AM", from an ISO string or a Date. */
export const clockText = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** "just now", "5m ago", "3h ago", "2d ago"; older than a week, "on Nov 3". */
export function agoText(iso) {
  const t = timeAgo(iso);
  if (t === "now") return "just now";
  return /^\d+[mhd]$/.test(t) ? `${t} ago` : `on ${t}`;
}

/** Calendar-day key for grouping (local time). */
export const dayKey = (t) => new Date(t).toDateString();

/**
 * The heading a list grouped by day puts over a past day: Today, Yesterday,
 * a weekday within the week, then "Nov 17" (with the year when it isn't this one).
 */
export function dayHeading(iso, today = new Date()) {
  const d = new Date(iso);
  const start = (t) => new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
  const days = Math.round((start(today) - start(d)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return d.toLocaleDateString([], { weekday: "long" });
  return d.toLocaleDateString([], {
    month: "short", day: "numeric", ...(d.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }),
  });
}

/**
 * Dollars: "$1,204.50", "−$1.20". `short` drops a ".00" ("$5"), for prices
 * people type as whole dollars. Accepts "5", "$5.00" or 5; anything else is "—".
 */
export function usd(v, { short = false } = {}) {
  const n = v === null || v === undefined || v === "" ? NaN : Number(String(v).replace("$", ""));
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const digits = short && Number.isInteger(abs) ? 0 : 2;
  return `${n < 0 ? "−" : ""}$${abs.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

const SPORT_ICONS = {
  basketball: "\u{1F3C0}", soccer: "⚽", football: "\u{1F3C8}",
  volleyball: "\u{1F3D0}", baseball: "⚾", softball: "\u{1F94E}",
  tennis: "\u{1F3BE}", pickleball: "\u{1F3D3}", hockey: "\u{1F3D2}", other: "\u{1F3C5}",
};

export const sportIcon = (s) => SPORT_ICONS[s] ?? SPORT_ICONS.other;

const initialsOf = (name) =>
  (name || "?").split(" ").map((w) => w[0]).join("").toUpperCase().slice(0, 2);

// ── location ──────────────────────────────────────────────────────────
//
// One place holds where the viewer last was: every fix getCoords() gets
// (Home's nearby rail, Games, the host sheet, check-in) lands here and is
// kept for the session, so a page that lists games near the viewer reads
// lastCoords() instead of asking again or keeping its own copy.

const COORDS_KEY = "sportsarc.coords";
let LAST_COORDS = (() => {
  try {
    const c = JSON.parse(sessionStorage.getItem(COORDS_KEY) ?? "null");
    return Number.isFinite(c?.lat) && Number.isFinite(c?.lng) ? { lat: c.lat, lng: c.lng } : null;
  } catch { return null; }
})();

/** The viewer's last known position this session, or null. */
export const lastCoords = () => LAST_COORDS;

/** Browser geolocation as a promise; resolves null rather than rejecting. */
export function getCoords({ timeout = 8000 } = {}) {
  return new Promise((resolve) => {
    if (!navigator.geolocation) { resolve(null); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => {
        LAST_COORDS = { lat: p.coords.latitude, lng: p.coords.longitude };
        try { sessionStorage.setItem(COORDS_KEY, JSON.stringify(LAST_COORDS)); } catch { /* private mode */ }
        resolve(LAST_COORDS);
      },
      () => resolve(null),
      { timeout, enableHighAccuracy: true },
    );
  });
}

let locating = null;

/**
 * The last known position, else one fresh fix shared by every caller
 * waiting on it (Home and Games asking at once prompt once).
 */
export function locate({ timeout = 8000 } = {}) {
  if (LAST_COORDS) return Promise.resolve(LAST_COORDS);
  locating ??= getCoords({ timeout }).finally(() => { locating = null; });
  return locating;
}

/**
 * Avatar markup. Shows the uploaded photo when there is one, otherwise
 * initials on the role color. `href` makes it a profile link.
 */
export function avatar(person, size = "sm", { href = "", cls = "" } = {}) {
  const tag = href ? "a" : "span";
  const url = person?.avatarUrl;
  const inner = url
    ? `<img src="${esc(url)}" alt="" loading="lazy" decoding="async">`
    : esc(initialsOf(person?.name));
  return `<${tag} class="avatar avatar-${size}${url ? " has-img" : ""}${cls ? ` ${cls}` : ""}"
    data-role="${esc(person?.role ?? "")}"${href ? ` href="${esc(href)}"` : ""}
    ${href ? `aria-label="${esc(person?.name ?? "Profile")}"` : ""}>${inner}</${tag}>`;
}

/**
 * A person's name as a link to their profile. Plain bold text when there
 * is no id to open (a label, or someone the server could not name).
 * `label` overrides the visible text, for a first name in a tight row.
 */
export function personLink(person, { fallback = "Someone", label } = {}) {
  const shown = esc(label ?? (person?.name || fallback));
  if (!person?.id) return `<span class="person-name">${shown}</span>`;
  return `<a class="person-link" href="#/u/${esc(person.id)}">${shown}</a>`;
}

// ── uploads ───────────────────────────────────────────────────────────

const MAX_EDGE = 2048;
const RESIZE_OVER_BYTES = 1.5 * 1024 * 1024;

/**
 * Phone photos are routinely 4–12 MB, over the server's 5 MB cap. Anything
 * large or oversized is redrawn at most 2048px on the long edge as JPEG.
 * Small files go up untouched so PNG transparency survives.
 */
async function prepareImage(file) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
    throw new Error("Choose a JPEG, PNG or WebP image.");
  }
  let bitmap;
  try { bitmap = await createImageBitmap(file); } catch { return file; }
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size <= RESIZE_OVER_BYTES) { bitmap.close?.(); return file; }

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.86));
  return blob ?? file;
}

/** Upload one image; resolves to its /uploads/... URL. */
export async function uploadImage(file) {
  const body = await prepareImage(file);
  const r = await api("/api/uploads", {
    method: "POST",
    headers: { "Content-Type": body.type || "application/octet-stream" },
    body,
  });
  return r.url;
}
