/**
 * League pages (api/leagues), all of which open signed out:
 *
 *   #/season/<id>   standings, schedule and teams; registering a team or
 *                   signing up alone while open; for the league's staff,
 *                   the season's controls: status, add a team, place free
 *                   agents, generate the schedule
 *   #/team/<id>     roster, record and fixtures; the captain and staff get
 *                   the join link and add or remove players
 *   #/join/<code>   a team's join link: claim a spot
 *
 * A signed-out visitor's "Sign in" goes to #/orgs/signin/<page>, which
 * needs an account, so the sign-in screen shows and then lands back here.
 * Each render owns its root; late answers check root.isConnected.
 */

import { apiGet, avatar, esc, loadMeta, personLink, titleCase } from "../api.js";
import { $, $$, ICON, copyText, getUser, main, shareLink, toast } from "../shared.js";
import { send } from "./client.js";
import { openPrizeSheet } from "../events.js";

const signIn = (path) => `#/orgs/signin/${path.replace(/^[#]?[/]/, "")}`;

const STATUS_LABEL = {
  draft: "Setting up", open: "Registration open", running: "In season", final: "Final", cancelled: "Cancelled",
};

const dateText = (d) => new Date(`${d}T12:00:00`).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
const when = (iso) => new Date(iso).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function shell(cls) {
  main().innerHTML = `<div class="org-page ${cls}"><p class="feed-loading">Loading…</p></div>`;
  return main().querySelector(".org-page");
}

const failed = (root, err) => {
  root.innerHTML = `<div class="empty"><p>${esc(err.message)}</p><p class="empty-sub"><a href="#/">Back to SportsArc</a></p></div>`;
};

