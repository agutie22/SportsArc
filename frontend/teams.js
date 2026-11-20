/**
 * Team colors: the app wears the colors of the team a person picked
 * (college football for now, GET /api/teams, saved as teamKey through
 * PATCH /api/profile).
 *
 * A team brings two colors. Neither is safe to paint as-is: Michigan's
 * navy disappears on the dark theme, a white second color says nothing.
 * So for each theme this picks the color that reads on that background
 * (the second one when the first fails and it is a real color), nudges it
 * lighter or darker until it does, and derives the text and on-fill
 * colors from it. The result is set as --tm-* variables beside a
 * data-team attribute, and styles.css maps them onto the accent tokens,
 * so every component that uses --accent turns burnt orange for free.
 *
 *   applyTeam(team)    the signed-in person's team (null: SportsArc lime)
 *   previewTeam(team)  paint without keeping it (signup, the editor)
 *   restoreTeam()      back to the applied team after a preview
 *   teamPicker(el, …)  search + list, used by signup and the editor
 *
 * The last team is cached in this browser only so a reload paints it
 * before /api/auth/me answers; the account is the record.
 */

import { apiGet, esc } from "./api.js";

const CACHE_KEY = "sportsarc_team";

/*
 * The backgrounds the accent sits on, for contrast math only. These mirror
 * --bg-base and --bg-card in styles.css for each theme; nothing is painted
 * with them.
 */
const BG = {
  d: { base: "#08090b", card: "#101215" },
  l: { base: "#f4f5f7", card: "#ffffff" },
};
/** WCAG: 3 for a fill against the page, 4.5 for text. */
const FILL_MIN = 3;
const TEXT_MIN = 4.5;

// ── color math ─────────────────────────────────────────────────────────

const rgbOf = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
const hexOf = (rgb) => `#${rgb.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0")).join("")}`;

