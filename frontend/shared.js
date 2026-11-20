/**
 * Shared DOM/state helpers for the SportsArc SPA.
 */

import * as circleSdk from "./circle-sdk.js";
import { apiGet } from "./api.js";

export const $ = (s, ctx = document) => ctx.querySelector(s);
export const $$ = (s, ctx = document) => [...ctx.querySelectorAll(s)];
export const main = () => $("#main-content");

let currentUser = null;

export function getUser() {
  return currentUser;
}
export function setUser(user) {
  currentUser = user;
}
export function clearUser() {
  currentUser = null;
}

export function userFromAccount(account) {
  if (!account?.name || !account?.role) return null;
  return {
    id: account.id,
    name: account.name,
    role: account.role,
    headline: account.headline || "",
    avatarUrl: account.avatarUrl || null,
    circle: { walletAddress: account.walletAddress || null },
  };
}

/**
 * GET /api/config, loaded once per page. It is public and the same for
 * every viewer, so signing out keeps it (the sign-in screen shows its
 * chain name).
 */
let CIRCLE_CONFIG = null;
let WALLET_ONCHAIN_BALANCE = null;

export async function loadPublicConfig() {
  if (CIRCLE_CONFIG) return CIRCLE_CONFIG;
  CIRCLE_CONFIG = (await apiGet("/api/config")).config ?? null;
  return CIRCLE_CONFIG;
}

/** Load the Circle SDK with the app id from the public config. */
export async function ensureCircleSdk() {
  const config = await loadPublicConfig();
  await circleSdk.init(config);
  return config;
}

/**
 * How often someone shows up, in the one wording every surface uses. Null
 * under the server's minimum (label "New"), so callers decide whether a new
 * player shows anything. `low` is under 70%, worth a host's attention.
 */
export function showsUp(r) {
  if (!r || r.label === "New" || !r.games) return null;
  return { text: `Shows up ${r.showed}/${r.games}`, low: r.showed / r.games < 0.7 };
}

export const ROLE_META = {
  scout: { label: "Scout", full: "Scout & Recruiter" },
  coach: { label: "Coach", full: "Coach" },
  player: { label: "Player", full: "Player" },
};

const svg = (inner) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

/**
 * Shared icon set. `globe` is the fallback tab icon when a feature module
 * does not bring its own.
 */