function person(p, sub = "", trailing = "") {
  return `
    <div class="org-person">
      ${avatar(p, "sm", { href: p.id ? `#/u/${p.id}` : "" })}
      <div class="org-person-text"><span class="org-person-name">${personLink(p)}</span>
        ${sub ? `<span class="org-person-sub">${esc(sub)}</span>` : ""}</div>
      ${trailing}
    </div>`;
}

function scoreText(f) {
  const r = f.result;
  if (!r) return "";
  if (r.outcome === "not_played") return "Not played";
  if (r.score0 != null && r.score1 != null) return `${r.score0}–${r.score1}`;
  return r.outcome === "draw" ? "Draw" : r.winningSide === 0 ? "Home win" : "Away win";
}

function fixtureRow(f, { focus = null } = {}) {
  const won = (side) => f.result?.outcome === "win" && f.result.winningSide === side;
  const team = (t, side) => t
    ? `<a class="lg-fix-team${won(side) ? " is-won" : ""}${focus === t.id ? " is-focus" : ""}" href="#/team/${esc(t.id)}">${esc(t.name)}</a>`
    : "<span>TBD</span>";
  return `
    <div class="lg-fix${f.status === "cancelled" ? " is-off" : ""}">
      <a class="lg-fix-when" href="#/games/${esc(f.gameId)}">${esc(when(f.startsAt))}<span>${esc(f.venue.name)}</span></a>
      <div class="lg-fix-teams">${team(f.home, 0)}<span class="lg-vs">vs</span>${team(f.away, 1)}</div>
      <span class="lg-fix-score">${f.status === "cancelled" ? "Cancelled" : esc(scoreText(f))}${f.result && !f.result.final ? `<small>can still change</small>` : ""}</span>
    </div>`;
}

function standingsTable(rows) {
  if (!rows.length) return `<p class="org-hint">No teams yet.</p>`;
  return `
    <div class="lg-table" role="table" aria-label="Standings">
      <div class="lg-tr lg-th" role="row"><span role="columnheader">#</span><span role="columnheader">Team</span><span role="columnheader">W-L</span><span role="columnheader" class="lg-wide">T</span><span role="columnheader">Pct</span><span role="columnheader" class="lg-wide">+/-</span></div>
      ${rows.map((r) => `
        <div class="lg-tr" role="row">
          <span role="cell">${r.played ? r.place : "—"}</span>
          <a role="cell" href="#/team/${esc(r.team)}">${esc(r.name)}</a>
          <span role="cell">${r.wins}-${r.losses}</span>
          <span role="cell" class="lg-wide">${r.ties}</span>
          <span role="cell">${r.played ? r.pct.toFixed(3).replace(/^0/, "") : "—"}</span>
          <span role="cell" class="lg-wide">${r.played ? (r.pointsFor - r.pointsAgainst > 0 ? "+" : "") + (r.pointsFor - r.pointsAgainst) : "—"}</span>
        </div>`).join("")}
    </div>`;
}

/** People search with an "Add" button per result; onPick(person, button). */
function peoplePicker(box, { label, onPick, placeholder = "Search people by name" }) {
  box.innerHTML = `
    <label class="input-label">${esc(label)}</label>
    <input class="input" type="search" placeholder="${esc(placeholder)}" autocomplete="off">
    <div class="org-found"></div>`;
  const input = $("input", box);
  const found = $(".org-found", box);
  let seq = 0;
  let timer = null;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { found.innerHTML = ""; return; }
    timer = setTimeout(async () => {
      const mine = ++seq;
      let people = [];
      try { ({ people } = await apiGet("/api/people/adults", { q, limit: 6 })); } catch { return; }
      if (mine !== seq || !box.isConnected) return;
      found.innerHTML = people.length
        ? people.map((p) => person(p, p.headline ?? "", `<button class="org-btn org-btn-sm" data-pick="${esc(p.id)}">Add</button>`)).join("")
        : `<p class="org-hint">No one by that name.</p>`;
      $$("[data-pick]", found).forEach((b) => b.addEventListener("click", () => onPick(people.find((p) => p.id === b.dataset.pick), b)));
    }, 250);
  });
}

// ── season ────────────────────────────────────────────────────────────

export async function renderSeasonRoute(rest, { guest } = {}) {
  const id = decodeURIComponent(String(rest ?? "").split("/")[0]);
  const root = shell("lg-season");
  const state = { tab: "standings" };
  const load = async () => {
    let season;
    try {
      ({ season } = await apiGet(`/api/seasons/${encodeURIComponent(id)}`));
    } catch (err) {
      if (root.isConnected) failed(root, err);
      return;
    }
    if (!root.isConnected) return;
    state.season = season;
    paintSeason(root, state, { guest, reload: load });
  };
  await load();
}

function paintSeason(root, state, { guest, reload }) {
  const s = state.season;
  const v = s.viewer;
  document.title = `${s.league.name} · ${s.name} · SportsArc`;
  const tabs = [["standings", "Standings"], ["schedule", `Schedule${s.fixtures.length ? ` · ${s.fixtures.length}` : ""}`], ["teams", `Teams · ${s.teams.length}`]];
  root.innerHTML = `
    <header class="org-head">
      <div class="org-mark" aria-hidden="true">${ICON.trophy}</div>
      <div class="org-titles">
        <h1 class="org-name">${esc(s.league.name)} · ${esc(s.name)}</h1>
        <div class="org-meta">
          <span class="org-kind">${esc(STATUS_LABEL[s.status] ?? s.status)}</span>
          <span>${esc(titleCase(s.league.sport))}${s.league.format ? ` · ${esc(s.league.format)}` : ""}</span>
          <span>${esc(dateText(s.startsOn))} – ${esc(dateText(s.endsOn))}</span>
          <a href="#/org/${esc(s.org.slug)}">${esc(s.org.name)}</a>
        </div>
      </div>
    </header>
    ${sponsorLine(s)}
    ${finalsBox(s, guest)}
    <div data-join-box>${joinBox(s, guest)}</div>
    ${v.staff ? `<details class="lg-staff" ${s.status === "draft" || s.status === "open" ? "open" : ""}><summary>Run this season</summary><div data-staff></div></details>` : ""}
    <nav class="org-tabs" role="tablist">${tabs.map(([t, l]) => `<button class="org-tab${state.tab === t ? " is-on" : ""}" role="tab" data-tab="${t}">${l}</button>`).join("")}</nav>
    <div class="org-panel" data-panel></div>`;
  const panel = $("[data-panel]", root);
  const paintTab = () => {
    $$(".org-tab", root).forEach((b) => b.classList.toggle("is-on", b.dataset.tab === state.tab));
    if (state.tab === "standings") panel.innerHTML = `<section class="org-section">${standingsTable(s.standings)}</section>`;
    else if (state.tab === "schedule") {
      panel.innerHTML = `<section class="org-section">${s.fixtures.length
        ? `<div class="lg-fixtures">${s.fixtures.map((f) => fixtureRow(f, { focus: v.teamId })).join("")}</div>`
        : `<p class="org-hint">The schedule comes out once the teams are set.</p>`}</section>`;
    } else {
      panel.innerHTML = `<section class="org-section"><div class="lg-teams">${s.teams.map((t) => `
        <a class="lg-team-card" href="#/team/${esc(t.id)}">
          <span class="lg-team-name">${esc(t.name)}</span>
          <span class="org-person-sub">${t.members.length}/${s.rosterMax} players${t.captainId ? ` · captain ${esc(t.members.find((m) => m.id === t.captainId)?.name ?? "")}` : ""}</span>
          <span class="lg-faces">${t.members.slice(0, 5).map((m) => avatar(m, "xs")).join("")}</span>
        </a>`).join("") || `<p class="org-hint">No teams yet.</p>`}</div></section>`;
    }
  };
  $$(".org-tab", root).forEach((b) => b.addEventListener("click", () => { state.tab = b.dataset.tab; paintTab(); }));
  paintTab();
  bindJoinBox(root, s, reload);
  $("[data-fund-finals]", root)?.addEventListener("click", () => openPrizeSheet(s.finals.gameId, { onChange: reload }));
  if (v.staff) paintStaffControls($("[data-staff]", root), s, reload);
}

/** "Backed by ...": the season's active sponsors, linking to each. */
function sponsorLine(s) {
  const active = (s.sponsors ?? []).filter((x) => x.status === "active");
  if (!active.length) return "";
  return `<p class="lg-backed">Backed by ${active.map((x) => `<a href="#/org/${esc(x.sponsor.slug)}">${esc(x.sponsor.name)}</a>${x.offer ? ` <span>(${esc(x.offer)})</span>` : ""}`).join(", ")}</p>`;
}

/** The season's finals: an event with its own entries and prize, which a sponsor can fund. */
function finalsBox(s, guest) {
  const f = s.finals;
  if (!f) return "";
  const p = f.prize;
  const backers = p?.sponsors?.length ? ` from ${p.sponsors.map((x) => esc(x.name)).join(", ")}` : "";
  return `
    <div class="lg-callout lg-finals">
      <span class="lg-finals-text"><strong>Finals</strong> · ${esc(when(f.startsAt))} at ${esc(f.venue.name)}${p?.takesPrize ? ` · <strong>${esc(p.prizeUsd)} prize</strong>${backers}` : ""}</span>
      <span class="lg-staff-row">
        <a class="org-btn org-btn-ghost org-btn-sm" href="${guest ? signIn(`/games/${f.gameId}`) : `#/games/${esc(f.gameId)}`}">Open the finals</a>
        ${f.sponsorAs && p?.takesPrize && p.status === "open" ? `<button class="org-btn org-btn-sm" data-fund-finals>Fund the prize for ${esc(f.sponsorAs.name)}</button>` : ""}
      </span>
    </div>`;
}

function joinBox(s, guest) {
  const v = s.viewer;
  if (v.teamId) {
    const t = s.teams.find((x) => x.id === v.teamId);
    return `<div class="lg-callout">You play for <a href="#/team/${esc(v.teamId)}">${esc(t?.name ?? "your team")}</a> this season.</div>`;
  }
  if (s.status !== "open") return "";
  if (guest || !getUser()) {
    return `<div class="lg-callout">Registration is open. <a class="org-btn org-btn-sm" href="${signIn(`/season/${s.id}`)}">Sign in to register</a></div>`;
  }
  if (v.registration?.status === "waiting") {
    return `<div class="lg-callout">You're signed up. League staff will place you on a team.
      <button class="org-btn org-btn-ghost org-btn-sm" data-withdraw>Withdraw</button></div>`;
  }
  return `
    <div class="lg-callout lg-register">
      <form data-reg-team class="lg-inline-form">
        <label class="input-label" for="lg-team-name">Register a team (you'll be captain)</label>
        <div class="org-email-row"><input class="input" id="lg-team-name" maxlength="60" placeholder="Team name"><button class="org-btn" type="submit">Register</button></div>
      </form>
      <form data-reg-solo class="lg-inline-form">
        <label class="input-label" for="lg-solo-note">No team? Sign up and staff will place you</label>
        <div class="org-email-row"><input class="input" id="lg-solo-note" maxlength="200" placeholder="Anything they should know (optional)"><button class="org-btn org-btn-ghost" type="submit">Sign up</button></div>
      </form>
      <p class="org-hint">League play is for adults. Your games go on your record like any other.</p>
    </div>`;
}

function bindJoinBox(root, s, reload) {
  const act = async (btn, path, method, body, done) => {
    if (btn) btn.disabled = true;
    try {
      const res = await send(path, method, body);
      toast(done);
      if (res.team?.id) { location.hash = `#/team/${res.team.id}`; return; }
      await reload();
    } catch (err) {
      toast(err.message);
      if (btn) btn.disabled = false;
    }
  };
  $("[data-reg-team]", root)?.addEventListener("submit", (e) => {
    e.preventDefault();
    void act(e.submitter, `/api/seasons/${s.id}/register`, "POST", { kind: "team", name: $("#lg-team-name", root).value }, "Team registered");
  });
  $("[data-reg-solo]", root)?.addEventListener("submit", (e) => {
    e.preventDefault();
    void act(e.submitter, `/api/seasons/${s.id}/register`, "POST", { kind: "individual", note: $("#lg-solo-note", root).value }, "You're signed up");
  });
  $("[data-withdraw]", root)?.addEventListener("click", (e) => act(e.currentTarget, `/api/seasons/${s.id}/register`, "DELETE", {}, "Withdrawn"));
}

