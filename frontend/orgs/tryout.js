/**
 * A club's tryout (api/tryouts): #/tryout/<id> opens signed out; <id> may
 * also be the tryout event's game id, which is what notifications carry.
 *
 *   everyone   what, when, where, the fee, how many are in
 *   a player   "You're invited" when the club invited them; to register they
 *              first agree to show their verified record to the club's
 *              staff, then enter the event (its own PIN-signed entry)
 *   staff      invite a season's top teams or one player, the scout board
 *              (each registrant, invited or not, and with consent their
 *              verified record), and camp invites up to the club's spots
 *
 * Also the club console's Tryouts tab (paintClubTryouts): its tryouts and
 * making an event the club's signer hosts into one.
 */

import { apiGet, avatar, esc, personLink } from "../api.js";
import { $, $$, ICON, getUser, main, toast } from "../shared.js";
import { openRegisterSheet } from "../events.js";
import { send } from "./client.js";

const when = (iso) => new Date(iso).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const ordinal = (n) => {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
};

export async function renderTryoutRoute(rest, { guest } = {}) {
  const id = decodeURIComponent(String(rest ?? "").split("/")[0]);
  main().innerHTML = `<div class="org-page ty-page"><p class="feed-loading">Loading…</p></div>`;
  const root = main().querySelector(".org-page");
  const load = async () => {
    let tryout;
    try {
      ({ tryout } = await apiGet(`/api/tryouts/${encodeURIComponent(id)}`));
    } catch (err) {
      if (root.isConnected) root.innerHTML = `<div class="empty"><p>${esc(err.message)}</p></div>`;
      return;
    }
    if (!root.isConnected) return;
    paint(root, tryout, { guest, reload: load });
  };
  await load();
}