export const ICON = {
  search: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`,
  bolt: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
  clipboard: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/></svg>`,
  globe: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>`,
  target: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>`,
  home: svg(`<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>`),
  map: svg(`<path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2z"/><path d="M9 4v14M15 6v14"/>`),
  ball: svg(`<circle cx="12" cy="12" r="9"/><path d="M12 3v18M3 12h18M5.6 5.6c2.5 2.5 2.5 10.3 0 12.8M18.4 5.6c-2.5 2.5-2.5 10.3 0 12.8"/>`),
  people: svg(`<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>`),
  user: svg(`<path d="M20 21a8 8 0 0 0-16 0"/><circle cx="12" cy="7" r="4"/>`),
  plus: svg(`<path d="M12 5v14M5 12h14"/>`),
  heart: svg(`<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z"/>`),
  reply: svg(`<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.5 8.5 0 0 1-3.9-.9L3 21l1.9-5.1A8.5 8.5 0 1 1 21 11.5z"/>`),
  share: svg(`<path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="M16 6l-4-4-4 4M12 2v13"/>`),
  image: svg(`<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>`),
  close: svg(`<path d="M18 6 6 18M6 6l12 12"/>`),
  camera: svg(`<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>`),
  shield: svg(`<path d="M12 3l7 3v6c0 4.5-3 8-7 9-4-1-7-4.5-7-9V6z"/><path d="m9 12 2 2 4-4"/>`),
  pin: svg(`<path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>`),
  moon: svg(`<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>`),
  logout: svg(`<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>`),
  grid: svg(`<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>`),
  list: svg(`<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>`),
  trash: svg(`<path d="M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/>`),
  back: svg(`<path d="M19 12H5M12 19l-7-7 7-7"/>`),
  link: svg(`<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>`),
  school: svg(`<path d="M22 10 12 5 2 10l10 5 10-5z"/><path d="M6 12v5c3 3 9 3 12 0v-5"/>`),
  stack: svg(`<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M4 16V5a1 1 0 0 1 1-1h11"/>`),
  bell: svg(`<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0"/>`),
  crown: svg(`<path d="M2 18h20M3 7l5 5 4-7 4 7 5-5-2 11H5z"/>`),
  play: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.1v13.8a1 1 0 0 0 1.5.9l11-6.9a1 1 0 0 0 0-1.8l-11-6.9A1 1 0 0 0 8 5.1z"/></svg>`,
  check: svg(`<path d="M20 6 9 17l-5-5"/>`),
  dollar: svg(`<path d="M12 2v20"/><path d="M17 6.5c0-1.9-2.2-3.5-5-3.5S7 4.6 7 6.5 9.2 9.6 12 10s5 1.6 5 3.5-2.2 3.5-5 3.5-5-1.6-5-3.5"/>`),
  arrowRight: svg(`<path d="M5 12h14M13 5l7 7-7 7"/>`),
  trendUp: svg(`<path d="M23 6l-9.5 9.5-5-5L1 18"/><path d="M17 6h6v6"/>`),
  more: svg(`<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>`),
  copy: svg(`<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>`),
  external: svg(`<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>`),
  arrowUp: svg(`<path d="M12 19V5M5 12l7-7 7 7"/>`),
  arrowDown: svg(`<path d="M12 5v14M5 12l7 7 7-7"/>`),
  send: svg(`<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7z"/>`),
  info: svg(`<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>`),
  unlink: svg(`<path d="m18.84 12.25 1.72-1.71a5 5 0 0 0-7.07-7.07l-1.72 1.71M5.17 11.75l-1.71 1.71a5 5 0 0 0 7.07 7.07l1.71-1.71M8 2v3M2 8h3M16 22v-3M22 16h-3"/>`),
  card: svg(`<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>`),
  trophy: svg(`<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/>`),
};

// ── theme ─────────────────────────────────────────────────────────────
//
// Dark is the default. index.html applies a saved choice before first
// paint; this only flips and remembers it.

export const currentTheme = () =>
  document.documentElement.dataset.theme === "light" ? "light" : "dark";

export function setTheme(theme) {
  if (theme === "light") document.documentElement.dataset.theme = "light";
  else delete document.documentElement.dataset.theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = theme === "light" ? "#F4F5F7" : "#08090B";
  try { localStorage.setItem("sportsarc_theme", theme); } catch { /* per-device nicety only */ }
}

/** A short tap of haptics where the platform offers it; silent elsewhere. */
export function haptic(ms = 8) {
  try { navigator.vibrate?.(ms); } catch { /* unsupported */ }
}


export function shortAddr(addr, head = 6, tail = 4) {
  if (!addr) return "—";
  if (addr.length <= head + tail + 2) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

/**
 * The block explorer comes from GET /api/config, which reads
 * api/circle/chain-config.ts. Keeping that base server-side means adding a
 * chain is one edit there rather than one in each language.
 */
export function explorerUrlFor(hashOrAddr, { kind = "address" } = {}) {
  const base = CIRCLE_CONFIG?.explorerUrl;
  if (!base) return "";
  return `${base}/${kind}/${hashOrAddr}`;
}

/** Copy `text`; toast `done` when a message is given. True once copied. */
export async function copyText(text, done = "") {
  try {
    await navigator.clipboard.writeText(text);
    if (done) toast(done);
    return true;
  } catch {
    toast("Could not copy it.");
    return false;
  }
}

/**
 * Share a link: the native share sheet where there is one, else copy it.
 * Dismissing the share sheet is not an error and says nothing.
 */
export async function shareLink({ url, title, text } = {}) {
  try {
    if (navigator.share) {
      await navigator.share({ ...(title ? { title } : {}), ...(text ? { text } : {}), url });
      return;
    }
    await navigator.clipboard.writeText(url);
    toast("Link copied.");
  } catch (err) {
    if (err?.name !== "AbortError") toast("Could not share the link.");
  }
}

export function bindCopyButtons(root) {
  root.querySelectorAll("[data-copy]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const val = btn.dataset.copy;
      try {
        await navigator.clipboard.writeText(val);
        const prev = btn.innerHTML;
        btn.classList.add("copied");
        btn.innerHTML = ICON.check;
        setTimeout(() => {
          btn.classList.remove("copied");
          btn.innerHTML = prev;
        }, 1200);
      } catch {
        toast("Could not copy to clipboard.");
      }
    });
  });
}

