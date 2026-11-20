/**
 * The game recap card — a result slip in the spirit of a prediction-market
 * cash-out card: one big number in the accent color, the event, a
 * start → end row, and a share button that exports the card as an image.
 *
 * Once the host has recorded the result (see results.ts), it takes the hero
 * slot: the score when one was given, otherwise the outcome in words. Until
 * then the big number is personal when you played ("+1") and the turnout
 * when you didn't. The button follows `resultStatus` and the viewer: the
 * host or a co-host gets "Record result", a player who checked in sees who
 * it is waiting on, and once recorded anyone can open "Results". Whatever
 * the result sheet (results.js) changes, the card fetches itself again.
 *
 * The card stays dark in light mode on purpose: it is also the image
 * people post elsewhere, and a share card should look the same everywhere.
 * The "N checked in" pill opens "Who showed up": who checked in and how a
 * check-in becomes verified on their record. The share image does not.
 *
 * Words: a check-in confirmed at the venue is "checked in". Only a
 * check-in on the public record is "verified" (record.js), and the sheet
 * says so only when the payload counts it there. The host "records" the
 * result; it is "recorded" while it can be fixed, then "final".
 */

import { toast, ICON, openSheet, getUser } from "./shared.js";
import { apiGet, clockText, esc, firstName, titleCase, sportIcon, avatar, personLink } from "./api.js";
import { openResultSheet, outcomeLabel, scoreLabel } from "./results.js";

const day = (iso) => new Date(iso).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
const dur = (m) => (m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m / 60}h`).replace(/^0h /, "");
const sideName = (i) => `Side ${i === 1 ? "B" : "A"}`;
/** "Maya" from "Maya Chen". */

/** Recap posts rendered this session, by post id: the sheet, share and refresh read them. */
const CARDS = new Map();

/** "Recorded by you", "Recorded by Maya (host)", "Recorded by Sam (co-host)". */
function recorderText(r) {
  const by = r.result.recordedBy;
  if (!by) return "Recorded by the host";
  if (by.id === getUser()?.id) return "Recorded by you";
  return `Recorded by ${firstName(by.name, "the host")} (${by.id === r.host?.id ? "host" : "co-host"})`;
}

/** The recorded result as the hero: your own result first, the score if given. */
function resultHero(r) {
  const res = r.result;
  const score = scoreLabel(res.score);
  const word = outcomeLabel(res.outcome, res.winningSide);
  const onSide = res.yourSide === 0 || res.yourSide === 1;
  const satOut = res.seated && !onSide && res.outcome !== "not_played";

  let label = score ? word : "Final result";
  let value = score || word;
  if (onSide && res.outcome === "win") {
    const won = res.yourSide === res.winningSide;
    label = `You ${won ? "won" : "lost"} · ${sideName(res.yourSide)}`;
    if (!score) { label = sideName(res.yourSide); value = won ? "Won" : "Lost"; }
  } else if (res.outcome === "draw") {
    label = score ? "Draw" : "Final result";
  }

  const sub = [
    recorderText(r),
    satOut ? "you sat out" : "",
    r.you ? `game ${r.you.gameNumber} on your record` : "",
  ].filter(Boolean).join(" · ");
  return {
    label,
    value,
    count: null,
    word: !score,
    sub,
    chip: res.correctUntil ? `Host can fix it until ${clockText(res.correctUntil)}` : "",
  };
}

function heroFor(r) {
  if (r.result) return resultHero(r);
  const pending = r.resultStatus === "locked" ? "Result not recorded yet" : "";
  if (r.you) {
    return { label: "You played", value: "+1", count: null, sub: `Game ${r.you.gameNumber} on your record`, chip: pending };
  }
  return {
    label: "Showed up",
    value: String(r.verifiedCount),
    count: r.verifiedCount,
    sub: `of ${r.rosterCount} who signed up checked in at the venue`,
    chip: "",
  };
}

/** Three cells under the times. Turnout is never shown twice. */
function statCells(r) {
  const cell = (k, v) => `<div><span>${esc(k)}</span>${v}</div>`;
  const showed = cell("Showed up", `<strong>${r.verifiedCount}<small> of ${r.rosterCount}</small></strong>`);
  const played = cell("Played", `<strong>${esc(dur(r.durationMinutes))}</strong>`);
  const host = cell("Host", r.host?.id
    ? personLink(r.host, { label: firstName(r.host.name, "—") })
    : `<strong>${esc(firstName(r.host?.name, "—"))}</strong>`);
  const rank = r.you?.venueRank;
  const third = rank
    ? cell("Your rank here", `<strong class="recap-up">#${rank.rank}<small> of ${rank.of}</small></strong>`)
    : host;
  // The turnout is already the hero: say where the result stands instead.
  if (!r.result && !r.you) {
    const where = r.resultStatus === "locked" ? "Pending" : "None";
    return [played, cell("Result", `<strong>${where}</strong>`), host].join("");
  }
  return [showed, played, third].join("");
}