const MOVES = {
  draft: [["open", "Open registration"], ["cancelled", "Cancel season"]],
  open: [["draft", "Close registration"], ["cancelled", "Cancel season"]],
  running: [["final", "Finish season"], ["cancelled", "Cancel season"]],
};

function paintStaffControls(box, s, reload) {
  const canSchedule = (s.status === "draft" || s.status === "open") && !s.fixtures.length;
  const changing = s.status === "draft" || s.status === "open" || s.status === "running";
  const proposed = (s.sponsors ?? []).filter((x) => x.status === "proposed");
  box.innerHTML = `
    ${proposed.length ? `
      <section class="org-section">
        <h2 class="org-h2">Sponsors asking to back this season</h2>
        <div class="org-people">${proposed.map((x) => `
          <div class="org-person">
            <span class="org-mark org-mark-sm" aria-hidden="true">${esc(x.sponsor.name.slice(0, 1))}</span>
            <div class="org-person-text"><a class="org-person-name" href="#/org/${esc(x.sponsor.slug)}">${esc(x.sponsor.name)}</a>
              <span class="org-person-sub">${esc(x.offer ?? "")}${x.sponsor.verified ? "" : " · not verified"}</span></div>
            <div class="org-person-actions"><button class="org-btn org-btn-sm" data-sponsor-yes="${esc(x.id)}">Accept</button>
              <button class="org-btn org-btn-ghost org-btn-sm" data-sponsor-no="${esc(x.id)}">Decline</button></div>
          </div>`).join("")}</div>
      </section>` : ""}
    ${changing ? `
      <section class="org-section">
        <h2 class="org-h2">Finals</h2>
        <div class="lg-inline-form" data-finals-pick>
          <p class="org-hint">${s.finals ? "Linked. " : ""}The finals is a paid event you host (free to enter is fine), with a prize. Host it from Games, then pick it here. The season's sponsor can fund its prize.</p>
          <div class="org-email-row"><select class="input" data-finals-game><option value="">Loading your events...</option></select>
            <button class="org-btn" type="button" data-finals-link>Link</button>
            ${s.finals ? `<button class="org-btn org-btn-ghost" type="button" data-finals-unlink>Unlink</button>` : ""}</div>
        </div>
      </section>` : ""}
    <div class="lg-staff-row">${(MOVES[s.status] ?? []).map(([to, label]) =>
      `<button class="org-btn ${to === "cancelled" ? "org-btn-ghost" : ""} org-btn-sm" data-move="${to}">${label}</button>`).join("")}</div>
    ${changing ? `
      <section class="org-section">
        <h2 class="org-h2">Add a team</h2>
        <form data-add-team class="lg-inline-form">
          <div class="org-email-row"><input class="input" id="lg-add-name" maxlength="60" placeholder="Team name"><button class="org-btn" type="submit">Add team</button></div>
          <p class="org-hint">Add players from the team's page, or share its join link.</p>
        </form>
      </section>` : ""}
    ${s.freeAgents?.length ? `
      <section class="org-section">
        <h2 class="org-h2">Waiting for a team <span class="org-count">${s.freeAgents.length}</span></h2>
        <div class="org-people">${s.freeAgents.map((f) => person(f.person, f.note ?? "", `
          <div class="org-person-actions">
            <select class="org-select" data-place-team="${esc(f.id)}" aria-label="Team for ${esc(f.person.name ?? "player")}">
              ${s.teams.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join("")}
            </select>
            <button class="org-btn org-btn-sm" data-place="${esc(f.id)}"${s.teams.length ? "" : " disabled"}>Place</button>
          </div>`)).join("")}</div>
      </section>` : ""}
    ${canSchedule ? `
      <section class="org-section">
        <h2 class="org-h2">Generate the schedule</h2>
        <form data-schedule class="lg-sched">
          <label class="input-label" for="lg-first">First game day<input class="input" id="lg-first" type="date" min="${new Date().toISOString().slice(0, 10)}" value="${esc(s.startsOn)}"></label>
          <label class="input-label" for="lg-time">Start time (Central)<input class="input" id="lg-time" type="time" value="19:00"></label>
          <label class="input-label" for="lg-every">Days between rounds<input class="input" id="lg-every" type="number" min="1" max="28" value="7"></label>
          <label class="input-label" for="lg-len">Game length (min)<input class="input" id="lg-len" type="number" min="20" max="240" value="60"></label>
          <label class="input-label" for="lg-legs">Each pair meets
            <select class="input" id="lg-legs"><option value="1">Once</option><option value="2">Twice (home and away)</option></select></label>
          <div class="lg-venues">
            <label class="input-label" for="lg-venue-q">Venues, in turn by round</label>
            <input class="input" id="lg-venue-q" type="search" placeholder="Search courts" autocomplete="off">
            <div class="lg-venue-found" data-venue-found></div>
            <div class="lg-venue-picked" data-venue-picked></div>
          </div>
          <p class="org-hint">Every team needs ${s.rosterMin}+ players. Each fixture seats both rosters, home and away, so check-in and results work as in any game.</p>
          <button class="org-btn org-btn-wide" type="submit">Generate schedule</button>
        </form>
      </section>` : ""}`;

  $$("[data-move]", box).forEach((b) => b.addEventListener("click", async () => {
    const to = b.dataset.move;
    if (to === "cancelled" && !confirm("Cancel this season? Its upcoming games are cancelled too.")) return;
    if (to === "final" && !confirm("Finish the season? Standings are then fixed and rosters close.")) return;
    b.disabled = true;
    try { await send(`/api/seasons/${s.id}`, "PATCH", { status: to }); await reload(); } catch (err) { toast(err.message); b.disabled = false; }
  }));
  $("[data-add-team]", box)?.addEventListener("submit", async (e) => {
    e.preventDefault();
    e.submitter.disabled = true;
    try {
      const { team } = await send(`/api/seasons/${s.id}/teams`, "POST", { name: $("#lg-add-name", box).value });
      toast(`${team.name} added`);
      await reload();
    } catch (err) { toast(err.message); e.submitter.disabled = false; }
  });
  $$("[data-place]", box).forEach((b) => b.addEventListener("click", async () => {
    b.disabled = true;
    const teamId = $(`[data-place-team="${CSS.escape(b.dataset.place)}"]`, box).value;
    try { await send(`/api/registrations/${b.dataset.place}/place`, "POST", { teamId }); toast("Placed"); await reload(); } catch (err) { toast(err.message); b.disabled = false; }
  }));

  $$("[data-sponsor-yes], [data-sponsor-no]", box).forEach((b) => b.addEventListener("click", async () => {
    const yes = b.hasAttribute("data-sponsor-yes");
    b.disabled = true;
    try {
      await send(`/api/sponsorships/${b.dataset.sponsorYes ?? b.dataset.sponsorNo}/${yes ? "accept" : "decline"}`, "POST");
      toast(yes ? "Sponsor accepted" : "Declined");
      await reload();
    } catch (err) { toast(err.message); b.disabled = false; }
  }));
  const pick = $("[data-finals-game]", box);
  if (pick) {
    apiGet("/api/my/games", { limit: 50 }).then(({ games }) => {
      if (!pick.isConnected) return;
      const events = games.filter((g) => g.kind === "event" && g.viewerRole === "host" && new Date(g.startsAt) > new Date());
      pick.innerHTML = events.length
        ? events.map((g) => `<option value="${esc(g.id)}"${s.finals?.gameId === g.id ? " selected" : ""}>${esc(when(g.startsAt))} · ${esc(g.venueName ?? g.venue?.name ?? "")}</option>`).join("")
        : `<option value="">No upcoming events you host</option>`;
    }).catch(() => { pick.innerHTML = `<option value="">Couldn't load your events</option>`; });
    $("[data-finals-link]", box).addEventListener("click", async (e) => {
      if (!pick.value) { toast("Host the finals event first, then pick it."); return; }
      const btn = e.currentTarget;
      btn.disabled = true;
      try { await send(`/api/seasons/${s.id}/finals`, "POST", { gameId: pick.value }); toast("Finals linked"); await reload(); } catch (err) { toast(err.message); btn.disabled = false; }
    });
    $("[data-finals-unlink]", box)?.addEventListener("click", async () => {
      try { await send(`/api/seasons/${s.id}/finals`, "POST", { gameId: null }); await reload(); } catch (err) { toast(err.message); }
    });
  }

  const form = $("[data-schedule]", box);
  if (!form) return;
  const picked = [];
  const paintPicked = () => {
    $("[data-venue-picked]", form).innerHTML = picked.map((v, i) =>
      `<span class="chip chip-active">${i + 1}. ${esc(v.name)}<button type="button" class="lg-chip-x" data-unpick="${esc(v.id)}" aria-label="Remove ${esc(v.name)}">${ICON.close}</button></span>`).join("");
    $$("[data-unpick]", form).forEach((x) => x.addEventListener("click", () => {
      picked.splice(picked.findIndex((v) => v.id === x.dataset.unpick), 1);
      paintPicked();
    }));
  };
  let seq = 0;
  let timer = null;
  $("#lg-venue-q", form).addEventListener("input", (e) => {
    clearTimeout(timer);
    const q = e.target.value.trim();
    const out = $("[data-venue-found]", form);
    if (q.length < 2) { out.innerHTML = ""; return; }
    timer = setTimeout(async () => {
      const mine = ++seq;
      let venues = [];
      try { ({ venues } = await apiGet("/api/venues", { q })); } catch { return; }
      if (mine !== seq || !form.isConnected) return;
      out.innerHTML = venues.slice(0, 6).map((v) => `<button type="button" class="lg-venue-opt" data-venue="${esc(v.id)}">${ICON.pin}<span>${esc(v.name)}</span></button>`).join("")
        || `<p class="org-hint">No courts by that name.</p>`;
      $$("[data-venue]", out).forEach((b) => b.addEventListener("click", () => {
        const v = venues.find((x) => x.id === b.dataset.venue);
        if (v && !picked.some((p) => p.id === v.id)) picked.push(v);
        out.innerHTML = "";
        $("#lg-venue-q", form).value = "";
        paintPicked();
      }));
    }, 250);
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    e.submitter.disabled = true;
    try {
      const res = await send(`/api/seasons/${s.id}/schedule`, "POST", {
        firstDate: $("#lg-first", form).value,
        time: $("#lg-time", form).value,
        everyDays: Number($("#lg-every", form).value),
        durationMinutes: Number($("#lg-len", form).value),
        legs: Number($("#lg-legs", form).value),
        venueIds: picked.map((v) => v.id),
      });
      toast(`${res.fixtures} games over ${res.rounds} rounds, through ${dateText(res.lastDay)}`);
      await reload();
    } catch (err) { toast(err.message); e.submitter.disabled = false; }
  });
}

