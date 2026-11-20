/**
 * Your organizations: invitations waiting for you (accept or decline),
 * the orgs you are on and your role, and creating one (#/orgs/new). Also
 * the me-card line on Home.
 */

import { esc, loadMeta, titleCase } from "../api.js";
import { $, $$, ICON, main, toast } from "../shared.js";
import { kindLabel, myInvites, myOrgs, myTeams, roleLabel, send, verifiedBadge } from "./client.js";

const KIND_HINT = {
  league: "Runs seasons, teams and schedules",
  club: "A team or club: tryouts, events, its own players",
  venue: "Manages a place: courts, fields, a gym",
  sponsor: "A brand or organization that backs leagues and courts",
  school: "A school or campus: its venues and players",
};

export function renderOrgsRoute(rest) {
  const view = String(rest ?? "");
  // Reached signed in (the sign-in screen came first): back to the page asked for.
  if (view.startsWith("signin/")) { location.replace(`#/${view.slice("signin/".length)}`); return; }
  if (view === "new") renderCreate();
  else renderMine({ focusInvites: view === "invites" });
}

// ── yours ─────────────────────────────────────────────────────────────

async function renderMine({ focusInvites }) {
  main().innerHTML = `<div class="org-page org-mine"><p class="feed-loading">Loading…</p></div>`;
  const root = main().querySelector(".org-page");
  let orgs, invites, teams;
  try {
    [orgs, invites, teams] = await Promise.all([myOrgs(), myInvites(), myTeams()]);
  } catch (err) {
    if (root.isConnected) root.innerHTML = `<div class="empty"><p>${esc(err.message)}</p></div>`;
    return;
  }
  if (!root.isConnected) return;
  document.title = "Organizations · SportsArc";
  root.innerHTML = `
    <header class="org-head org-head-plain">
      <h1 class="org-name">Organizations</h1>
      <a class="org-btn" href="#/orgs/new">${ICON.plus}<span>Create</span></a>
    </header>
    <section class="org-section" id="org-invites">
      <h2 class="org-h2">Invitations${invites.length ? ` <span class="org-count">${invites.length}</span>` : ""}</h2>
      ${invites.length ? `<div class="org-people">${invites.map((i) => `
        <div class="org-person" data-invite="${esc(i.id)}">
          <a class="org-mark org-mark-sm" href="#/org/${esc(i.org.slug)}" aria-hidden="true">${esc(i.org.name.slice(0, 1).toUpperCase())}</a>
          <div class="org-person-text">
            <a class="org-person-name" href="#/org/${esc(i.org.slug)}">${esc(i.org.name)}</a>
            <span class="org-person-sub">${esc(`${roleLabel(i.role)} · ${kindLabel(i.org.kind)}${i.invitedBy?.name ? ` · from ${i.invitedBy.name}` : ""}`)}</span>
          </div>
          <div class="org-person-actions">
            <button class="org-btn org-btn-sm" data-answer="accept">Accept</button>
            <button class="org-btn org-btn-ghost org-btn-sm" data-answer="decline">Decline</button>
          </div>
        </div>`).join("")}</div>`
        : `<p class="org-hint">No invitations right now. An organization's owner can invite you from its Staff page.</p>`}
    </section>
    <section class="org-section">
      <h2 class="org-h2">Yours</h2>
      ${orgs.length ? `<div class="org-people">${orgs.map((o) => `
        <a class="org-person org-person-link" href="#/org/${esc(o.slug)}/manage">
          <span class="org-mark org-mark-sm" aria-hidden="true">${esc(o.name.slice(0, 1).toUpperCase())}</span>
          <span class="org-person-text">
            <span class="org-person-name">${esc(o.name)}</span>
            <span class="org-person-sub">${esc(`${roleLabel(o.role)} · ${kindLabel(o.kind)}`)}</span>
          </span>
          ${verifiedBadge(o)}
        </a>`).join("")}</div>`
        : `<p class="org-hint">You're not on any organization's staff yet. Create one for your league, club, venue, school or brand.</p>`}
    </section>
    ${teams.length ? `
      <section class="org-section">
        <h2 class="org-h2">Your teams</h2>
        <div class="org-people">${teams.map((t) => `
          <a class="org-person org-person-link" href="#/team/${esc(t.team.id)}">
            <span class="org-mark org-mark-sm" aria-hidden="true">${esc(t.team.name.slice(0, 1).toUpperCase())}</span>
            <span class="org-person-text">
              <span class="org-person-name">${esc(t.team.name)}</span>
              <span class="org-person-sub">${esc(`${t.league.name} · ${t.season.name} · ${t.org.name}`)}</span>
            </span>
          </a>`).join("")}</div>
      </section>` : ""}`;
  if (focusInvites) $("#org-invites", root)?.scrollIntoView({ block: "start" });

  $$("[data-answer]", root).forEach((btn) => btn.addEventListener("click", async () => {
    const row = btn.closest("[data-invite]");
    const accept = btn.dataset.answer === "accept";
    $$("button", row).forEach((b) => { b.disabled = true; });
    try {
      const res = await send(`/api/org-invites/${row.dataset.invite}/${accept ? "accept" : "decline"}`, "POST");
      if (accept && res.org) {
        toast(`You're on ${res.org.name}'s staff`);
        location.hash = `#/org/${res.org.slug}/manage`;
        return;
      }
      toast("Invitation declined");
    } catch (err) {
      toast(err.message);
    }
    if (root.isConnected) void renderMine({ focusInvites: false });
  }));
}

