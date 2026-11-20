/**
 * One organization: the public page (#/org/<slug>, opens signed out) and
 * the staff console (#/org/<slug>/manage). The console has a tab per part
 * of the org's work; Staff is the first: members and their roles, in-app
 * invites (pick a person on SportsArc) and email invites.
 *
 * Page state: each render makes its own root and `state`; late answers
 * check root.isConnected, so a page left behind never paints.
 */

import { apiGet, avatar, esc, personLink } from "../api.js";
import { $, $$, ICON, getUser, main, toast } from "../shared.js";
import { isAdmin } from "../invites.js";
import { paintOrgLeagues } from "./league.js";
import { paintSponsorships } from "./sponsor.js";
import { paintClubTryouts } from "./tryout.js";
import { paintInsights } from "./insights.js";
import {
  getOrg, getStaff, kindChip, mayAssign, manages, roleLabel, send, verifiedBadge,
} from "./client.js";

export function renderOrgRoute(rest, { guest } = {}) {
  const [slug, view] = String(rest ?? "").split("/");
  if (!slug) {
    location.replace(guest ? "#/" : "#/orgs");
    return;
  }
  if (view === "manage") renderConsole(decodeURIComponent(slug), { guest });
  else renderOrgPage(decodeURIComponent(slug), { guest });
}

function shell(cls) {
  main().innerHTML = `<div class="org-page ${cls}"><p class="feed-loading">Loading…</p></div>`;
  return main().querySelector(".org-page");
}

function failed(root, err) {
  root.innerHTML = `<div class="empty"><p>${esc(err.code === "ORG_NOT_FOUND" ? "That organization does not exist." : err.message)}</p>
    <p class="empty-sub"><a href="#/">Back to SportsArc</a></p></div>`;
}

function head(org, { manage = false } = {}) {
  const site = org.website
    ? `<a class="org-site" href="${esc(org.website)}" target="_blank" rel="noopener noreferrer">${ICON.globe}<span>${esc(new URL(org.website).host)}</span></a>`
    : "";
  return `
    <header class="org-head">
      <div class="org-mark" aria-hidden="true">${esc(org.name.slice(0, 1).toUpperCase())}</div>
      <div class="org-titles">
        <h1 class="org-name">${esc(org.name)}</h1>
        <div class="org-meta">${kindChip(org)}${verifiedBadge(org)}${org.city ? `<span class="org-city">${ICON.pin}<span>${esc(org.city)}</span></span>` : ""}</div>
      </div>
      ${manage
        ? `<a class="org-btn org-btn-ghost" href="#/org/${esc(org.slug)}">View page</a>`
        : org.viewerRole ? `<a class="org-btn" href="#/org/${esc(org.slug)}/manage">Manage</a>` : ""}
    </header>
    ${!manage && (org.bio || site) ? `<div class="org-about">${org.bio ? `<p>${esc(org.bio)}</p>` : ""}${site}</div>` : ""}`;
}

// ── public page ───────────────────────────────────────────────────────

async function renderOrgPage(slug, { guest }) {
  const root = shell("org-public");
  let org;
  try {
    org = await getOrg(slug);
  } catch (err) {
    if (root.isConnected) failed(root, err);
    return;
  }
  if (!root.isConnected) return;
  document.title = `${org.name} · SportsArc`;
  root.innerHTML = `
    ${head(org)}
    <div data-leagues></div>
    <section class="org-section">
      <h2 class="org-h2">Staff</h2>
      <div class="org-people">${org.staff.map(({ person, role }) => personRow(person, roleLabel(role))).join("")}</div>
    </section>
    ${guest ? `<p class="org-guest">Play, host and follow ${esc(org.name)} on SportsArc. <a href="#/orgs/signin/org/${esc(org.slug)}">Sign in</a></p>` : ""}`;
  if (org.kind === "league") void paintOrgLeagues($("[data-leagues]", root), org);
  if (org.kind === "sponsor") void paintSponsorships($("[data-leagues]", root), org);
  if (org.kind === "club") void paintClubTryouts($("[data-leagues]", root), org);
}