function luminance(hex) {
  const [r, g, b] = rgbOf(hex).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function hslOf(hex) {
  const [r, g, b] = rgbOf(hex);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}

function hexOfHsl([h, s, l]) {
  if (s === 0) return hexOf([l, l, l]);
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const ch = (t) => {
    const u = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if (u < 1 / 6) return p + (q - p) * 6 * u;
    if (u < 1 / 2) return q;
    if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6;
    return p;
  };
  return hexOf([ch(h + 1 / 3), ch(h), ch(h - 1 / 3)]);
}

/** Step the lightness toward readable (up on dark, down on light) until it clears `min`. */
function nudge(hex, bg, min, lighter) {
  let [h, s, l] = hslOf(hex);
  let out = hex;
  for (let i = 0; i < 25 && contrast(out, bg) < min; i++) {
    l = Math.min(1, Math.max(0, l + (lighter ? 0.04 : -0.04)));
    out = hexOfHsl([h, s, l]);
  }
  return out;
}

/** A second color worth wearing: not white, black or grey. */
const chromatic = (hex) => {
  const [, s, l] = hslOf(hex);
  return s > 0.25 && l > 0.08 && l < 0.92;
};

/** One theme's accent set from a team's two colors. */
export function paletteFor(team, theme) {
  const bg = BG[theme];
  const lighter = theme === "d";
  const options = [team.color, team.alt].filter((c, i) => c && (i === 0 || chromatic(c)));
  const fill = options.find((c) => contrast(c, bg.base) >= FILL_MIN) ?? nudge(team.color, bg.base, FILL_MIN, lighter);
  const [h, s, l] = hslOf(fill);
  return {
    fill,
    hi: hexOfHsl([h, s, Math.min(1, l + 0.08)]),
    ink: nudge(fill, bg.card, TEXT_MIN, lighter),
    on: contrast(fill, "#000000") >= contrast(fill, "#ffffff") ? "#000000" : "#ffffff",
  };
}

// ── painting ───────────────────────────────────────────────────────────

const VARS = ["fill", "hi", "ink", "on"];
let current = null;

function paint(el, team) {
  if (!team?.color) {
    delete el.dataset.team;
    for (const t of ["d", "l"]) for (const v of VARS) el.style.removeProperty(`--tm-${t}-${v}`);
    return;
  }
  el.dataset.team = team.key;
  for (const t of ["d", "l"]) {
    const p = paletteFor(team, t);
    for (const v of VARS) el.style.setProperty(`--tm-${t}-${v}`, p[v]);
  }
}

export function applyTeam(team) {
  current = team?.color ? team : null;
  paint(document.documentElement, current);
  try {
    if (current) localStorage.setItem(CACHE_KEY, JSON.stringify(current));
    else localStorage.removeItem(CACHE_KEY);
  } catch { /* first-paint nicety only */ }
}

export const previewTeam = (team) => paint(document.documentElement, team);
export const restoreTeam = () => paint(document.documentElement, current);
export const appliedTeam = () => current;

// A reload paints the last team before the account answers.
try {
  const cached = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null");
  if (cached?.key && /^#[0-9a-f]{6}$/.test(cached.color ?? "")) {
    current = cached;
    paint(document.documentElement, cached);
  }
} catch { /* nothing cached */ }

// ── picker ─────────────────────────────────────────────────────────────

const swatch = (t) =>
  `<span class="tp-dots" aria-hidden="true"><span style="background:${esc(t.color)}"></span>${t.alt ? `<span style="background:${esc(t.alt)}"></span>` : ""}</span>`;

const logo = (t) => t.logo
  ? `<img class="tp-logo" src="${esc(t.logo)}" alt="" loading="lazy" width="28" height="28">`
  : `<span class="tp-logo tp-logo-empty" aria-hidden="true"></span>`;

/**
 * Search box and team list in `host`. `onPick(team | null)` runs on every
 * tap; `allowNone` adds a "No team" row (the editor). The list keeps its
 * own state on `host`, so two pickers never share it.
 */
export function teamPicker(host, { selected = null, onPick, allowNone = false }) {
  const s = { key: selected?.key ?? null, teams: [], seq: 0, timer: 0 };
  host.innerHTML = `
    <div class="tp">
      <input class="input tp-search" type="search" placeholder="Search college teams" aria-label="Search college teams"
             autocomplete="off" spellcheck="false" enterkeyhint="search">
      <div class="tp-list" role="listbox" aria-label="Teams"></div>
    </div>`;
  const input = host.querySelector(".tp-search");
  const list = host.querySelector(".tp-list");

  const row = (t) => `
    <button type="button" class="tp-row" role="option" data-key="${esc(t.key)}" aria-selected="${t.key === s.key}">
      ${logo(t)}<span class="tp-name">${esc(t.name)}</span>${swatch(t)}
    </button>`;

  const draw = () => {
    const pinned = selected && !s.teams.some((t) => t.key === selected.key) && !input.value.trim() ? [selected] : [];
    const none = allowNone ? `
      <button type="button" class="tp-row" role="option" data-key="" aria-selected="${s.key === null}">
        <span class="tp-logo tp-logo-empty" aria-hidden="true"></span><span class="tp-name">No team · SportsArc colors</span>
      </button>` : "";
    const rows = [...pinned, ...s.teams].map(row).join("");
    list.innerHTML = none + (rows || `<div class="tp-empty">No teams match.</div>`);
  };

  const load = async () => {
    const seq = ++s.seq;
    let teams = [];
    try { teams = (await apiGet("/api/teams", { q: input.value.trim() })).teams ?? []; } catch { teams = []; }
    if (seq !== s.seq || !host.isConnected) return;
    s.teams = teams;
    draw();
  };

  // Inside the profile form, Enter in the search box must not submit the form.
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") e.preventDefault(); });
  input.addEventListener("input", () => {
    clearTimeout(s.timer);
    s.timer = setTimeout(() => void load(), 150);
  });
  list.addEventListener("click", (e) => {
    const btn = e.target.closest(".tp-row");
    if (!btn) return;
    const key = btn.dataset.key || null;
    const team = key ? [...s.teams, selected].find((t) => t?.key === key) ?? null : null;
    s.key = key;
    if (team) selected = team;
    list.querySelectorAll(".tp-row").forEach((r) => r.setAttribute("aria-selected", String((r.dataset.key || null) === key)));
    onPick?.(team);
  });

  draw();
  void load();
}