// ── team ──────────────────────────────────────────────────────────────

export async function renderTeamRoute(rest) {
  const id = decodeURIComponent(String(rest ?? "").split("/")[0]);
  const root = shell("lg-team");
  const load = async () => {
    let team;
    try {
      ({ team } = await apiGet(`/api/teams/${encodeURIComponent(id)}`));
    } catch (err) {
      if (root.isConnected) failed(root, err);
      return;
    }
    if (!root.isConnected) return;
    paintTeam(root, team, load);
  };
  await load();
}

function paintTeam(root, t, reload) {
  document.title = `${t.name} · ${t.league.name} · SportsArc`;
  const me = getUser()?.id;
  const runs = t.viewer.staff || t.viewer.captain;
  const open = ["draft", "open", "running"].includes(t.season.status);
  const st = t.standing;
  const link = t.joinCode ? `${location.origin}/#/join/${t.joinCode}` : "";
  root.innerHTML = `
    <header class="org-head">
      <div class="org-mark" aria-hidden="true">${esc(t.name.slice(0, 1).toUpperCase())}</div>
      <div class="org-titles">
        <h1 class="org-name">${esc(t.name)}</h1>
        <div class="org-meta">
          <a href="#/season/${esc(t.season.id)}">${esc(t.league.name)} · ${esc(t.season.name)}</a>
          ${st ? `<span class="org-kind">${st.played ? `${st.wins}-${st.losses}${st.ties ? `-${st.ties}` : ""} · #${st.place}` : "No games yet"}</span>` : ""}
        </div>
      </div>
    </header>
    ${runs && link && open ? `
      <div class="lg-callout lg-joinlink">
        <span>Players join with this link${t.viewer.staff && !t.viewer.captain ? "" : ". Drop it in the group chat"}:</span>
        <code>${esc(link)}</code>
        <div class="lg-staff-row"><button class="org-btn org-btn-sm" data-copy-link>${ICON.copy}<span>Copy</span></button>
          <button class="org-btn org-btn-ghost org-btn-sm" data-share-link>${ICON.share}<span>Share</span></button></div>
      </div>` : ""}
    <section class="org-section">
      <h2 class="org-h2">Roster <span class="org-count">${t.members.length}/${t.season.rosterMax}</span></h2>
      <div class="org-people">${t.members.map((m) => {
        const captain = m.id === t.captainId;
        const self = m.id === me;
        const buttons = [
          t.viewer.staff && !captain && open ? `<button class="org-btn org-btn-ghost org-btn-sm" data-captain="${esc(m.id)}">Make captain</button>` : "",
          open && (self || (runs && !captain)) ? `<button class="${self ? "org-btn org-btn-ghost org-btn-sm" : "icon-btn"}" data-drop="${esc(m.id)}" aria-label="${self ? "Leave team" : `Remove ${esc(m.name ?? "player")}`}">${self ? "Leave" : ICON.close}</button>` : "",
        ].join("");
        return person(m, [captain ? "Captain" : "", self ? "you" : "", m.headline].filter(Boolean).join(" · "), `<div class="org-person-actions">${buttons}</div>`);
      }).join("") || `<p class="org-hint">No players yet.</p>`}</div>
      ${runs && open && t.members.length < t.season.rosterMax ? `<div class="lg-add" data-add-player></div>` : ""}
    </section>
    <section class="org-section">
      <h2 class="org-h2">Games</h2>
      ${t.fixtures.length ? `<div class="lg-fixtures">${t.fixtures.map((f) => fixtureRow(f, { focus: t.id })).join("")}</div>` : `<p class="org-hint">No games scheduled yet.</p>`}
    </section>`;

  $("[data-copy-link]", root)?.addEventListener("click", () => copyText(link, "Join link copied"));
  $("[data-share-link]", root)?.addEventListener("click", () => shareLink({ url: link, title: `Join ${t.name}`, text: `Join ${t.name} in ${t.league.name} on SportsArc` }));
  $$("[data-drop]", root).forEach((b) => b.addEventListener("click", async () => {
    const self = b.dataset.drop === me;
    if (!confirm(self ? `Leave ${t.name}?` : "Remove them from the team?")) return;
    b.disabled = true;
    try { await send(`/api/teams/${t.id}/members/${b.dataset.drop}`, "DELETE"); toast(self ? "You left the team" : "Removed"); await reload(); } catch (err) { toast(err.message); b.disabled = false; }
  }));
  $$("[data-captain]", root).forEach((b) => b.addEventListener("click", async () => {
    b.disabled = true;
    try { await send(`/api/teams/${t.id}/captain`, "POST", { userId: b.dataset.captain }); toast("Captain changed"); await reload(); } catch (err) { toast(err.message); b.disabled = false; }
  }));
  const add = $("[data-add-player]", root);
  if (add) {
    peoplePicker(add, {
      label: "Add a player on SportsArc",
      onPick: async (p, btn) => {
        btn.disabled = true;
        try { await send(`/api/teams/${t.id}/members`, "POST", { userId: p.id }); toast(`${p.name ?? "Player"} added`); await reload(); } catch (err) { toast(err.message); btn.disabled = false; }
      },
    });
  }
}