export function recapCard(post) {
  CARDS.set(post.id, post);
  const r = post.recap;
  const hero = heroFor(r);
  const extra = r.verifiedCount - Math.min(6, r.roster.length);

  return `
    <div class="recap" data-recap="${esc(post.id)}">
      <div class="recap-top">
        <span class="recap-brand"><span class="recap-mark">${ICON.arrowRight}</span>SPORTSARC</span>
        <button type="button" class="recap-tag" data-recapverified="${esc(post.id)}"
          aria-label="Who showed up: ${r.verifiedCount} checked in">${ICON.pin}${r.verifiedCount} checked in<span class="recap-tag-chev" aria-hidden="true">›</span></button>
      </div>

      <div class="recap-event">
        <span class="recap-sport">${sportIcon(r.sport)} ${esc(titleCase(r.sport))} · ${esc(day(r.startsAt))}</span>
        <button class="recap-title" data-venue="${esc(r.venueId)}">${esc(r.venueName)}</button>
      </div>

      <div class="recap-hero">
        <span class="recap-hero-label">${esc(hero.label)}</span>
        <strong class="recap-hero-num${hero.word ? " recap-hero-word" : ""}" ${hero.count != null ? `data-count="${hero.count}"` : ""}>${esc(hero.value)}</strong>
        <span class="recap-hero-sub">${esc(hero.sub)}</span>
        ${hero.chip ? `<span class="recap-chip">${esc(hero.chip)}</span>` : ""}
      </div>

      <div class="recap-perf" aria-hidden="true"></div>

      <div class="recap-leg">
        <div><span>Start</span><strong>${esc(clockText(r.startsAt))}</strong></div>
        <span class="recap-arrow">${ICON.arrowRight}</span>
        <div><span>End</span><strong>${esc(clockText(r.endsAt))}</strong></div>
      </div>
      <div class="recap-stats">${statCells(r)}</div>

      <div class="recap-foot">
        <div class="recap-roster">
          ${r.roster.slice(0, 6).map((p) => avatar(p, "xs", { href: `#/u/${p.id}` })).join("")}
          ${extra > 0 ? `<span class="recap-more">+${extra}</span>` : ""}
        </div>
        <div class="recap-btns">
        ${resultButton(post)}
        <button class="recap-share" data-recapshare="${esc(post.id)}">${ICON.share}<span>Share</span></button>
        </div>
      </div>
    </div>`;
}

/**
 * "Who showed up": the count, who checked in, and how a check-in reaches
 * the record. Step two appears only when this server writes the public
 * record, and says "verified" only for check-ins counted there.
 */
export function openVerifiedSheet(postId) {
  const r = CARDS.get(postId)?.recap;
  if (!r) return;
  const me = getUser()?.id;
  const shown = r.roster ?? [];
  const extra = r.verifiedCount - shown.length;
  const where = esc(r.venueName ?? "the venue");
  const tag = (p) => {
    if (p.id && p.id === me) return `<span class="res-you">You</span>`;
    if (p.id && p.id === r.host?.id) return `<span class="res-you res-host">Host</span>`;
    return "";
  };

  const rec = r.record ?? { verified: 0, writing: false, everyMin: 0 };
  const forGood = "After that nobody can change them, not even SportsArc.";
  let second = "";
  if (r.verifiedCount > 0 && rec.verified >= r.verifiedCount) {
    second = `<li class="recap-step is-done"><i>${ICON.check}</i><span><b>Verified.</b> Every check-in here is on the public record. ${forGood}</span></li>`;
  } else if (rec.verified > 0) {
    second = `<li class="recap-step"><i>2</i><span><b>${rec.verified} of ${r.verifiedCount} verified.</b>
      The rest go on the public record within about ${rec.everyMin} minutes. ${forGood}</span></li>`;
  } else if (rec.writing) {
    second = `<li class="recap-step"><i>2</i><span><b>Being verified.</b> SportsArc adds check-ins to a public record
      every ${rec.everyMin} minutes. ${forGood}</span></li>`;
  }

  const { body } = openSheet({ id: "verified-recap", title: "Who showed up", className: "sheet-result" });
  body.innerHTML = `
    <div class="recap-summary"><strong>${r.verifiedCount} of ${r.rosterCount}</strong><span>checked in at ${where}</span></div>
    ${shown.length || extra > 0 ? `<ul class="res-list">
      ${shown.map((p) => `<li class="res-player">
        ${avatar(p, "xs", { href: p.id ? `#/u/${p.id}` : "" })}
        <span class="res-player-name">${personLink(p)}</span>
        ${tag(p)}
      </li>`).join("")}
      ${extra > 0 ? `<li class="res-player"><span class="res-player-name res-more">+${extra} more</span></li>` : ""}
    </ul>` : ""}
    <h5 class="res-label">How it reaches ${r.you ? "your" : "their"} record</h5>
    <ol class="recap-steps">
      <li class="recap-step is-done"><i>${ICON.check}</i><span><b>Checked in at the venue.</b>
        Each phone was inside the venue's boundary when they tapped Check in.</span></li>
      ${second}
    </ol>
    ${r.you ? `<a class="btn-game btn-game-ghost recap-record-link" href="#/record">See your record</a>` : ""}`;
}

/**
 * The result button. The host or a co-host records; a player who checked
 * in sees who it waits on; once recorded anyone can open the result.
 */
function resultButton(post) {
  const r = post.recap;
  const gameId = post.game?.id;
  if (!r.resultStatus || !gameId) return "";
  const btn = (cls, label) => `<button class="recap-result${cls}" data-recapresult="${esc(gameId)}">${esc(label)}</button>`;
  if (r.resultStatus === "locked") {
    if (r.viewer?.canRecord) return btn(" is-due", "Record result");
    if (r.you) return btn(" is-wait", `Waiting on ${firstName(r.host?.name, "the host")}`);
    return "";
  }
  return btn("", "Results");
}

/** Fetch one recap post again and redraw every copy of its card on the page. */
async function refreshRecap(postId) {
  if (!postId) return;
  try {
    const { post } = await apiGet(`/api/posts/${postId}`);
    if (!post?.recap) return;
    const html = recapCard(post);
    for (const el of document.querySelectorAll(`[data-recap="${CSS.escape(postId)}"]`)) el.outerHTML = html;
  } catch { /* the card stays as it was; the next feed load has it */ }
}

/** One listener for every recap's Result button, wherever the card is rendered. */
let resultClicks = false;
function bindResultButtons() {
  if (resultClicks) return;
  resultClicks = true;
  document.addEventListener("click", (e) => {
    const b = e.target.closest?.("[data-recapresult]");
    if (!b) return;
    const postId = b.closest("[data-recap]")?.dataset.recap;
    void openResultSheet(b.dataset.recapresult, {
      onChange: () => refreshRecap(postId),
      onShare: postId ? async () => { await refreshRecap(postId); await shareRecap(postId); } : undefined,
    });
  });
}

// ── motion ────────────────────────────────────────────────────────────

const counted = new WeakSet();
let observer = null;

/** Count the hero number up the first time a card scrolls into view. */
export function animateRecaps(root) {
  bindResultButtons();
  const nums = root.querySelectorAll(".recap-hero-num");
  if (!nums.length) return;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!observer) {
    observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting || counted.has(e.target)) continue;
        counted.add(e.target);
        observer.unobserve(e.target);
        const el = e.target;
        el.classList.add("recap-pop");
        const target = Number(el.dataset.count);
        if (!Number.isFinite(target) || target <= 1) continue;
        const t0 = performance.now();
        const step = (t) => {
          const k = Math.min(1, (t - t0) / 900);
          el.textContent = String(Math.round(target * (1 - Math.pow(1 - k, 3))));
          if (k < 1) window.requestAnimationFrame(step);
        };
        window.requestAnimationFrame(step);
      }
    }, { threshold: 0.5 });
  }
  nums.forEach((n) => { if (!reduce && !counted.has(n)) observer.observe(n); });
}

// ── share as image ────────────────────────────────────────────────────

const W = 1080, H = 1350;
const C = {
  bg: "#0A0C08", accent: "", line: "",
  text: "#F3F5F7", muted: "#A3AAB6", dim: "#6C7380", panel: "#14170F",
};

/**
 * The image's accent: the card's own (--accent-on-dark, so a picked team's
 * color, teams.js), as hex, and that color at an alpha for glows.
 */
function accentNow() {
  const v = getComputedStyle(document.documentElement).getPropertyValue("--accent-on-dark").trim();
  return /^#[0-9a-f]{6}$/i.test(v) ? v : "#C6F432";
}
const alpha = (hex, a) => `rgba(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(",")},${a})`;

function loadImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

async function drawCard(post) {
  const r = post.recap;
  const hero = heroFor(r);
  await Promise.all([
    document.fonts.load('700 280px "Barlow Condensed"'),
    document.fonts.load('800 40px "Inter"'),
  ]).catch(() => {});

  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const g = cv.getContext("2d");
  C.accent = accentNow();
  C.line = alpha(C.accent, 0.22);

  g.fillStyle = C.bg;
  g.fillRect(0, 0, W, H);
  const glow = g.createRadialGradient(W * 0.85, 120, 40, W * 0.85, 120, 900);
  glow.addColorStop(0, alpha(C.accent, 0.28));
  glow.addColorStop(1, alpha(C.accent, 0));
  g.fillStyle = glow;
  g.fillRect(0, 0, W, H);
  g.strokeStyle = "rgba(255,255,255,.035)";
  g.lineWidth = 2;
  for (let x = -H; x < W; x += 48) { g.beginPath(); g.moveTo(x, H); g.lineTo(x + H, 0); g.stroke(); }

  const L = 90;
  g.textBaseline = "alphabetic";
  g.fillStyle = C.accent;
  g.beginPath(); g.roundRect(L, 90, 56, 56, 16); g.fill();
  g.fillStyle = C.bg;
  g.font = '800 34px "Inter"';
  g.fillText("↗", L + 12, 131);
  g.fillStyle = C.text;
  g.font = '700 46px "Barlow Condensed"';
  g.fillText("SPORTSARC", L + 76, 134);
  g.font = '700 30px "Inter"';
  g.fillStyle = C.accent;
  const tag = r.result ? "✓ FINAL RESULT" : "✓ CHECKED IN";
  g.fillText(tag, W - L - g.measureText(tag).width, 130);

  g.fillStyle = C.muted;
  g.font = '600 36px "Inter"';
  g.fillText(`${titleCase(r.sport)} · ${day(r.startsAt)}`.toUpperCase(), L, 270);
  g.fillStyle = C.text;
  g.font = '800 64px "Inter"';
  let title = r.venueName;
  while (g.measureText(title).width > W - 2 * L && title.length > 4) title = `${title.slice(0, -2)}…`;
  g.fillText(title, L, 350);

  g.fillStyle = C.muted;
  g.font = '700 34px "Inter"';
  g.fillText(hero.label.toUpperCase(), L, 490);
  g.fillStyle = C.accent;
  // A word ("Side A", "Not played") is wider than a score: shrink to fit.
  const big = hero.word ? hero.value.toUpperCase() : hero.value;
  let px = hero.word ? 240 : 300;
  g.font = `700 ${px}px "Barlow Condensed"`;
  while (px > 90 && g.measureText(big).width > W - 2 * L) {
    px -= 10;
    g.font = `700 ${px}px "Barlow Condensed"`;
  }
  g.fillText(big, L - 8, 760);
  g.fillStyle = C.text;
  let subPx = 36;
  g.font = `500 ${subPx}px "Inter"`;
  while (subPx > 24 && g.measureText(hero.sub).width > W - 2 * L) {
    subPx -= 2;
    g.font = `500 ${subPx}px "Inter"`;
  }
  g.fillText(hero.sub, L, 830);

  g.setLineDash([14, 12]);
  g.strokeStyle = C.line;
  g.beginPath(); g.moveTo(L, 900); g.lineTo(W - L, 900); g.stroke();
  g.setLineDash([]);
  g.fillStyle = "#08090B";
  g.beginPath(); g.arc(0, 900, 34, 0, Math.PI * 2); g.arc(W, 900, 34, 0, Math.PI * 2); g.fill();

  const cols = [
    ["START", clockText(r.startsAt)],
    ["END", clockText(r.endsAt)],
    ["SHOWED UP", `${r.verifiedCount}/${r.rosterCount}`],
    r.you?.venueRank ? ["RANK HERE", `#${r.you.venueRank.rank}`] : ["PLAYED", dur(r.durationMinutes)],
  ];
  const cw = (W - 2 * L) / cols.length;
  cols.forEach(([k, v], i) => {
    const x = L + i * cw;
    g.fillStyle = C.dim; g.font = '700 26px "Inter"'; g.fillText(k, x, 990);
    g.fillStyle = i === 3 && r.you?.venueRank ? C.accent : C.text;
    g.font = '700 58px "Barlow Condensed"'; g.fillText(v, x, 1058);
  });

  const size = 88, y = 1150;
  const shown = r.roster.slice(0, 7);
  for (let i = 0; i < shown.length; i++) {
    const p = shown[i];
    const x = L + i * (size - 22);
    g.save();
    g.beginPath(); g.arc(x + size / 2, y + size / 2, size / 2 + 5, 0, Math.PI * 2);
    g.fillStyle = C.bg; g.fill();
    g.beginPath(); g.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2); g.clip();
    const img = p.avatarUrl ? await loadImage(p.avatarUrl) : null;
    if (img) g.drawImage(img, x, y, size, size);
    else {
      g.fillStyle = C.accent; g.fillRect(x, y, size, size);
      g.fillStyle = C.bg; g.font = '800 32px "Inter"';
      const ini = (p.name ?? "?").split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();
      g.fillText(ini, x + size / 2 - g.measureText(ini).width / 2, y + size / 2 + 12);
    }
    g.restore();
  }
  if (r.verifiedCount > shown.length) {
    g.fillStyle = C.muted; g.font = '700 34px "Inter"';
    g.fillText(`+${r.verifiedCount - shown.length}`, L + shown.length * (size - 22) + 30, y + size / 2 + 12);
  }
  g.fillStyle = C.dim; g.font = '500 28px "Inter"';
  const foot = "Checked in at the venue";
  g.fillText(foot, W - L - g.measureText(foot).width, y + size / 2 + 10);

  return new Promise((resolve) => cv.toBlob(resolve, "image/png"));
}

/** "Basketball at Rucker Park: Side A won 21–18", or the plain recap line before a result. */
function shareText(r) {
  const what = `${titleCase(r.sport)} at ${r.venueName}`;
  if (!r.result) return `${what}, recap on SportsArc`;
  const score = scoreLabel(r.result.score);
  return `${what}: ${outcomeLabel(r.result.outcome, r.result.winningSide)}${score ? ` ${score}` : ""}`;
}

export async function shareRecap(postId) {
  const post = CARDS.get(postId);
  if (!post?.recap) return;
  try {
    const blob = await drawCard(post);
    if (!blob) throw new Error("Could not draw the card.");
    const file = new File([blob], `sportsarc-recap-${post.id.slice(0, 8)}.png`, { type: "image/png" });
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], text: shareText(post.recap) });
      return;
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast("Recap image saved");
  } catch (err) {
    if (err?.name !== "AbortError") toast(err?.message ?? "Could not share the recap.");
  }
}