// ── create ────────────────────────────────────────────────────────────

async function renderCreate() {
  main().innerHTML = `<div class="org-page org-create"><p class="feed-loading">Loading…</p></div>`;
  const root = main().querySelector(".org-page");
  let meta;
  try {
    meta = await loadMeta();
  } catch (err) {
    if (root.isConnected) root.innerHTML = `<div class="empty"><p>${esc(err.message)}</p></div>`;
    return;
  }
  if (!root.isConnected) return;
  // Adults only: the server refuses anyone else (ADULTS_ONLY) and says why.
  const kinds = meta.orgKinds ?? [];
  document.title = "Create an organization · SportsArc";
  root.innerHTML = `
    <header class="org-head org-head-plain"><h1 class="org-name">Create an organization</h1></header>
    <form class="org-form" novalidate>
      <label class="input-label" for="org-new-name">Name</label>
      <input class="input" id="org-new-name" maxlength="120" required autocomplete="organization">
      <fieldset class="org-kinds">
        <legend class="input-label">What kind</legend>
        ${kinds.map((k, i) => `
          <label class="org-kind-opt">
            <input type="radio" name="kind" value="${esc(k)}"${i === 0 ? " checked" : ""}>
            <span class="org-kind-name">${esc(titleCase(k))}</span>
            ${KIND_HINT[k] ? `<span class="org-kind-hint">${esc(KIND_HINT[k])}</span>` : ""}
          </label>`).join("")}
      </fieldset>
      <label class="input-label" for="org-new-city">City</label>
      <input class="input" id="org-new-city" maxlength="120" placeholder="San Antonio, TX" autocomplete="address-level2">
      <label class="input-label" for="org-new-site">Website</label>
      <input class="input" id="org-new-site" maxlength="255" placeholder="https://" inputmode="url">
      <label class="input-label" for="org-new-bio">About</label>
      <textarea class="input" id="org-new-bio" maxlength="500" rows="3"></textarea>
      <p class="org-hint">You'll be its owner. A SportsArc admin verifies new organizations before they can take money, sponsor or see insights.</p>
      <div class="org-error" role="alert"></div>
      <button class="org-btn org-btn-wide" type="submit">Create</button>
    </form>`;

  $("form", root).addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.submitter;
    const error = $(".org-error", root);
    error.textContent = "";
    btn.disabled = true;
    try {
      const { org } = await send("/api/orgs", "POST", {
        name: $("#org-new-name", root).value,
        kind: $("input[name=kind]:checked", root)?.value,
        city: $("#org-new-city", root).value,
        website: $("#org-new-site", root).value,
        bio: $("#org-new-bio", root).value,
      });
      toast(`${org.name} is created`);
      location.hash = `#/org/${org.slug}/manage`;
    } catch (err) {
      error.textContent = err.message;
      btn.disabled = false;
    }
  });
}

// ── Home: the me-card line ────────────────────────────────────────────

export async function renderMeCardLine(el) {
  let orgs = [], invites = [];
  try {
    [orgs, invites] = await Promise.all([myOrgs(), myInvites()]);
  } catch {
    return;
  }
  if (!el.isConnected) return;
  if (invites.length) {
    el.innerHTML = `<a class="org-meline org-meline-ask" href="#/orgs/invites">${ICON.people}<span>${invites.length === 1
      ? `${esc(invites[0].org.name)} invited you`
      : `${invites.length} organization invitations`}</span></a>`;
  } else if (orgs.length) {
    el.innerHTML = `<a class="org-meline" href="${orgs.length === 1 ? `#/org/${esc(orgs[0].slug)}/manage` : "#/orgs"}">${ICON.people}<span>${orgs.length === 1
      ? esc(orgs[0].name) : `${orgs.length} organizations`}</span></a>`;
  } else {
    el.innerHTML = `<a class="org-meline org-meline-quiet" href="#/orgs">${ICON.people}<span>Organizations</span></a>`;
  }
}
