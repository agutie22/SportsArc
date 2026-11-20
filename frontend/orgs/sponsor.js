/**
 * A sponsor org's sponsorships (api/orgs/sponsors.ts): partner courts and
 * league seasons. On the org's public page (read only) and in its
 * console's Sponsorships tab, where owners and admins name partner courts,
 * propose backing a season (the league accepts), and end either.
 */

import { apiGet, esc } from "../api.js";
import { $, $$, ICON, toast } from "../shared.js";
import { send } from "./client.js";

const since = (iso) => (iso ? new Date(iso).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }) : "");

export async function paintSponsorships(box, org, { manage = false } = {}) {
  let list = [];
  try {
    ({ sponsorships: list } = await apiGet(`/api/orgs/${org.id}/sponsorships`));
  } catch (err) {
    box.innerHTML = manage ? `<p class="org-hint">${esc(err.message)}</p>` : "";
    return;
  }
  if (!box.isConnected) return;
  const courts = list.filter((s) => s.venue);
  const seasons = list.filter((s) => s.season);
  if (!manage && !list.length) { box.innerHTML = ""; return; }
  const end = (s) => (manage ? `<button class="org-btn org-btn-ghost org-btn-sm" data-end="${esc(s.id)}">${s.status === "proposed" ? "Withdraw" : "End"}</button>` : "");
  box.innerHTML = `
    ${manage && !org.verified ? `<div class="org-note"><p>Sponsoring starts once a SportsArc admin verifies ${esc(org.name)}.</p></div>` : ""}
    <section class="org-section">
      <h2 class="org-h2">Partner courts${courts.length ? ` <span class="org-count">${courts.length}</span>` : ""}</h2>
      <div class="org-people">${courts.map((s) => `
        <div class="org-person">
          <span class="org-mark org-mark-sm" aria-hidden="true">${ICON.pin}</span>
          <div class="org-person-text"><span class="org-person-name">${esc(s.venue.name)}</span>
            <span class="org-person-sub">${esc([`Partner since ${since(s.startsAt)}`, s.offer].filter(Boolean).join(" · "))}</span></div>
          ${end(s)}
        </div>`).join("") || `<p class="org-hint">${manage ? "No partner courts yet." : ""}</p>`}</div>
      ${manage && org.verified ? `
        <div class="lg-inline-form sp-add">
          <label class="input-label" for="sp-venue-q">Name a partner court</label>
          <input class="input" id="sp-venue-q" type="search" placeholder="Search courts" autocomplete="off">
          <div class="org-found" data-venues></div>
          <p class="org-hint">Activity there is compared before and after today in Insights. Counts only, never names.</p>
        </div>` : ""}
    </section>
    <section class="org-section">
      <h2 class="org-h2">League seasons${seasons.length ? ` <span class="org-count">${seasons.length}</span>` : ""}</h2>
      <div class="org-people">${seasons.map((s) => `
        <div class="org-person">
          <span class="org-mark org-mark-sm" aria-hidden="true">${ICON.trophy}</span>
          <div class="org-person-text"><a class="org-person-name" href="#/season/${esc(s.season.id)}">${esc(s.season.league)} · ${esc(s.season.name)}</a>
            <span class="org-person-sub">${esc([s.status === "proposed" ? "Waiting for the league to accept" : `Backing since ${since(s.startsAt)}`, s.offer, `run by ${s.season.org.name}`].filter(Boolean).join(" · "))}</span></div>
          ${end(s)}
        </div>`).join("") || `<p class="org-hint">${manage ? "Not backing a season yet." : ""}</p>`}</div>
      ${manage && org.verified ? `
        <div class="lg-inline-form sp-add">
          <label class="input-label" for="sp-season-q">Back a league season</label>
          <input class="input" id="sp-season-q" type="search" placeholder="Search leagues and seasons" autocomplete="off">
          <input class="input" id="sp-offer" maxlength="140" placeholder="What you offer (e.g. the finals prize)">
          <div class="org-found" data-seasons></div>
          <p class="org-hint">The league's staff accept it. Then you can fund the prize of the season's finals from your organization's wallet.</p>
        </div>` : ""}
    </section>`;
  if (!manage) return;

  const repaint = () => paintSponsorships(box, org, { manage });
  $$("[data-end]", box).forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("End this sponsorship?")) return;
    b.disabled = true;
    try { await send(`/api/sponsorships/${b.dataset.end}`, "DELETE"); await repaint(); } catch (err) { toast(err.message); b.disabled = false; }
  }));
  search(box, "#sp-venue-q", "[data-venues]", async (q) => (await apiGet("/api/venues", { q })).venues.slice(0, 6),
    (v) => `${ICON.pin}<span>${esc(v.name)}</span>`,
    async (v) => {
      await send(`/api/orgs/${org.id}/sponsorships`, "POST", { kind: "venue", venueId: v.id });
      toast(`${v.name} is a partner court`);
      await repaint();
    });
  search(box, "#sp-season-q", "[data-seasons]", async (q) => (await apiGet("/api/seasons", { q })).seasons,
    (s) => `${ICON.trophy}<span>${esc(s.league)} · ${esc(s.name)} <small>${esc(s.org.name)}</small></span>`,
    async (s) => {
      await send(`/api/orgs/${org.id}/sponsorships`, "POST", { kind: "season", seasonId: s.id, offer: $("#sp-offer", box)?.value ?? "" });
      toast("Sent to the league");
      await repaint();
    });
}

/** A search box whose results are buttons; pick(item) runs on a tap. */
function search(box, inputSel, outSel, find, label, pick) {
  const input = $(inputSel, box);
  const out = $(outSel, box);
  if (!input || !out) return;
  let seq = 0;
  let timer = null;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { out.innerHTML = ""; return; }
    timer = setTimeout(async () => {
      const mine = ++seq;
      let items = [];
      try { items = await find(q); } catch { return; }
      if (mine !== seq || !box.isConnected) return;
      out.innerHTML = items.map((it, i) => `<button type="button" class="lg-venue-opt" data-i="${i}">${label(it)}</button>`).join("")
        || `<p class="org-hint">Nothing by that name.</p>`;
      $$("[data-i]", out).forEach((b) => b.addEventListener("click", async () => {
        b.disabled = true;
        try { await pick(items[Number(b.dataset.i)]); } catch (err) { toast(err.message); b.disabled = false; }
      }));
    }, 250);
  });
}