// ── join link ─────────────────────────────────────────────────────────

export async function renderJoinRoute(rest, { guest } = {}) {
  const code = decodeURIComponent(String(rest ?? "").split("/")[0]);
  const root = shell("lg-join");
  let res;
  try {
    res = await apiGet(`/api/teams/join/${encodeURIComponent(code)}`);
  } catch (err) {
    if (root.isConnected) failed(root, err);
    return;
  }
  if (!root.isConnected) return;
  const t = res.team;
  document.title = `Join ${t.name} · SportsArc`;
  const member = t.viewer.member;
  const action = member
    ? `<a class="org-btn org-btn-wide" href="#/team/${esc(t.id)}">You're on this team</a>`
    : !res.open ? `<p class="org-hint">This season is over.</p>`
      : res.full ? `<p class="org-hint">The roster is full. Ask the captain about a spot.</p>`
        : guest || !getUser()
          ? `<a class="org-btn org-btn-wide" href="${signIn(`/join/${code}`)}">Sign in to claim your spot</a>`
          : `<button class="org-btn org-btn-wide" data-claim>Claim your spot</button>`;
  root.innerHTML = `
    <div class="lg-join-card">
      <p class="org-h2">You're invited to play</p>
      <h1 class="org-name">${esc(t.name)}</h1>
      <p class="org-person-sub"><a href="#/season/${esc(t.season.id)}">${esc(t.league.name)} · ${esc(t.season.name)}</a> · run by <a href="#/org/${esc(t.org.slug)}">${esc(t.org.name)}</a></p>
      <div class="lg-faces lg-faces-lg">${t.members.slice(0, 6).map((m) => avatar(m, "sm")).join("")}</div>
      <p class="org-person-sub">${t.members.length} of ${t.season.rosterMax} spots taken${t.fixtures.length ? ` · first game ${esc(when(t.fixtures[0].startsAt))}` : ""}</p>
      ${action}
      <p class="org-hint">League play is for adults. Every game you check in to goes on your record.</p>
    </div>`;
  $("[data-claim]", root)?.addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const out = await send(`/api/teams/join/${encodeURIComponent(code)}`, "POST");
      toast(`You're on ${t.name}`);
      location.hash = `#/team/${out.team.id}`;
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
    }
  });
}

