/**
 * A sponsor org's Insights tab (api/insights/org.ts): counts only.
 *
 *   partner courts  a weekly bar chart of check-ins per court, a marker at
 *                   the week the partnership began, and the average week
 *                   before and after beside every other court's
 *   seasons         each backed league season, and its funnel: league
 *                   players → invited to a tryout → registered → checked in
 *                   at the tryout → invited to camp
 *   CSV             the courts table and the funnel table
 *
 * The server withholds any court or week figure under 5 (null, shown
 * "<5") and never counts minors or names anyone. Each chart has a table
 * view under it (the same numbers), and every bar a tooltip.
 */

import { apiGet, esc } from "../api.js";
import { $$ } from "../shared.js";

const RANGES = [8, 12, 26, 52];
const prefs = { weeks: 12 };

const dayLabel = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString([], { month: "short", day: "numeric", timeZone: "UTC" });

export async function paintInsights(box, org) {
  box.innerHTML = `<p class="feed-loading">Loading insights…</p>`;
  let insights;
  try {
    ({ insights } = await apiGet(`/api/orgs/${org.id}/insights`, { weeks: prefs.weeks }));
  } catch (err) {
    box.innerHTML = `<div class="org-note"><p>${esc(err.message)}</p></div>`;
    return;
  }
  if (!box.isConnected) return;
  const csv = (table) => `/api/orgs/${esc(org.id)}/insights/csv?table=${table}&weeks=${prefs.weeks}`;
  box.innerHTML = `
    <div class="in-bar">
      <div class="org-seg" role="radiogroup" aria-label="Weeks shown">${RANGES.map((n) =>
        `<label class="org-seg-item"><input type="radio" name="in-weeks" value="${n}"${n === prefs.weeks ? " checked" : ""}><span>${n}w</span></label>`).join("")}</div>
      <div class="in-dl"><a class="org-btn org-btn-ghost org-btn-sm" href="${csv("courts")}" download>Courts CSV</a>
        <a class="org-btn org-btn-ghost org-btn-sm" href="${csv("funnel")}" download>Funnel CSV</a></div>
    </div>
    <p class="org-hint">Counts only. Minors are never counted and no one is named; a figure under ${insights.minCount} shows as "&lt;${insights.minCount}". Weeks start Monday, Central time. A check-in is a seat that showed up, by phone or by the host's word.</p>
    <section class="org-section">
      <h2 class="org-h2">Partner courts</h2>
      ${insights.courts.length ? insights.courts.map((c) => courtCard(c, insights)).join("") : `<p class="org-hint">No partner courts yet. Name one under Sponsorships.</p>`}
    </section>
    <section class="org-section">
      <h2 class="org-h2">League seasons you back</h2>
      ${insights.seasons.length ? insights.seasons.map(seasonCard).join("") : `<p class="org-hint">Not backing a season yet.</p>`}
    </section>`;
  $$("input[name=in-weeks]", box).forEach((r) => r.addEventListener("change", () => {
    prefs.weeks = Number(r.value);
    void paintInsights(box, org);
  }));
}

/** "Here: 6 → 10.8 a week (+80%)"; a side with too few weeks says so, one under 5 shows "<5". */
function changeLine(label, ch) {
  const side = (v, weeks) => (weeks < 2 ? "—" : v === null ? "&lt;5" : String(v));
  const pct = ch.before && ch.after !== null ? Math.round(((ch.after - ch.before) / ch.before) * 100) : null;
  const why = ch.weeksBefore < 2 ? " (not enough weeks before)" : ch.weeksAfter < 2 ? " (not enough weeks since)" : "";
  return `<span>${esc(label)}: <strong>${side(ch.before, ch.weeksBefore)} → ${side(ch.after, ch.weeksAfter)}</strong> a week${pct === null ? "" : ` (${pct >= 0 ? "+" : ""}${pct}%)`}${why}</span>`;
}