function paint(root, t, { guest, reload }) {
  document.title = `${t.name} · ${t.org.name} · SportsArc`;
  const e = t.event;
  const v = t.viewer;
  root.innerHTML = `
    <header class="org-head">
      <div class="org-mark" aria-hidden="true">${ICON.target}</div>
      <div class="org-titles">
        <h1 class="org-name">${esc(t.name)}</h1>
        <div class="org-meta"><a href="#/org/${esc(t.org.slug)}">${esc(t.org.name)}</a>${t.org.verified ? `<span class="org-badge org-badge-ok">${ICON.check}<span>Verified</span></span>` : ""}</div>
      </div>
    </header>
    <div class="ty-facts">
      <div><strong>${esc(when(t.game.startsAt))}</strong><span>${esc(t.game.venue.name)}</span></div>
      <div><strong>${e ? esc(e.free ? "Free" : e.entryFeeUsd) : "—"}</strong><span>to register</span></div>
      <div><strong>${e ? `${e.entrants}/${e.capacity}` : "—"}</strong><span>registered</span></div>
      <div><strong>${t.campSpots}</strong><span>camp ${t.campSpots === 1 ? "invite" : "invites"}</span></div>
    </div>
    ${v.camp ? `<div class="lg-callout ty-good">${ICON.trophy}<span><strong>${esc(t.org.name)} invited you to camp.</strong> They'll be in touch.</span></div>` : ""}
    ${v.invited && !v.registered ? `<div class="lg-callout ty-good">${ICON.check}<span>You're invited to register${v.invited.from ? `, from the <strong>${esc(v.invited.from)}</strong> standings` : ""}.</span></div>` : ""}
    <div data-register>${registerBox(t, guest)}</div>
    ${v.staff ? `<section class="org-section" data-staff-tryout><p class="feed-loading">Loading the scout board…</p></section>` : ""}`;

  const box = $("[data-register]", root);
  $("[data-consent-go]", box)?.addEventListener("click", async (ev) => {
    const ok = $("#ty-consent", box);
    if (!ok?.checked) { toast(`Agree to show your record to ${t.org.name} first.`); return; }
    const btn = ev.currentTarget;
    btn.disabled = true;
    try {
      await send(`/api/tryouts/${t.id}/consent`, "POST");
      await openRegisterSheet(t.game.id, { onChange: reload });
    } catch (err) {
      toast(err.message);
    }
    btn.disabled = false;
  });
  if (v.staff) void paintStaff($("[data-staff-tryout]", root), t, reload);
}

function registerBox(t, guest) {
  const e = t.event;
  const v = t.viewer;
  if (v.registered) {
    return `<div class="lg-callout">You're registered. Check in at ${esc(t.game.venue.name)} on the day; it goes on your record.${v.consented ? "" : ` <span class="ty-warn">You haven't agreed to show your record, so ${esc(t.org.name)}'s scouts won't see it.</span>`}</div>`;
  }
  if (!e) return `<div class="lg-callout">Registration opens once ${esc(t.org.name)} publishes the fee.</div>`;
  if (!e.open) return `<div class="lg-callout">Registration is closed.</div>`;
  if (guest || !getUser()) {
    return `<div class="lg-callout">Registration is open. <a class="org-btn org-btn-sm" href="#/orgs/signin/tryout/${esc(t.id)}">Sign in to register</a></div>`;
  }
  return `
    <div class="lg-callout ty-consent">
      <label class="ty-check"><input type="checkbox" id="ty-consent"${v.consented ? " checked" : ""}>
        <span><strong>Your verified record will be shown to ${esc(t.org.name)} staff.</strong> Games you checked in to, how often you show up, your league seasons. Only their staff see it, only for this tryout.</span></label>
      <button class="org-btn org-btn-wide" data-consent-go>Register · ${esc(e.free ? "free" : e.entryFeeUsd)}</button>
      <p class="org-hint">Adults only. You confirm the entry with your PIN${e.free ? "" : `; ${esc(e.entryFeeUsd)} goes to ${esc(t.org.name)} only if the tryout runs, and comes back if it doesn't`}.</p>
    </div>`;
}

async function paintStaff(box, t, reload) {
  let board;
  try {
    ({ board } = await apiGet(`/api/tryouts/${t.id}/board`));
  } catch (err) {
    box.innerHTML = `<p class="org-hint">${esc(err.message)}</p>`;
    return;
  }
  if (!box.isConnected) return;
  const full = board.registrants.filter((r) => r.camp).length >= board.campSpots;
  box.innerHTML = `
    <h2 class="org-h2">Invite players</h2>
    <div class="lg-inline-form">
      <label class="input-label" for="tr-season-q">From a league season's standings</label>
      <div class="org-email-row"><input class="input" id="tr-season-q" type="search" placeholder="Search leagues and seasons" autocomplete="off">
        <input class="input ty-top" id="ty-top" type="number" min="1" max="16" value="2" aria-label="Top teams"></div>
      <div class="org-found" data-seasons></div>
      <p class="org-hint">Invites every player on the top teams. Each gets a notification.</p>
    </div>
    ${board.invited.length ? `<p class="org-hint">${board.invited.length} invited so far.</p>` : ""}
    <h2 class="org-h2 ty-board-head">Scout board <span class="org-count">${board.registrants.length} registered · ${board.registrants.filter((r) => r.camp).length}/${board.campSpots} to camp</span></h2>
    <div class="ty-board">${board.registrants.map((r) => card(r, full)).join("") || `<p class="org-hint">No one has registered yet.</p>`}</div>`;

  $$("[data-camp]", box).forEach((b) => b.addEventListener("click", async () => {
    b.disabled = true;
    try {
      await send(`/api/tryouts/${t.id}/camp`, "POST", { userId: b.dataset.camp, invite: b.dataset.on !== "1" });
      await reload();
    } catch (err) { toast(err.message); b.disabled = false; }
  }));
  const q = $("#tr-season-q", box);
  const out = $("[data-seasons]", box);
  let seq = 0;
  let timer = null;
  q.addEventListener("input", () => {
    clearTimeout(timer);
    if (q.value.trim().length < 2) { out.innerHTML = ""; return; }
    timer = setTimeout(async () => {
      const mine = ++seq;
      let seasons = [];
      try { ({ seasons } = await apiGet("/api/seasons", { q: q.value.trim(), finished: 1 })); } catch { return; }
      if (mine !== seq || !box.isConnected) return;
      out.innerHTML = seasons.map((s, i) => `<button type="button" class="lg-venue-opt" data-i="${i}">${ICON.trophy}<span>${esc(s.league)} · ${esc(s.name)} <small>${esc(s.status === "final" ? "final" : "in season")}</small></span></button>`).join("")
        || `<p class="org-hint">No season by that name.</p>`;
      $$("[data-i]", out).forEach((b) => b.addEventListener("click", async () => {
        b.disabled = true;
        try {
          const r = await send(`/api/tryouts/${t.id}/invite-season`, "POST", { seasonId: seasons[Number(b.dataset.i)].id, teams: Number($("#ty-top", box).value) });
          toast(`Invited ${r.invited} new player${r.invited === 1 ? "" : "s"} from ${r.teams} team${r.teams === 1 ? "" : "s"}`);
          await reload();
        } catch (err) { toast(err.message); b.disabled = false; }
      }));
    }, 250);
  });
}

function card(r, full) {
  const rec = r.record;
  const lines = rec ? [
    `${rec.verifiedGames} verified ${rec.verifiedGames === 1 ? "game" : "games"}`,
    rec.showUp ? `showed up ${rec.showUp.showed} of ${rec.showUp.games}` : "no show-up history yet",
    rec.mostAt ? `most at ${rec.mostAt.venue} (${rec.mostAt.games})` : "",
  ].filter(Boolean) : [];
  const seasons = rec?.seasons?.map((x) => `${x.team ?? "A team"} · ${x.league} ${x.season}${x.place ? ` · ${ordinal(x.place)} of ${x.teams}` : ""}${x.wins != null ? ` (${x.wins}-${x.losses})` : ""}`) ?? [];
  return `
    <div class="ty-card${r.camp ? " is-camp" : ""}">
      <div class="org-person">
        ${avatar(r.person, "sm", { href: `#/u/${r.person.id}` })}
        <div class="org-person-text"><span class="org-person-name">${personLink(r.person)}</span>
          <span class="org-person-sub">${esc([r.invitedFrom ? `Invited · ${r.invitedFrom}` : "Walk-in", r.checkedIn ? "checked in" : ""].filter(Boolean).join(" · "))}</span></div>
        <button class="org-btn org-btn-sm${r.camp ? "" : " org-btn-ghost"}" data-camp="${esc(r.person.id)}" data-on="${r.camp ? "1" : "0"}"${!r.camp && full ? " disabled" : ""}>${r.camp ? `${ICON.check}<span>Camp</span>` : "Invite to camp"}</button>
      </div>
      ${rec ? `
        <p class="ty-rec">${esc(lines.join(" · "))}</p>
        ${seasons.length ? `<p class="ty-rec">${seasons.map(esc).join("<br>")}</p>` : ""}
        <a class="ty-link" href="${esc(rec.recordPath)}">Verified record and receipts</a>`
        : `<p class="ty-rec ty-warn">Did not agree to show their record.</p>`}
    </div>`;
}

// ── the club console's Tryouts tab ────────────────────────────────────

export async function paintClubTryouts(box, org, { manage = false } = {}) {
  let tryouts = [];
  try {
    ({ tryouts } = await apiGet(`/api/orgs/${org.id}/tryouts`));
  } catch (err) {
    box.innerHTML = manage ? `<p class="org-hint">${esc(err.message)}</p>` : "";
    return;
  }
  if (!box.isConnected) return;
  if (!manage && !tryouts.length) { box.innerHTML = ""; return; }
  box.innerHTML = `
    <section class="org-section">
      <h2 class="org-h2">Tryouts</h2>
      <div class="org-people">${tryouts.map((x) => `
        <a class="org-person org-person-link" href="#/tryout/${esc(x.id)}">
          <span class="org-mark org-mark-sm" aria-hidden="true">${ICON.target}</span>
          <span class="org-person-text"><span class="org-person-name">${esc(x.name)}</span>
            <span class="org-person-sub">${esc(when(x.startsAt))} · ${esc(x.venue)}${x.status === "cancelled" ? " · cancelled" : ""}</span></span>
          ${ICON.arrowRight}
        </a>`).join("") || `<p class="org-hint">${manage ? "No tryouts yet." : ""}</p>`}</div>
      ${manage ? `
        <form class="lg-inline-form ty-new" data-new-tryout>
          <h2 class="org-h2">New tryout</h2>
          <p class="org-hint">${org.hasWallet ? "" : "Set up the club's wallet first: entry fees go to its signer's wallet. "}A tryout is a paid event hosted by the club's signer: host it from Games (set the fee there), then make it the tryout here.${org.verified ? "" : " The club must be verified first."}</p>
          <div class="lg-sched">
            <label class="input-label">Name<input class="input" name="name" maxlength="120" placeholder="2027 Local Tryout"></label>
            <label class="input-label">Camp invites<input class="input" name="campSpots" type="number" min="1" max="50" value="3"></label>
            <label class="input-label">Event<select class="input" name="gameId" data-events><option value="">Loading your events…</option></select></label>
          </div>
          <button class="org-btn org-btn-sm" type="submit">${ICON.plus}<span>Make it the tryout</span></button>
        </form>` : ""}
    </section>`;
  if (!manage) return;
  const sel = $("[data-events]", box);
  apiGet("/api/my/games", { limit: 50 }).then(({ games }) => {
    if (!sel.isConnected) return;
    const events = games.filter((g) => g.kind === "event" && g.viewerRole === "host" && new Date(g.startsAt) > new Date());
    sel.innerHTML = events.length
      ? events.map((g) => `<option value="${esc(g.id)}">${esc(when(g.startsAt))} · ${esc(g.venueName ?? g.venue?.name ?? "")}</option>`).join("")
      : `<option value="">No upcoming events you host</option>`;
  }).catch(() => { sel.innerHTML = `<option value="">Couldn't load your events</option>`; });
  $("[data-new-tryout]", box).addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    e.submitter.disabled = true;
    try {
      const { tryout } = await send(`/api/orgs/${org.id}/tryouts`, "POST", {
        name: f.elements.namedItem("name").value, campSpots: Number(f.elements.namedItem("campSpots").value), gameId: f.elements.namedItem("gameId").value,
      });
      location.hash = `#/tryout/${tryout.id}`;
    } catch (err) { toast(err.message); e.submitter.disabled = false; }
  });
}