function personRow(person, label, trailing = "") {
  return `
    <div class="org-person">
      ${avatar(person, "sm", { href: person.id ? `#/u/${person.id}` : "" })}
      <div class="org-person-text">
        <span class="org-person-name">${personLink(person)}</span>
        <span class="org-person-sub">${esc([label, person.headline].filter(Boolean).join(" · "))}</span>
      </div>
      ${trailing}
    </div>`;
}

// ── staff console ─────────────────────────────────────────────────────

/** The console's tabs, by what kind of org it is. */
const tabsFor = (org) => [
  ...(org.kind === "league" ? [{ id: "leagues", label: "Leagues" }] : []),
  ...(org.kind === "sponsor" ? [{ id: "insights", label: "Insights" }, { id: "sponsorships", label: "Sponsorships" }] : []),
  ...(org.kind === "club" ? [{ id: "tryouts", label: "Tryouts" }] : []),
  { id: "staff", label: "Staff" },
];

async function renderConsole(slug, { guest }) {
  const root = shell("org-console");
  if (guest || !getUser()) {
    root.innerHTML = `<div class="empty"><p>Sign in to manage this organization.</p><p class="empty-sub"><a href="#/">Sign in</a></p></div>`;
    return;
  }
  let org;
  try {
    org = await getOrg(slug);
  } catch (err) {
    if (root.isConnected) failed(root, err);
    return;
  }
  if (!root.isConnected) return;
  if (!org.viewerRole) {
    root.innerHTML = `${head(org)}<div class="empty"><p>Only ${esc(org.name)}'s staff can manage it.</p></div>`;
    return;
  }
  document.title = `Manage ${org.name} · SportsArc`;
  const tabs = tabsFor(org);
  const state = { org, tab: tabs[0].id };
  root.innerHTML = `
    ${head(org, { manage: true })}
    ${org.verified ? "" : `
      <div class="org-note">
        <p><strong>Waiting for verification.</strong> Until a SportsArc admin verifies ${esc(org.name)}, it can't take or pay money, sponsor anything or see insights.</p>
        ${isAdmin() ? `<button class="org-btn" data-verify>Verify as admin</button>` : ""}
      </div>`}
    <nav class="org-tabs" role="tablist">${tabs.map((t) => `<button class="org-tab${t.id === state.tab ? " is-on" : ""}" role="tab" data-tab="${t.id}">${t.label}</button>`).join("")}</nav>
    <div class="org-panel" data-panel></div>`;
  $("[data-verify]", root)?.addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      await send(`/api/admin/orgs/${org.id}/verify`, "POST");
      toast(`${org.name} is verified`);
      renderConsole(slug, {});
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
    }
  });
  const paintTab = () => {
    $$(".org-tab", root).forEach((b) => b.classList.toggle("is-on", b.dataset.tab === state.tab));
    if (state.tab === "leagues") void paintOrgLeagues($("[data-panel]", root), org, { manage: true });
    else if (state.tab === "insights") void paintInsights($("[data-panel]", root), org);
    else if (state.tab === "tryouts") void paintClubTryouts($("[data-panel]", root), org, { manage: true });
    else if (state.tab === "sponsorships") void paintSponsorships($("[data-panel]", root), org, { manage: manages(org.viewerRole) });
    else void paintStaff(root, state);
  };
  $$(".org-tab", root).forEach((b) => b.addEventListener("click", () => { state.tab = b.dataset.tab; paintTab(); }));
  paintTab();
}

async function paintStaff(root, state) {
  const panel = $("[data-panel]", root);
  panel.innerHTML = `<p class="feed-loading">Loading staff…</p>`;
  let staff;
  try {
    staff = await getStaff(state.org.id);
  } catch (err) {
    if (root.isConnected) panel.innerHTML = `<p class="feed-loading">${esc(err.message)}</p>`;
    return;
  }
  if (!root.isConnected) return;
  const me = getUser()?.id;
  const actor = state.org.viewerRole;
  // An org always keeps one owner, so its only owner cannot leave (LAST_OWNER).
  const owners = staff.members.filter((m) => m.role === "owner").length;
  const roleOptions = (current) => ["owner", "admin", "staff"]
    .filter((r) => r === current || mayAssign(actor, r))
    .map((r) => `<option value="${r}"${r === current ? " selected" : ""}>${roleLabel(r)}</option>`).join("");

  panel.innerHTML = `
    <section class="org-section">
      <h2 class="org-h2">Members <span class="org-count">${staff.members.length}</span></h2>
      <div class="org-people">
        ${staff.members.map(({ person, role }) => {
          const self = person.id === me;
          const canChange = !self && mayAssign(actor, role);
          const controls = canChange
            ? `<select class="org-select" data-role-for="${esc(person.id)}" aria-label="Role for ${esc(person.name ?? "member")}">${roleOptions(role)}</select>
               <button class="icon-btn" data-remove="${esc(person.id)}" aria-label="Remove ${esc(person.name ?? "member")}">${ICON.close}</button>`
            : self && !(role === "owner" && owners <= 1)
              ? `<button class="org-btn org-btn-ghost org-btn-sm" data-remove="${esc(person.id)}" data-self>Leave</button>` : "";
          return personRow(person, self ? `${roleLabel(role)} · you` : roleLabel(role), `<div class="org-person-actions">${controls}</div>`);
        }).join("")}
      </div>
    </section>
    ${manages(actor) ? inviteSection(staff, actor) : ""}`;

  $$("[data-role-for]", panel).forEach((sel) => sel.addEventListener("change", async () => {
    sel.disabled = true;
    try {
      await send(`/api/orgs/${state.org.id}/members/${sel.dataset.roleFor}`, "PATCH", { role: sel.value });
      toast("Role changed");
    } catch (err) {
      toast(err.message);
    }
    if (root.isConnected) void paintStaff(root, state);
  }));
  $$("[data-remove]", panel).forEach((btn) => btn.addEventListener("click", async () => {
    const self = btn.hasAttribute("data-self");
    if (!confirm(self ? `Leave ${state.org.name}?` : "Remove them from the staff?")) return;
    btn.disabled = true;
    try {
      await send(`/api/orgs/${state.org.id}/members/${btn.dataset.remove}`, "DELETE");
      if (self) { location.hash = `#/org/${state.org.slug}`; return; }
      toast("Removed");
    } catch (err) {
      toast(err.message);
    }
    if (root.isConnected) void paintStaff(root, state);
  }));
  if (manages(actor)) bindInvites(root, panel, state);
}