/** A court: its weekly check-ins as bars, the start of the partnership marked. */
function courtCard(c, insights) {
  const values = c.weekly.map((w) => w.checkIns);
  const max = Math.max(5, ...values.filter((v) => v !== null));
  const W = 100 / c.weekly.length;
  const sinceIdx = c.weekly.findIndex((w) => w.week === c.sinceWeek);
  const bars = c.weekly.map((w, i) => {
    const v = w.checkIns;
    const h = v === null ? 3 : Math.max(3, (v / max) * 100);
    const tip = `Week of ${dayLabel(w.week)}: ${v === null ? `<${insights.minCount}` : v} check-ins, ${w.players === null ? `<${insights.minCount}` : w.players} players`;
    return `<div class="in-col" style="width:${W}%" title="${esc(tip)}" aria-label="${esc(tip)}" role="img">
      <div class="in-bar-fill${v === null ? " is-hidden" : ""}${i >= sinceIdx && sinceIdx >= 0 ? " is-after" : ""}" style="height:${h}%"></div></div>`;
  }).join("");
  const peak = values.reduce((best, v, i) => (v !== null && (best === -1 || v > values[best]) ? i : best), -1);
  return `
    <article class="in-card">
      <header class="in-card-head">
        <h3 class="in-title">${esc(c.venue.name)}</h3>
        <span class="org-person-sub">Partner since ${c.since ? esc(new Date(c.since).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })) : "—"}${c.status === "ended" ? " · ended" : ""}</span>
      </header>
      <div class="in-stats">
        ${changeLine("Here", c.change)}
        ${changeLine("All other courts", c.baseline)}
        <span>League play: <strong>${c.leagueShare === null ? "—" : `${Math.round(c.leagueShare * 100)}%`}</strong> of check-ins</span>
      </div>
      <div class="in-chart" role="group" aria-label="Weekly check-ins at ${esc(c.venue.name)}">
        <div class="in-plot">
          ${sinceIdx >= 0 ? `<div class="in-since" style="left:${sinceIdx * W}%"><span>Partner</span></div>` : ""}
          ${peak >= 0 ? `<div class="in-peak" style="left:${(peak + 0.5) * W}%;bottom:${(values[peak] / max) * 100}%">${values[peak]}</div>` : ""}
          ${bars}
        </div>
        <div class="in-axis"><span>${esc(dayLabel(c.weekly[0].week))}</span><span>${esc(dayLabel(c.weekly[c.weekly.length - 1].week))}</span></div>
      </div>
      <details class="in-table"><summary>Table</summary>
        <table><thead><tr><th>Week of</th><th>Check-ins</th><th>Players</th></tr></thead>
        <tbody>${c.weekly.map((w) => `<tr><td>${esc(dayLabel(w.week))}</td><td>${w.checkIns ?? `&lt;${insights.minCount}`}</td><td>${w.players ?? `&lt;${insights.minCount}`}</td></tr>`).join("")}</tbody></table>
      </details>
    </article>`;
}

const STAGES = [
  ["leaguePlayers", "League players"],
  ["invited", "Invited to a tryout"],
  ["registered", "Registered"],
  ["checkedIn", "Checked in at the tryout"],
  ["camp", "Invited to camp"],
];

/** A backed season: its numbers and the league-to-camp funnel (exact counts). */
function seasonCard(s) {
  const f = s.funnel;
  const top = Math.max(1, f.leaguePlayers);
  return `
    <article class="in-card">
      <header class="in-card-head">
        <h3 class="in-title"><a href="#/season/${esc(s.season.id)}">${esc(s.season.league)} · ${esc(s.season.name)}</a></h3>
        <span class="org-person-sub">run by ${esc(s.season.org.name)}${s.offer ? ` · ${esc(s.offer)}` : ""}</span>
      </header>
      <div class="in-stats">
        <span><strong>${s.teams}</strong> teams</span>
        <span><strong>${s.players ?? "&lt;5"}</strong> players</span>
        <span><strong>${s.games}</strong> games played</span>
        <span><strong>${s.checkIns ?? "&lt;5"}</strong> check-ins</span>
      </div>
      <ol class="in-funnel" aria-label="From league to camp">
        ${STAGES.map(([key, label], i) => {
          const v = f[key];
          const prev = i ? f[STAGES[i - 1][0]] : null;
          const drop = prev ? ` · ${Math.round((v / prev) * 100)}% of the step before` : "";
          return `<li title="${esc(`${label}: ${v}${drop}`)}">
            <span class="in-funnel-label">${esc(label)}</span>
            <span class="in-funnel-track"><span class="in-funnel-fill" style="width:${Math.max(v ? 2 : 0, (v / top) * 100)}%"></span></span>
            <strong class="in-funnel-n">${v}</strong>
          </li>`;
        }).join("")}
      </ol>
    </article>`;
}

