/**
 * Renders the verified record's receipts and game-sheet lines with the real
 * frontend/record.js, in every state, into one self-contained page:
 *
 *   node scripts/record-previews.mjs [out.html]
 *
 * Default output: docs/verified-record/previews.html. The page inlines
 * frontend/styles.css, so it looks like the app and opens from disk. Rerun
 * it after changing record.js or the receipt's styles; it never drifts from
 * the code because it is the code. Nothing here touches a server or a chain:
 * the games and the network's answers below are examples.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.argv[2] ?? join(ROOT, "docs", "verified-record", "previews.html");

// ── just enough browser for record.js to load ─────────────────────────
const noop = () => {};
const el = new Proxy(function () {}, { get: (_t, k) => (k === Symbol.toPrimitive ? () => "" : el), apply: () => el, construct: () => el });
Object.assign(globalThis, {
  window: globalThis,
  document: el,
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  location: { origin: "https://sportsarc.app", pathname: "/", hash: "" },
  addEventListener: noop,
  matchMedia: () => ({ matches: false, addEventListener: noop }),
  fetch: async (url) => ({
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    json: async () => (String(url).includes("/api/config") ? { ok: true, config: { explorerUrl: "https://explorer.testnet.arc.io" } } : { ok: true }),
  }),
});

const shared = await import(join(ROOT, "frontend", "shared.js"));
const record = await import(join(ROOT, "frontend", "record.js"));
await shared.loadPublicConfig();

// ── example games, in the shapes the API returns ──────────────────────
const MAYA = { id: "0d6f4a1e-7c2b-4f3a-9e8d-1a2b3c4d5e6f", name: "Maya Ortiz", role: "player" };
const VIEWER = { id: "5e4d3c2b-1a09-4f8e-8d7c-6b5a49382716", name: "Sam Lee" };
const chain = { id: 5042002, name: "Arc Testnet", rpcUrl: "https://rpc.testnet.arc.io", contract: "0x869517905F662957da7d59E696FdC613e09798cd", writer: "0x8D65A3E484Ac3fa3F9B3bA7a45026AF3fB21AB9C" };
const h = (n) => `0x${n.repeat(64 / n.length)}`;
const base = {
  sport: "basketball", venueName: "Dolores Park Courts", startsAt: "2026-11-18T02:00:00Z",
  closedAt: "2026-11-18T02:15:00Z", chainId: chain.id, contract: chain.contract, blockNumber: 73074874,
  host: { id: MAYA.id, name: MAYA.name },
};
const checkedIn = {
  ...base, kind: "checkin", hash: h("5493ac0c"), txHash: h("8be1d2f0"), at: "2026-11-18T01:52:00Z", recordedAt: "2026-11-18T02:16:10Z",
  result: {
    hash: h("cd19c165"), txHash: h("d278ba85"), recordedAt: "2026-11-18T04:11:00Z", forThem: "won", side: 1, winningSide: 1,
    finalAt: "2026-11-18T04:10:00Z", recordedByHost: true, recordedBy: null,
  },
  gameRecord: { hash: h("88b76f03"), txHash: h("89a8ee9c"), recordedAt: "2026-11-18T02:16:08Z" },
  presence: { hash: h("a14f550b"), txHash: h("6b34b0f9"), recordedAt: "2026-11-18T03:31:00Z", present: true, finalAt: "2026-11-18T03:30:00Z" },
};
const missed = { ...base, kind: "missed", hash: h("01efdf18"), txHash: h("5e526544"), at: base.closedAt, recordedAt: "2026-11-18T02:16:12Z", result: null, gameRecord: checkedIn.gameRecord };
const writing = { ...checkedIn, recordedAt: null, txHash: null, result: null, gameRecord: null, at: "2026-11-20T01:57:00Z", startsAt: "2026-11-20T02:00:00Z" };
const all = { main: "2026-11-18T02:16:10Z", presence: "2026-11-18T03:31:00Z", result: "2026-11-18T04:11:00Z", game: "2026-11-18T02:16:08Z" };

const receipts = [
  ["Checked in, with the result", "A friend's receipt, on their record page.", checkedIn, { player: MAYA, answers: all }],
  ["Your own receipt", "On your record, who recorded the result is named.", { ...checkedIn, result: { ...checkedIn.result, recordedBy: { id: MAYA.id, name: "Jordan Park" }, recordedByHost: false, forThem: "lost" } }, { player: VIEWER, answers: all, me: VIEWER }],
  ["Missed", "Neutral: a missed game is a fact on the record too.", missed, { player: MAYA, answers: { main: missed.recordedAt, game: all.game } }],
  ["The host disagrees", "No check-in, but the host confirmed they were there. Both stay on the record.", { ...missed, presence: checkedIn.presence }, { player: MAYA, answers: { main: missed.recordedAt, presence: all.presence, game: all.game } }],
  ["Checking", "The moment the receipt opens, before the network answers.", checkedIn, { player: MAYA, answers: {} }],
  ["Being written", "Check-in closed a minute ago.", writing, { player: VIEWER, answers: {}, me: VIEWER }],
  ["Doesn't match", "The network has no entry for the result.", checkedIn, { player: MAYA, answers: { ...all, result: false } }],
  ["A bare link (#/verify/&lt;id&gt;)", "Opens signed out: one entry, no names.", { kind: "result", hash: checkedIn.result.hash, txHash: checkedIn.result.txHash, chainId: chain.id, contract: chain.contract, recordedAt: checkedIn.result.recordedAt }, { answers: { main: checkedIn.result.recordedAt }, signedOut: true }],
];

const lines = [
  ["Checked in, before close", { state: "waiting", checkedIn: true, closesAt: "2026-11-20T02:15:00Z" }],
  ["Being verified", { state: "verifying", checkedIn: true, withinMin: 2 }],
  ["Verified", { state: "verified", checkedIn: true, game: checkedIn }],
  ["Missed", { state: "missed", checkedIn: false, game: missed }],
];

const render = (g, o) => {
  shared.setUser(o.signedOut ? null : o.me ?? VIEWER);
  return record.receiptMarkup(g, { player: o.player, chain, answers: o.answers, via: "phone" });
};
const card = (title, note, inner) => `
  <section class="pv-case"><h2>${title}</h2><p>${note}</p>
    <div class="pv-panel"><div class="sheet-head"><span class="sheet-title">Receipt</span></div><div class="sheet-body">${inner}</div></div>
  </section>`;

const css = readFileSync(join(ROOT, "frontend", "styles.css"), "utf8");
const light = css.match(/:root\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>SportsArc Record Receipts</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=Barlow+Condensed:wght@600;700&display=swap" rel="stylesheet">
<style>
${css}
@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) {${light} color-scheme: light; } }
:root { color-scheme: dark; }
:root[data-theme="light"] { color-scheme: light; }
body { background: var(--bg-base); color: var(--text); margin: 0; }
.pv { max-width: 1280px; margin: 0 auto; padding-block: 32px 80px; padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); }
.pv header { display: flex; flex-wrap: wrap; gap: 12px; align-items: baseline; justify-content: space-between; }
.pv h1 { font-family: var(--font-head); font-size: 40px; line-height: 1; }
.pv-lede { color: var(--text-muted); max-width: 680px; line-height: 1.5; margin: 8px 0 28px; }
.pv-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(380px, 100%), 1fr)); gap: 24px; align-items: start; }
.pv-case { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.pv-case h2 { font-size: 13px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; color: var(--text-dim); }
.pv-case p { font-size: 13px; color: var(--text-muted); }
.pv-panel { background: var(--bg-card); border: 1px solid var(--border-hover); border-radius: var(--radius-xl); overflow: hidden; min-width: 0; }
.pv-panel .sheet-head { position: static; padding-left: 16px; }
.pv-toggle { font: inherit; font-size: 13px; font-weight: 700; padding: 8px 14px; border-radius: var(--radius-pill); border: 1px solid var(--border-hover); background: var(--bg-surface); color: var(--text); cursor: pointer; }
.pv-section { margin: 40px 0 12px; font-family: var(--font-head); font-size: 24px; }
</style>
</head>
<body>
<main class="pv">
  <header><h1>Record receipts</h1><button class="pv-toggle" type="button" id="theme-toggle">Light / dark</button></header>
  <p class="pv-lede">Rendered by frontend/record.js (scripts/record-previews.mjs). Each row is one entry on the public record; the tick is the network's own answer for it, asked from the viewer's phone. Example games.</p>
  <div class="pv-grid">${receipts.map(([t, n, g, o]) => card(t, n, render(g, o))).join("")}</div>
  <h2 class="pv-section">On the game sheet</h2>
  <div class="pv-grid">${lines.map(([t, r]) => `<section class="pv-case"><h2>${t}</h2><div class="pv-panel"><div class="sheet-body">${record.gameRecordLine(r)}</div></div></section>`).join("")}</div>
</main>
<script>
document.getElementById("theme-toggle").addEventListener("click", () => {
  const root = document.documentElement;
  const now = root.dataset.theme || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  root.dataset.theme = now === "light" ? "dark" : "light";
});
</script>
</body>
</html>
`;
writeFileSync(OUT, page);
console.log(`wrote ${OUT}`);