function inviteSection(staff, actor) {
  const roles = ["staff", "admin"].filter((r) => mayAssign(actor, r));
  const pending = staff.invites ?? [];
  return `
    <section class="org-section">
      <h2 class="org-h2">Invite staff</h2>
      <div class="org-invite">
        ${roles.length > 1 ? `<div class="org-seg" role="radiogroup" aria-label="Invite as">${roles.map((r, i) =>
          `<label class="org-seg-item"><input type="radio" name="invite-role" value="${r}"${i === 0 ? " checked" : ""}><span>${roleLabel(r)}</span></label>`).join("")}</div>` : ""}
        <label class="input-label" for="org-find">Someone on SportsArc</label>
        <input class="input" id="org-find" type="search" placeholder="Search people by name" autocomplete="off">
        <div class="org-found" data-found></div>
        <form class="org-email" data-email-form>
          <label class="input-label" for="org-email">Or by email</label>
          <div class="org-email-row">
            <input class="input" id="org-email" type="email" placeholder="name@example.org" autocomplete="off">
            <button class="org-btn" type="submit">Invite</button>
          </div>
          <p class="org-hint">They'll see the invitation when they sign in with that email.</p>
        </form>
      </div>
    </section>
    ${pending.length ? `
      <section class="org-section">
        <h2 class="org-h2">Waiting to accept <span class="org-count">${pending.length}</span></h2>
        <div class="org-people">
          ${pending.map((i) => i.person
            ? personRow(i.person, `Invited as ${roleLabel(i.role).toLowerCase()}`, `<button class="org-btn org-btn-ghost org-btn-sm" data-cancel="${esc(i.id)}">Cancel</button>`)
            : `<div class="org-person"><span class="org-mail" aria-hidden="true">@</span>
                 <div class="org-person-text"><span class="org-person-name">${esc(i.email ?? "")}</span>
                 <span class="org-person-sub">Invited by email as ${esc(roleLabel(i.role).toLowerCase())}</span></div>
                 <button class="org-btn org-btn-ghost org-btn-sm" data-cancel="${esc(i.id)}">Cancel</button></div>`).join("")}
        </div>
      </section>` : ""}`;
}

function bindInvites(root, panel, state) {
  const role = () => $("input[name=invite-role]:checked", panel)?.value ?? "staff";
  const found = $("[data-found]", panel);
  const find = $("#org-find", panel);
  let seq = 0;
  let timer = null;

  const invite = async (body, btn) => {
    if (btn) btn.disabled = true;
    try {
      const res = await send(`/api/orgs/${state.org.id}/invites`, "POST", { ...body, role: role() });
      toast(res.invite.person ? `Invited ${res.invite.person.name ?? "them"}` : "Invitation saved");
      if (root.isConnected) void paintStaff(root, state);
    } catch (err) {
      toast(err.message);
      if (btn) btn.disabled = false;
    }
  };

  find.addEventListener("input", () => {
    clearTimeout(timer);
    const q = find.value.trim();
    if (q.length < 2) { found.innerHTML = ""; return; }
    timer = setTimeout(async () => {
      const mine = ++seq;
      let people = [];
      try {
        ({ people } = await apiGet("/api/people/adults", { q, limit: 6 }));
      } catch (err) {
        if (mine === seq) found.innerHTML = `<p class="org-hint">${esc(err.message)}</p>`;
        return;
      }
      if (mine !== seq || !root.isConnected) return;
      const me = getUser()?.id;
      const list = people.filter((p) => p.id !== me);
      found.innerHTML = list.length
        ? list.map((p) => personRow(p, p.role ? roleLabel(p.role) : "", `<button class="org-btn org-btn-sm" data-pick="${esc(p.id)}">Invite</button>`)).join("")
        : `<p class="org-hint">No one by that name. Invite them by email instead.</p>`;
      $$("[data-pick]", found).forEach((b) => b.addEventListener("click", () => invite({ userId: b.dataset.pick }, b)));
    }, 250);
  });

  $("[data-email-form]", panel).addEventListener("submit", (e) => {
    e.preventDefault();
    const email = $("#org-email", panel).value.trim();
    if (email) void invite({ email }, e.submitter);
  });

  $$("[data-cancel]", panel).forEach((b) => b.addEventListener("click", async () => {
    b.disabled = true;
    try {
      await send(`/api/orgs/${state.org.id}/invites/${b.dataset.cancel}`, "DELETE");
    } catch (err) {
      toast(err.message);
    }
    if (root.isConnected) void paintStaff(root, state);
  }));
}