// ── an org's leagues (org page, and the console's Leagues tab) ────────

export async function paintOrgLeagues(box, org, { manage = false } = {}) {
  let leagues = [];
  try {
    ({ leagues } = await apiGet(`/api/orgs/${org.id}/leagues`));
  } catch (err) {
    box.innerHTML = manage ? `<p class="org-hint">${esc(err.message)}</p>` : "";
    return;
  }
  if (!box.isConnected) return;
  if (!leagues.length && !manage) { box.innerHTML = ""; return; }
  box.innerHTML = `
    <section class="org-section">
      <h2 class="org-h2">Leagues</h2>
      ${leagues.map((l) => `
        <div class="lg-league">
          <div class="lg-league-head"><strong>${esc(l.name)}</strong><span class="org-person-sub">${esc(titleCase(l.sport))}${l.format ? ` · ${esc(l.format)}` : ""}</span></div>
          ${l.seasons.map((s) => `
            <a class="org-person org-person-link" href="#/season/${esc(s.id)}">
              <span class="org-person-text"><span class="org-person-name">${esc(s.name)}</span>
              <span class="org-person-sub">${esc(STATUS_LABEL[s.status] ?? s.status)} · ${s.teams} team${s.teams === 1 ? "" : "s"} · ${esc(dateText(s.startsOn))} – ${esc(dateText(s.endsOn))}</span></span>
              ${ICON.arrowRight}
            </a>`).join("") || `<p class="org-hint">No seasons yet.</p>`}
          ${manage ? `<form class="lg-inline-form lg-new-season" data-new-season="${esc(l.id)}">
            <div class="lg-sched">
              <label class="input-label">Season name<input class="input" name="name" maxlength="120" placeholder="Spring 2027"></label>
              <label class="input-label">Starts<input class="input" name="startsOn" type="date"></label>
              <label class="input-label">Ends<input class="input" name="endsOn" type="date"></label>
              <label class="input-label">Players per team<span class="org-email-row"><input class="input" name="rosterMin" type="number" min="1" max="15" value="3" aria-label="Minimum"><input class="input" name="rosterMax" type="number" min="1" max="15" value="5" aria-label="Maximum"></span></label>
            </div>
            <button class="org-btn org-btn-sm" type="submit">${ICON.plus}<span>New season</span></button>
          </form>` : ""}
        </div>`).join("")}
      ${manage ? `
        <form class="lg-inline-form" data-new-league>
          <h2 class="org-h2">New league</h2>
          <div class="lg-sched">
            <label class="input-label">Name<input class="input" name="name" maxlength="120" placeholder="I-35 3v3"></label>
            <label class="input-label">Sport<select class="input" name="sport" data-sports></select></label>
            <label class="input-label">Format<input class="input" name="format" maxlength="40" placeholder="3v3 half court"></label>
          </div>
          <button class="org-btn org-btn-sm" type="submit">${ICON.plus}<span>Create league</span></button>
        </form>` : ""}
    </section>`;
  if (!manage) return;
  const meta = await loadMeta().catch(() => ({ sports: ["basketball"] }));
  const sel = $("[data-sports]", box);
  if (sel) sel.innerHTML = meta.sports.map((s) => `<option value="${esc(s)}"${s === "basketball" ? " selected" : ""}>${esc(titleCase(s))}</option>`).join("");
  const field = (form, n) => form.elements.namedItem(n)?.value;
  $("[data-new-league]", box)?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    e.submitter.disabled = true;
    try {
      await send(`/api/orgs/${org.id}/leagues`, "POST", { name: field(f, "name"), sport: field(f, "sport"), format: field(f, "format") });
      toast("League created");
      await paintOrgLeagues(box, org, { manage });
    } catch (err) { toast(err.message); e.submitter.disabled = false; }
  });
  $$("[data-new-season]", box).forEach((f) => f.addEventListener("submit", async (e) => {
    e.preventDefault();
    e.submitter.disabled = true;
    try {
      const { season } = await send(`/api/leagues/${f.dataset.newSeason}/seasons`, "POST", {
        name: field(f, "name"), startsOn: field(f, "startsOn"), endsOn: field(f, "endsOn"),
        rosterMin: Number(field(f, "rosterMin")), rosterMax: Number(field(f, "rosterMax")),
      });
      location.hash = `#/season/${season.id}`;
    } catch (err) { toast(err.message); e.submitter.disabled = false; }
  }));
}