/**
 * The wallet balance as every surface shows it: "$12.34", "…" while it
 * loads, "—" with no wallet. `bare` drops the "$" for a surface that prints
 * its own unit.
 */
export function balanceText({ bare = false } = {}) {
  if (!getUser()?.circle?.walletAddress) return "—";
  if (WALLET_ONCHAIN_BALANCE == null) return "…";
  const n = Number(WALLET_ONCHAIN_BALANCE).toFixed(2);
  return bare ? n : `$${n}`;
}

/**
 * Repaint every balance on screen: each `[data-wallet-balance]` element
 * (`data-wallet-balance="bare"` for no "$"), and the header chip's empty
 * state. Surfaces rendered later call balanceText() themselves.
 */
export function paintWalletBalance() {
  $$("[data-wallet-balance]").forEach((el) => {
    el.textContent = balanceText({ bare: el.dataset.walletBalance === "bare" });
  });
  const chip = $("#wallet-chip");
  if (!chip) return;
  const hasWallet = Boolean(getUser()?.circle?.walletAddress);
  chip.classList.toggle("wallet-chip-empty", !hasWallet);
  if (!hasWallet) $("#wallet-chip-amount").textContent = "Set up wallet";
  chip.title = hasWallet ? "Wallet balance" : "Set up your wallet to pay for events and get paid";
}

export async function refreshWalletOnchain() {
  const addr = getUser()?.circle?.walletAddress;
  WALLET_ONCHAIN_BALANCE = null;
  if (addr) {
    try {
      const r = await circleSdk.fetchWalletUsdcBalance(addr);
      WALLET_ONCHAIN_BALANCE = r.ok ? r.balance : null;
    } catch (err) {
      console.warn("[app] fetchWalletUsdcBalance failed:", err);
    }
  }
  paintWalletBalance();
  return WALLET_ONCHAIN_BALANCE;
}

/**
 * A short message at the bottom of the screen. With `action`
 * ({ label, onClick }) it gets a button and stays up longer.
 */
export function toast(msg, { action } = {}) {
  let container = document.getElementById("app-toasts");
  if (!container) {
    container = document.createElement("div");
    container.id = "app-toasts";
    container.className = "app-toasts";
    document.body.appendChild(container);
  }
  const item = document.createElement("div");
  item.className = "app-toast";
  const text = document.createElement("span");
  text.textContent = msg;
  item.appendChild(text);
  if (action) {
    item.classList.add("app-toast-action");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = action.label;
    btn.addEventListener("click", () => { action.onClick(); item.remove(); });
    item.appendChild(btn);
  }
  container.appendChild(item);
  const life = action ? 8000 : 3200;
  setTimeout(() => item.classList.add("app-toast-out"), life);
  setTimeout(() => item.remove(), life + 600);
}

// ── sheets ────────────────────────────────────────────────────────────

/**
 * A modal sheet: a centred card on desktop, full-screen on phones (see
 * .sheet in styles.css). Closes on Escape, the scrim, the X button, and
 * navigation (app.js removes every .sheet on route change).
 *
 * `bottom` makes it a bottom sheet on phones (a grab handle that drags it
 * closed, the page visible above it) with the close button on the right;
 * game sheets use it. `footer` adds a strip pinned under the scrolling body
 * for the sheet's main button, returned as `foot`. `drawer` docks it to the
 * right edge on desktop instead of centring it. ⌘/Ctrl+Enter clicks the
 * footer's `[data-primary]` button. `onClose` runs once however it closes.
 */
