/**
 * Venue sheet: the regulars ladder for one court or field — verified
 * check-ins over the last 90 days — and what is coming up there.
 *
 * The line that makes a small ladder work is "N more to pass X": a rung
 * you can see and reach, not a global rank you will never move.
 */

import { openSheet, getUser, ICON } from "./shared.js";
import { apiGet, esc, firstName, titleCase, whenLabel, sportIcon, avatar, personLink } from "./api.js";

export async function openVenueSheet(venueId) {
  const { body, sheet } = openSheet({ id: "venue-sheet", title: "Venue" });
  body.innerHTML = `<div class="skel skel-line" style="width:50%;height:22px"></div>
    <div class="skel skel-line" style="width:30%"></div>`;
  try {
    const [board, upcoming] = await Promise.all([
      apiGet(`/api/venues/${venueId}/regulars`),
      apiGet("/api/games", { venueId, limit: 20 }).then((r) => r.games).catch(() => []),
    ]);
    if (!sheet.isConnected) return;
    sheet.querySelector(".sheet-title").textContent = board.venue.name;
    body.innerHTML = render(board, upcoming);
  } catch (err) {
    body.innerHTML = `<p class="empty empty-sm">${esc(err.message)}</p>`;
  }
}

function render(b, upcoming) {
  const me = getUser();
  const top = b.regulars[0]?.checkIns ?? 1;
  const you = b.viewer;

  const standing = you
    ? `<div class="ladder-you">
         <strong>You're #${you.rank}</strong>
         <span>${you.next
           ? `${you.next.gap} more check-in${you.next.gap === 1 ? "" : "s"} to pass ${personLink(
               { id: you.next.id, name: firstName(you.next.name, "the next player") },
               { fallback: "the next player" },
             )}`
           : "You run this court. Keep showing up."}</span>
       </div>`
    : `<div class="ladder-you ladder-you-empty">
         <strong>You're not on this ladder yet</strong>
         <span>Check in at a game here to get ranked.</span>
       </div>`;

  return `
    <div class="venue-head">
      <span class="pf-chip">${ICON.pin}<strong>${esc(titleCase(b.venue.kind))}</strong></span>
      ${b.venue.address ? `<span class="venue-addr">${esc(b.venue.address)}</span>` : ""}
    </div>

    <h4 class="ladder-title">Regulars <span>· check-ins at the venue, last ${b.windowDays} days</span></h4>
    ${standing}
    ${b.regulars.length
      ? `<ol class="ladder">${b.regulars.map((r) => `
          <li class="ladder-row${r.user.id === me?.id ? " is-you" : ""}${r.rank === 1 ? " is-top" : ""}">
            <span class="ladder-rank">${r.rank === 1 ? ICON.crown : r.rank}</span>
            ${avatar(r.user, "sm", { href: `#/u/${r.user.id}` })}
            <a class="ladder-name" href="#/u/${esc(r.user.id)}">
              <strong>${esc(r.user.name ?? "Someone")}</strong>
              <span class="ladder-bar"><i style="width:${Math.max(6, (r.checkIns / top) * 100)}%"></i></span>
            </a>
            <span class="ladder-count"><strong>${r.checkIns}</strong>check-in${r.checkIns === 1 ? "" : "s"}</span>
          </li>`).join("")}</ol>`
      : `<p class="empty empty-sm"><strong>Nobody yet</strong>The first check-in here takes the crown.</p>`}

    <h4 class="ladder-title">Coming up here</h4>
    ${upcoming.length
      ? upcoming.slice(0, 5).map((g) => `
          <a class="widget-row" href="#/games/${esc(g.id)}">
            <span class="widget-icon">${sportIcon(g.sport)}</span>
            <span class="widget-text">
              <strong>${esc(titleCase(g.sport))} · ${esc(whenLabel(g.startsAt))}</strong>
              <span class="widget-sub">${g.spotsLeft ? `${g.spotsLeft} spot${g.spotsLeft === 1 ? "" : "s"} left` : "Full"} · ${esc(titleCase(g.skillLevel))}</span>
            </span>
          </a>`).join("")
      : `<p class="empty-inline">No games scheduled. <a href="#/games">Host one here</a></p>`}`;
}
