/**
 * The invite list, for admins only (ADMIN_EMAILS on the API; see
 * api/auth/invites.ts). Opened from the account menu, which shows the entry
 * only when GET /api/admin/status says so.
 */

import { agoText, api, apiSend, esc } from "./api.js";
import { openSheet, toast } from "./shared.js";

let admin = false;
let inviteOnly = false;

export const isAdmin = () => admin;

export function clearAdminStatus() {
  admin = false;
}

export async function refreshAdminStatus() {
  try {
    const body = await api("/api/admin/status");
    admin = Boolean(body.admin);
    inviteOnly = Boolean(body.inviteOnly);
  } catch {
    admin = false;
  }
  return admin;
}

export function openInviteSheet() {
  const { body } = openSheet({ id: "invite-sheet", title: "Invites", className: "invite-sheet" });
  body.innerHTML = `
    <p class="invite-lede">${inviteOnly
      ? "An email on this list can create an account. Accounts that already exist can always sign in."
      : "Anyone can create an account right now. This list is who can, once sign-up is limited to it."}</p>
    <form class="invite-form" id="invite-form" novalidate>
      <label class="input-label" for="invite-email">Email</label>
      <div class="invite-row">
        <input class="input" id="invite-email" type="email" placeholder="name@example.com" autocomplete="off" required>
        <button class="btn-join invite-add" id="invite-add" type="submit">Invite</button>
      </div>
      <input class="input invite-note" id="invite-note" type="text" maxlength="200" placeholder="Note (optional), e.g. who they are">
      <div class="invite-error" id="invite-error" role="alert"></div>
    </form>
    <div class="invite-list-head"><span>Invites</span><span class="invite-count" id="invite-count"></span></div>
    <ul class="invite-list" id="invite-list"><li class="invite-empty">Loading…</li></ul>`;

  const form = body.querySelector("#invite-form");
  const emailEl = body.querySelector("#invite-email");
  const noteEl = body.querySelector("#invite-note");
  const errEl = body.querySelector("#invite-error");
  const listEl = body.querySelector("#invite-list");
  const countEl = body.querySelector("#invite-count");

  async function load() {
    try {
      const { invites } = await api("/api/admin/invites");
      countEl.textContent = invites.length
        ? `${invites.filter((i) => i.status === "accepted").length} of ${invites.length} joined`
        : "";
      listEl.innerHTML = invites.length
        ? invites.map(row).join("")
        : `<li class="invite-empty">No invites yet.</li>`;
    } catch (e) {
      listEl.innerHTML = `<li class="invite-empty">${esc(e.message)}</li>`;
    }
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errEl.textContent = "";
    const email = emailEl.value.trim();
    if (!email) { errEl.textContent = "Enter an email address."; return; }
    try {
      const res = await apiSend("/api/admin/invites", "POST", { email, note: noteEl.value.trim() });
      toast(res.created ? `Invited ${res.invite.email}` : `${res.invite.email} was already invited`);
      emailEl.value = "";
      noteEl.value = "";
      await load();
      emailEl.focus();
    } catch (err) {
      errEl.textContent = err.message;
    }
  });

  listEl.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-remove]");
    if (!btn) return;
    btn.disabled = true;
    try {
      await apiSend(`/api/admin/invites/${encodeURIComponent(btn.dataset.remove)}`, "DELETE");
      toast("Invite removed");
      await load();
    } catch (err) {
      btn.disabled = false;
      errEl.textContent = err.message;
    }
  });

  void load();
  emailEl.focus();
}

function row(i) {
  const joined = i.status === "accepted";
  const meta = [
    joined && i.acceptedAt ? `joined ${agoText(i.acceptedAt)}` : `invited ${agoText(i.createdAt)}`,
    i.invitedBy ? `by ${i.invitedBy}` : "",
  ].filter(Boolean).join(" · ");
  return `
    <li class="invite-item">
      <div class="invite-main">
        <div class="invite-email">${esc(i.email)}</div>
        <div class="invite-meta">${esc(meta)}${i.note ? ` · <span class="invite-note-text">${esc(i.note)}</span>` : ""}</div>
      </div>
      <span class="invite-status ${joined ? "is-joined" : "is-pending"}">${joined ? "Joined" : "Pending"}</span>
      <button class="invite-remove" type="button" data-remove="${esc(i.id)}"
        aria-label="Remove invite for ${esc(i.email)}" title="${joined ? "Remove invite (their account stays)" : "Remove invite"}">Remove</button>
    </li>`;
}