export function openSheet({ id, title, className = "", bottom = false, footer = false, drawer = false, onClose = null }) {
  document.getElementById(id)?.remove();
  const sheet = document.createElement("div");
  sheet.className = ["sheet", className, bottom && "sheet-bottom", footer && "sheet-has-foot", drawer && "sheet-drawer"]
    .filter(Boolean).join(" ");
  sheet.id = id;
  sheet.innerHTML = `
    <div class="sheet-scrim"></div>
    <div class="sheet-panel" role="dialog" aria-modal="true">
      ${bottom ? `<div class="sheet-grab" aria-hidden="true"></div>` : ""}
      <div class="sheet-head">
        <button class="icon-btn" data-close aria-label="Close">${ICON.close}</button>
        <span class="sheet-title"></span>
      </div>
      <div class="sheet-body"></div>
      ${footer ? `<div class="sheet-foot"></div>` : ""}
    </div>`;
  sheet.querySelector(".sheet-title").textContent = title;
  sheet.querySelector(".sheet-panel").setAttribute("aria-label", title);
  document.body.appendChild(sheet);
  document.body.classList.add("sheet-open");

  const onKey = (e) => {
    if (sheet !== [...document.querySelectorAll(".sheet")].pop()) return; // only the top sheet answers
    if (e.key === "Escape") close();
    else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      const main = sheet.querySelector(".sheet-foot [data-primary]:not(:disabled)");
      if (main) { e.preventDefault(); main.click(); }
    }
  };
  function close() {
    if (!sheet.isConnected) return;
    sheet.remove();
    onClose?.();
    if (!document.querySelector(".sheet")) document.body.classList.remove("sheet-open");
    document.removeEventListener("keydown", onKey);
  }
  document.addEventListener("keydown", onKey);
  sheet.querySelector(".sheet-scrim").addEventListener("click", close);
  sheet.querySelector("[data-close]").addEventListener("click", close);
  if (bottom) dragToClose(sheet, close);
  return { sheet, body: sheet.querySelector(".sheet-body"), foot: sheet.querySelector(".sheet-foot"), close };
}

/**
 * Ask before something that can't be undone, in the app's own sheet rather
 * than the browser's confirm(). Resolves true for `yes`, false however else
 * it closes.
 */
export function confirmSheet({ title, text, yes, no = "Keep it", danger = true }) {
  return new Promise((resolve) => {
    let answer = false;
    const { body, foot, close } = openSheet({
      id: "confirm-sheet", title, className: "sheet-game sheet-small", bottom: true, footer: true,
      onClose: () => resolve(answer),
    });
    body.innerHTML = `<p class="confirm-text"></p>`;
    body.querySelector(".confirm-text").textContent = text;
    foot.innerHTML = `<div class="gs-foot-row">
      <button type="button" class="btn-game btn-game-ghost" data-no></button>
      <button type="button" class="btn-game${danger ? " btn-game-bad" : ""}" data-yes data-primary></button></div>`;
    foot.querySelector("[data-no]").textContent = no;
    foot.querySelector("[data-yes]").textContent = yes;
    foot.querySelector("[data-no]").addEventListener("click", close);
    foot.querySelector("[data-yes]").addEventListener("click", () => { answer = true; close(); });
  });
}

/** Drag a bottom sheet down by its handle or header; past a third of its height it closes. */
function dragToClose(sheet, close) {
  const panel = sheet.querySelector(".sheet-panel");
  let startY = null;
  const grips = [sheet.querySelector(".sheet-grab"), sheet.querySelector(".sheet-head")];
  for (const g of grips) {
    g.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button") || !matchMedia("(max-width: 760px)").matches) return;
      startY = e.clientY;
      panel.style.transition = "none";
      g.setPointerCapture(e.pointerId);
    });
    g.addEventListener("pointermove", (e) => {
      if (startY === null) return;
      panel.style.transform = `translateY(${Math.max(0, e.clientY - startY)}px)`;
    });
    const end = (e) => {
      if (startY === null) return;
      const moved = e.clientY - startY;
      startY = null;
      panel.style.transition = "";
      if (moved > panel.offsetHeight / 3) close();
      else panel.style.transform = "";
    };
    g.addEventListener("pointerup", end);
    g.addEventListener("pointercancel", end);
  }
}
