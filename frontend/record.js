/**
 * The verified record: a player's games that were checked in at the venue
 * and then written to a public record nobody can edit afterwards.
 *
 *   #/record            your own record
 *   #/record/<user id>  that player's record. Public by default, and it
 *                       opens without signing in. A player who opts into
 *                       privacy shows no games here.
 *   #/record/<token>    a link they created. It shows the games even when
 *                       the record is private, and opens without signing in.
 *   #/verify/<id>       one record by its ID alone: the receipt, no names
 *
 * The page asks the record contract about every game itself
 * (chain-check.js) and fills each square in as the answer comes back. A
 * game opens its receipt: what happened, in order, in plain words.
 *
 * The same record shows up elsewhere through this module, so every surface
 * says it the same way:
 *
 *   recordChip      the profile's "Shows up 11/13" chip and its sheet,
 *                   which asks the contract about the latest record itself
 *   gameRecordLine  where your seat in one game stands (the game sheet)
 *   markGames       Verified / Missed pills on your profile's Games tab
 *   paintCounts     the short form for lists (directory, game roster)
 *   meRecordLine    the line on Home's me-card
 *
 * Each check-in and each missed game is its own entry on the public
 * record, written once check-in closes. Checking one is a single question
 * to the contract (writtenAt), and its answer is the time the entry was
 * written, which the receipt shows as the network's own word.
 *
 * Words: "verified", "record", "missed". A check-in confirmed at the venue
 * but not yet written is "being verified", never "verified" (recaps and
 * ladders say "checked in"). Words like "on chain", hashes and the network name stay
 * inside Technical details. A receipt says who vouched for
 * each fact, its written step links its transaction, and "Check it
 * yourself" hands over the one value writtenAt() takes.
 */

import { $, toast, openSheet, explorerUrlFor, ICON, main, getUser, bindCopyButtons, copyText, shareLink, shortAddr } from "./shared.js";
import { agoText, apiGet, apiSend, avatar, clockText, dayKey, esc, firstName as first, personLink, sportIcon, titleCase } from "./api.js";
import { askWrittenAt } from "./chain-check.js";
import { runSignature } from "./money.js";

const WEEKS = 26;
const LIST_FIRST = 12;
const CHECKS_AT_ONCE = 4;

const fmtDay = (iso) => new Date(iso).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", year: "numeric" });
const fmtStamp = (iso) => `${new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" })} · ${clockText(iso)}`;
const firstName = (name) => first(name, "This player");
// Empty, not "—", when missing: tech() leaves out a row with no value.
const short = (hex) => (hex ? shortAddr(hex, 8, 6) : "");
/** Fewer counted games than this and the chip says "New", the same rule as social/reliability.ts. */
const MIN_GAMES = 3;
const LOW = 0.7;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── asking the record ─────────────────────────────────────────────────

/**
 * When the network says this game's entry was written (ISO), false when it
 * has no such entry, null when it could not be asked. The browser asks the
 * network first (`via: "phone"`); if it cannot be reached from here, our
 * server asks instead (`via: "server"`).
 */
async function checkGame(g, chain) {
  const direct = chain?.rpcUrl && g.chainId === chain.id ? await askWrittenAt({ rpcUrl: chain.rpcUrl, contract: g.contract, hash: g.hash }) : null;
  if (direct !== null) return { answer: direct, via: "phone" };
  try {
    const r = await apiGet(`/api/web3/record/hashes/${encodeURIComponent(g.hash)}`);
    return { answer: r.onChain ?? null, via: "server" };
  } catch {
    return { answer: null, via: "server" };
  }
}

/** An answer from checkGame that says the entry is there. */
const isThere = (a) => typeof a === "string";

/** Showed up to this game: the phone checked in, or the host confirmed them as here. Either counts. */
const cameTo = (g) => g.kind === "checkin" || g.presence?.present === true;

// ── the profile chip ──────────────────────────────────────────────────

const summaryOf = (id) => apiGet(`/api/web3/record/users/${id}/summary`).catch(() => null);

function chipFor(s, isMe) {
  if (!s) return "";
  const { verified, showedUp, verifying } = s;
  const pulse = verifying > 0 ? `<span class="att-pulse" title="${verifying} recent ${verifying === 1 ? "game" : "games"} being verified"></span>` : "";
  let cls = "", text;
  if (verified >= MIN_GAMES) {
    cls = showedUp / verified < LOW ? " is-low" : "";
    text = `Shows up ${showedUp}<span class="att-of">/${verified}</span>`;
  } else if (verified > 0) { cls = " is-new"; text = `New · ${showedUp} verified`; }
  else if (verifying > 0) { cls = " is-new"; text = "Being verified"; }
  else if (isMe) { cls = " is-new"; text = "Not verified yet"; }
  else return "";
  return `<button type="button" class="att-chip${cls}" aria-haspopup="dialog" title="Games on the public record">${ICON.shield}${text}${pulse}</button>`;
}

/**
 * The attendance chip beside the role badge, counted from the public
 * record. Whatever the slot already holds (the server's show-up chip)
 * stays when there is no record to show, e.g. on a server that writes none.
 */
export async function recordChip(slot, person, isMe) {
  if (!slot) return;
  const s = await summaryOf(person.id);
  if (!slot.isConnected) return;
  const chip = chipFor(s, isMe);
  if (!chip) return;
  slot.innerHTML = chip;
  slot.querySelector("button").addEventListener("click", () => openAttendanceSheet(person, s, isMe));
}

function liveLatest(answer) {
  if (answer === undefined) return { cls: "", text: "Checking the latest entry from your phone…" };
  if (isThere(answer)) return { cls: "is-ok", text: `Checked from your phone. The latest entry is there, written ${fmtStamp(answer)}.` };
  if (answer === false) return { cls: "is-bad", text: "Checked from your phone just now. The latest entry is not on the public record." };
  return { cls: "is-wait", text: "The public record could not be reached right now. Try again in a moment." };
}

function attendanceHtml(person, s, isMe, answer) {
  const who = isMe ? "you" : firstName(person.name);
  const missed = s.verified - s.showedUp;
  const seg = (cls, n) => (n > 0 ? `<i class="${cls}" style="flex:${n}"></i>` : "");
  const latest = s.latest;
  const tx = latest?.txHash ? explorerUrlFor(latest.txHash, { kind: "tx" }) : "";
  const contract = latest?.contract ?? s.chain?.contract;
  const tech = (label, value, href) => !value ? "" : `<div><dt>${label}</dt><dd>${href
    ? `<a class="pay-proof" href="${esc(href)}"${href.startsWith("#") ? "" : ` target="_blank" rel="noopener"`}>${esc(value)}</a>` : esc(value)}</dd></div>`;
  const live = liveLatest(answer);
  const waiting = s.verifying > 0
    ? `<p class="rec-pending">${s.verifying} recent ${s.verifying === 1 ? "game is" : "games are"} still being verified.</p>` : "";

  if (s.verified === 0) {
    return `
      <p class="rec-lead">${s.verifying > 0 ? "Being verified" : "Nothing on the record yet"}</p>
      <p class="res-hint">${isMe
        ? "Check in at the venue for your next game. Shortly after check-in closes, it's written to a public record nobody can change, and it shows here as verified."
        : `${esc(firstName(person.name))}'s games appear here once they're checked in at the venue and written to the public record.`}</p>
      ${waiting}
      ${isMe ? `<a class="btn-game btn-game-ghost" href="#/games">Find a game</a>` : ""}`;
  }
  return `
    <p class="rec-lead"><strong>${s.showedUp}</strong> of ${s.verified} ${s.verified === 1 ? "game" : "games"} · ${esc(who)} showed up</p>
    <div class="att-bar" role="img" aria-label="${s.showedUp} showed up, ${missed} missed, ${s.verifying} being verified">
      ${seg("is-played", s.showedUp)}${seg("is-missed", missed)}${seg("is-wait", s.verifying)}
    </div>
    <ol class="att-steps">
      <li><span class="att-dot">${ICON.pin}</span><span><b>Showed up</b>${isMe ? "Your" : `${esc(firstName(person.name))}'s`} phone checked in at the venue, or the host confirmed ${isMe ? "you" : "them"} as there. Either counts.</span></li>
      <li><span class="att-dot">${ICON.shield}</span><span><b>Each game has its own entry</b>Every check-in and every missed game was written to a public record when check-in closed. Nobody can change it afterwards, not even SportsArc.${
        latest?.writtenAt ? ` Latest ${esc(agoText(latest.writtenAt))}.` : ""}${
        tx ? ` <a class="pay-proof" href="${esc(tx)}" target="_blank" rel="noopener">See the transaction${ICON.external}</a>` : ""}</span></li>
      <li class="att-live ${live.cls}" data-live><span class="att-dot">${answer === false ? ICON.close : ICON.check}</span><span><b>Checked just now</b>${esc(live.text)}</span></li>
    </ol>
    ${waiting}
    ${isMe
      ? `<a class="btn-game" href="#/record">Open my record</a>`
      : s.private
        ? `<p class="res-hint">The games are private. Ask ${esc(firstName(person.name))} for a link to see each one.</p>`
        : `<a class="btn-game" href="#/record/${esc(person.id)}">Open record</a>`}
    <details class="rcpt-tech">
      <summary>Technical details</summary>
      <dl>
        ${tech("Network", s.chain?.name)}
        ${tech("Latest record ID", short(latest?.hash), latest?.hash ? `#/verify/${latest.hash}` : "")}
        ${tech("Transaction", short(latest?.txHash), tx)}
        ${tech("Block", latest?.blockNumber != null ? String(latest.blockNumber) : "")}
        ${tech("Record contract", short(contract), contract ? explorerUrlFor(contract) : "")}
      </dl>
    </details>`;
}

async function openAttendanceSheet(person, s, isMe) {
  const { body } = openSheet({ id: "verified-sheet", title: "Verified attendance", className: "sheet-result" });
  body.innerHTML = attendanceHtml(person, s, isMe, s.latest?.hash ? undefined : null);
  if (!s.latest?.hash) return;
  const answer = await askWrittenAt({ rpcUrl: s.chain?.rpcUrl, contract: s.latest.contract, hash: s.latest.hash });
  if (body.isConnected) body.innerHTML = attendanceHtml(person, s, isMe, answer);
}

// ── one game, the profile's Games tab, lists, Home ────────────────────

/** Where the viewer's seat in one game stands; null when it could not be asked. */
export function fetchGameRecord(gameId) {
  return apiGet(`/api/web3/record/checkins/${encodeURIComponent(gameId)}`).catch(() => null);
}

/** A line for the game sheet, or "" when there is nothing to say yet. */
export function gameRecordLine(r) {
  if (!r) return "";
  if (r.state === "verified" || r.state === "missed") {
    const ok = r.state === "verified";
    return `<button type="button" class="gs-record ${ok ? "is-ok" : "is-missed"}" data-gs-receipt>
      ${ok ? ICON.shield : ICON.close}
      <span><b>${ok ? "Verified" : "Missed"}</b>${ok
        ? r.game?.kind === "missed"
          ? "The host confirmed you were here. That's on the public record."
          : "Your check-in has its own entry on the public record."
        : "You held a spot and didn't check in. That's on the public record too."}</span>
      <span class="pay-proof">Receipt</span></button>`;
  }
  if (r.state === "waiting") {
    return `<div class="gs-record is-wait">${ICON.shield}<span><b>You're checked in</b>When check-in closes${
      r.closesAt ? ` at ${esc(clockText(r.closesAt))}` : ""}, it's written to the public record.</span></div>`;
  }
  if (r.state === "verifying" && r.checkedIn) {
    return `<div class="gs-record is-wait">${ICON.shield}<span><b>Being verified</b>Check-in closed. Your check-in is being written to the public record, usually within ${r.withinMin} min.</span></div>`;
  }
  return "";
}

/** The receipt for a game record from fetchGameRecord. */
export function openGameReceipt(r) {
  if (r?.game) openReceipt(r.game, { player: getUser(), chain: r.chain });
}

const MARKED = new WeakMap();

/** Your own profile's Games tab: a Verified or Missed pill on each game on the record. */
export async function markGames(panel) {
  let record;
  try { record = await apiGet("/api/web3/record/mine"); } catch { return; }
  if (!panel.isConnected) return;
  const byGame = new Map(record.games.map((g) => [g.gameId, g]));
  MARKED.set(panel, { byGame, record });
  panel.querySelectorAll("[data-pf-game]").forEach((card) => {
    const g = byGame.get(card.dataset.pfGame);
    const line = card.querySelector(".game-line1");
    if (!g || !line || line.querySelector(".rec-pill")) return;
    const ok = cameTo(g);
    line.insertAdjacentHTML("beforeend", `<button type="button" class="rec-pill ${ok ? "is-ok" : "is-missed"}" data-rec-game="${esc(g.gameId)}"
      title="Open the receipt">${ok ? ICON.shield : ICON.close}${ok ? "Verified" : "Missed"}</button>`);
  });
  if (panel.dataset.recBound) return;
  panel.dataset.recBound = "1";
  panel.addEventListener("click", (e) => {
    const pill = e.target.closest("[data-rec-game]");
    if (!pill) return;
    e.preventDefault();
    e.stopPropagation();
    const m = MARKED.get(panel);
    const g = m?.byGame.get(pill.dataset.recGame);
    if (g) openReceipt(g, { player: m.record.player, chain: m.record.chain });
  }, true);
}

/**
 * The short form for lists. Fills each `[data-rec-person="<id>"]` under
 * `root` that has a record; one with none keeps what it already says.
 */
export async function paintCounts(root, ids) {
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) return;
  let people;
  try { ({ people } = await apiGet("/api/web3/record/counts", { ids: list.join(",") })); } catch { return; }
  root.querySelectorAll("[data-rec-person]").forEach((el) => {
    const c = people[el.dataset.recPerson];
    if (!c?.verified) return;
    const low = c.verified >= MIN_GAMES && c.showedUp / c.verified < LOW;
    el.className = `rec-seal${low ? " is-low" : ""}`;
    el.title = "Games on the public record";
    el.innerHTML = `${ICON.shield}${c.verified >= MIN_GAMES ? `Shows up ${c.showedUp}/${c.verified}` : `${c.showedUp} verified`}`;
  });
}

/** Home's me-card: your record in one line, and the way to it. */
export async function meRecordLine(el, userId) {
  if (!el) return;
  const s = await summaryOf(userId);
  if (!s || !el.isConnected) return;
  const lead = s.verified
    ? `<strong>${s.showedUp}</strong> verified ${s.showedUp === 1 ? "game" : "games"}`
    : s.verifying ? "Your first games are being verified" : "Check in at a game to start your record";
  el.innerHTML = `<a class="me-card-record" href="#/record">${ICON.shield}<span>${lead}</span><span class="me-card-record-go">Record${ICON.arrowRight}</span></a>`;
}

// ── the record page ───────────────────────────────────────────────────

function notice(title, text) {
  return `<div class="verify-card verify-bad"><h3>${esc(title)}</h3><p class="res-hint">${esc(text)}</p></div>`;
}

function calendar(games) {
  const byDay = new Map();
  for (const g of games) {
    const k = dayKey(new Date(g.startsAt));
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(g);
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(today.getDate() - today.getDay() - (WEEKS - 1) * 7);

  let months = "", cells = "", lastMonth = -1;
  for (let w = 0; w < WEEKS; w += 1) {
    const first = new Date(start);
    first.setDate(start.getDate() + w * 7);
    months += `<span>${first.getMonth() !== lastMonth ? esc(first.toLocaleDateString([], { month: "short" })) : ""}</span>`;
    lastMonth = first.getMonth();
    for (let d = 0; d < 7; d += 1) {
      const day = new Date(first);
      day.setDate(first.getDate() + d);
      const list = byDay.get(dayKey(day)) ?? [];
      if (day > today || list.length === 0) {
        cells += `<span class="rec-day${day > today ? " is-future" : ""}"></span>`;
        continue;
      }
      const g = list.find(cameTo) ?? list[0];
      const label = `${fmtDay(g.startsAt)}: ${cameTo(g) ? "showed up" : "missed"}, ${titleCase(g.sport)} at ${g.venueName}`;
      cells += `<button type="button" class="rec-day ${cameTo(g) ? "is-played" : "is-missed"}"
        data-rec="${esc(g.hash)}" data-recs="${esc(list.map((x) => x.hash).join(" "))}"
        title="${esc(label)}" aria-label="${esc(label)}"></button>`;
    }
  }
  return `
    <div class="rec-cal" style="--weeks:${WEEKS}">
      <div class="rec-months" aria-hidden="true">${months}</div>
      <div class="rec-grid">${cells}</div>
      <div class="rec-key"><span><i class="rec-day is-played is-ok"></i>Showed up</span><span><i class="rec-day is-missed is-ok"></i>Missed</span></div>
    </div>`;
}

function gameRow(g) {
  const played = cameTo(g);
  // The host vouched for a game the phone missed.
  const byHost = played && g.kind !== "checkin";
  return `
    <li><button type="button" class="pay-row rec-row" data-rec="${esc(g.hash)}" data-recs="${esc(g.hash)}">
      <span class="res-icon">${sportIcon(g.sport)}</span>
      <span class="pay-text"><span><strong>${esc(titleCase(g.sport))}</strong> · ${esc(g.venueName)}</span>
        <span class="pay-sub">${esc(fmtDay(g.startsAt))} · ${esc(clockText(g.at))}${g.result ? ` · ${esc(RESULT_WORD[g.result.forThem] ?? "")}` : ""}</span></span>
      <span class="rec-state ${played ? "is-played" : "is-missed"}">${ICON.check}${byHost ? "Here (host)" : played ? "Checked in" : "Missed"}</span>
    </button></li>`;
}

/**
 * League seasons on the record (member + the team's standing + the
 * season naming who ran it). The browser asks the chain about the
 * member record itself; "Who vouched" is the league that finished it.
 */
function seasonsHtml(seasons) {
  if (!seasons?.length) return "";
  return `
    <section class="rec-seasons">
      <h3 class="pay-sub">League seasons</h3>
      <ul class="pay-list">${seasons.map((x) => {
        const st = x.standing;
        const line = st ? `${ordinalPlace(st.place)} of ${x.teams} · ${st.wins}-${st.losses}${st.ties ? `-${st.ties}` : ""}` : `${x.teams} teams`;
        const tx = x.member?.txHash ? explorerUrlFor(x.member.txHash, { kind: "tx" }) : "";
        return `
          <li class="pay-row rec-row rec-season" data-season-hash="${esc(x.member?.hash ?? "")}">
            <span class="res-icon">${ICON.trophy}</span>
            <span class="pay-text">
              <span><strong>${x.team ? `<a href="#/team/${esc(x.team.id)}">${esc(x.team.name)}</a>` : "A team"}</strong> · <a href="#/season/${esc(x.seasonId)}">${esc(x.league)} · ${esc(x.season)}</a></span>
              <span class="pay-sub">${esc(line)} · Who vouched: <a href="#/org/${esc(x.organizer.slug)}">${esc(x.organizer.name)}</a>${x.organizer.verified ? "" : " (not verified yet)"}</span>
            </span>
            ${tx ? `<a class="rec-state is-played" href="${esc(tx)}" target="_blank" rel="noopener" data-season-state>${ICON.check}Verified</a>`
              : `<span class="rec-state is-played" data-season-state>${ICON.check}Verified</span>`}
          </li>`;
      }).join("")}</ul>
    </section>`;
}

const ordinalPlace = (n) => {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
};

/** Ask the chain about each season's member record from the browser; flag one it does not find. */
async function checkSeasons(box, s) {
  const chain = s.record.chain;
  for (const li of box.querySelectorAll("[data-season-hash]")) {
    const hash = li.dataset.seasonHash;
    if (!hash) continue;
    const at = await askWrittenAt({ rpcUrl: chain?.rpcUrl, contract: chain?.contract, hash });
    if (at === false && li.isConnected) {
      const state = li.querySelector("[data-season-state]");
      if (state) { state.className = "rec-state is-missed"; state.textContent = "Not found on chain"; }
    }
  }
}

function recordLink(id) {
  return `${location.origin}${location.pathname}#/record/${id}`;
}

/** Who can see the games. Public is the default; private keeps a share link as the exception. */
function shareBox(s) {
  const hidden = Boolean(s.record.private);
  const link = hidden && s.share ? recordLink(s.share.token) : recordLink(s.record.player.id);
  const actions = hidden
    ? (s.share
      ? `<div class="pay-row-actions">
          <button type="button" class="btn-game" data-send-link="${esc(link)}">Send link</button>
          <button type="button" class="btn-game btn-game-ghost" data-unshare>Turn link off</button>
        </div>`
      : `<div class="pay-row-actions"><button type="button" class="btn-game" data-share>Create a link</button></div>`)
    : `<div class="pay-row-actions">
        <button type="button" class="btn-game" data-send-link="${esc(link)}">Send link</button>
      </div>`;
  return `
    <section class="rec-share">
      <h4 class="res-title">Who can see this</h4>
      <button type="button" class="rec-private" data-private role="switch" aria-checked="${hidden}">
        <span>Keep it private</span>
        <span class="theme-switch${hidden ? " on" : ""}"></span>
      </button>
      <p class="res-hint">${hidden
        ? "Only you can see these games. A link you send still opens them, and you can turn that link off."
        : "Anyone can open this record from your profile."}</p>
      ${hidden && s.share ? `<button type="button" class="pay-address" data-copy-link="${esc(link)}" aria-label="Copy your link"><span>${esc(link)}</span>${ICON.link}</button>` : ""}
      ${!hidden ? `<button type="button" class="pay-address" data-copy-link="${esc(link)}" aria-label="Copy your link"><span>${esc(link)}</span>${ICON.link}</button>` : ""}
      ${actions}
    </section>
    ${portableBox(s)}`;
}

/** Take the record with you: the file anyone can check without SportsArc, and your wallet's signature on it. */
function portableBox(s) {
  const owned = s.record.ownership;
  const hasWallet = Boolean(getUser()?.circle?.walletAddress);
  return `
    <section class="rec-share">
      <h4 class="res-title">Take it with you</h4>
      <p class="res-hint">One file with every entry. Anyone can check it against the public record, without SportsArc. It shows these games are yours, so send it only to people you choose.</p>
      <div class="pay-row-actions">
        <button type="button" class="btn-game" data-export>Download my record</button>
        ${owned
          ? `<span class="rec-owned">${ICON.shield}Signed by your wallet</span>`
          : hasWallet ? `<button type="button" class="btn-game btn-game-ghost" data-own>Sign with my wallet</button>` : ""}
      </div>
      <p class="res-hint">${owned
        ? "Your wallet's signature is in the file, so it shows the record is yours."
        : "Signing adds proof that the record is yours. Nothing is sent and nothing is charged."}
        <a class="pay-proof" href="/verify-record.mjs" download>Get the checker</a></p>
    </section>`;
}

/** Save the portable record as a file. */
async function downloadRecord() {
  const { file } = await apiGet("/api/web3/record/record/export");
  const blob = new Blob([`${JSON.stringify(file, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `sportsarc-record-${file.exportedAt.slice(0, 10)}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return file;
}

/** Your wallet signs that this record is yours (PIN, no fee). */
async function signOwnership() {
  const start = await apiSend("/api/web3/record/record/ownership", "POST");
  const signature = await runSignature(start.challenge);
  const done = await apiSend("/api/web3/record/record/ownership/confirm", "POST", { signatureId: start.signatureId, signature });
  return done.ownership;
}

function paintHidden(box, s) {
  const player = s.record.player;
  const profileHref = s.guest || !player?.id ? "" : `#/u/${player.id}`;
  box.innerHTML = `
    <header class="rec-head">
      ${avatar(player, "md", profileHref ? { href: profileHref } : {})}
      <div class="rec-who">
        <h2 class="games-title">${profileHref ? personLink(player, { fallback: "Player" }) : esc(player.name ?? "Player")}</h2>
        <p class="pay-sub">Verified record${player.role ? ` · ${esc(titleCase(player.role))}` : ""}</p>
      </div>
    </header>
    <p class="empty">This record is private<span class="empty-sub">The games stay with ${esc(firstName(player.name))} unless they send a link.</span></p>`;
}

function paintRecord(box, s) {
  if (s.record.private && !s.own) { paintHidden(box, s); return; }
  const { player, games } = s.record;
  const showed = games.filter(cameTo).length;
  const oldest = games[games.length - 1];
  const verifying = s.record.verifying?.count ?? 0;

  const stats = games.length === 0 ? "" : `
    <div class="rec-stats">
      <div><strong>${showed}</strong><span>verified ${showed === 1 ? "game" : "games"}</span></div>
      <div><strong>${showed} of ${games.length}</strong><span>showed up</span></div>
      <div><strong>${esc(new Date(oldest.startsAt).toLocaleDateString([], { month: "short", year: "numeric" }))}</strong><span>since</span></div>
    </div>`;

  const list = s.showAll ? games : games.slice(0, LIST_FIRST);
  const body = games.length === 0
    ? `<p class="empty">No verified games yet<span class="empty-sub">${s.own
        ? "Check in at your next game and it shows up here." : "Games appear here once they are checked in at the venue."}</span></p>`
    : `${calendar(games)}
      <div class="rec-check">
        <span class="rec-check-status" data-status aria-live="polite"></span>
        <button type="button" class="btn-game btn-game-ghost" data-recheck hidden>Check again</button>
      </div>
      <ul class="pay-list">${list.map(gameRow).join("")}</ul>
      ${games.length > list.length ? `<button type="button" class="btn-game btn-game-ghost rec-more" data-all>Show all ${games.length} games</button>` : ""}`;

  const profileHref = s.guest || !player?.id ? "" : `#/u/${player.id}`;
  box.innerHTML = `
    <header class="rec-head">
      ${avatar(player, "md", profileHref ? { href: profileHref } : {})}
      <div class="rec-who">
        <h2 class="games-title">${profileHref ? personLink(player, { fallback: "Player" }) : esc(player.name ?? "Player")}</h2>
        <p class="pay-sub">Verified record${player.role ? ` · ${esc(titleCase(player.role))}` : ""}</p>
      </div>
    </header>
    ${stats}
    ${verifying > 0 ? `<p class="rec-pending">${verifying} recent ${verifying === 1 ? "game is" : "games are"} being verified. Usually within ${s.record.verifying.withinMin} min.</p>` : ""}
    ${seasonsHtml(s.record.seasons)}
    ${body}
    ${s.own ? shareBox(s) : ""}`;
  paintChecks(box, s);
  void checkSeasons(box, s);
}

/** Fill in every square and row whose games have an answer. */
function paintChecks(box, s) {
  box.querySelectorAll("[data-recs]").forEach((el) => {
    const answers = el.dataset.recs.split(" ").map((hash) => s.results.get(hash));
    if (answers.some((a) => a === undefined)) return;
    el.classList.toggle("is-ok", answers.every(isThere));
    el.classList.toggle("is-bad", answers.some((a) => a === false));
  });
  const status = $("[data-status]", box);
  if (!status) return;
  const total = s.record.games.length;
  const done = s.results.size;
  const ok = [...s.results.values()].filter(isThere).length;
  const bad = [...s.results.values()].filter((a) => a === false).length;
  status.className = `rec-check-status${done < total ? "" : bad ? " is-bad" : ok === total ? " is-ok" : ""}`;
  status.innerHTML = done < total
    ? `Checking the public record… ${done} of ${total}`
    : bad
      ? `${bad} of ${total} ${bad === 1 ? "does" : "do"} not match the public record.`
      : ok === total
        ? `${ICON.check}${total === 1 ? "The game matches" : `All ${total} games match`} the public record.`
        : `${ok} of ${total} match. The rest could not be checked right now.`;
  const again = $("[data-recheck]", box);
  if (again) again.hidden = done < total;
}

/** Ask about every game, a few at a time, painting each answer as it lands. */
async function runChecks(box, s) {
  const run = (s.run = (s.run ?? 0) + 1);
  s.results = new Map();
  box.querySelectorAll(".is-ok, .is-bad").forEach((el) => {
    if (el.dataset.recs) el.classList.remove("is-ok", "is-bad");
  });
  paintChecks(box, s);
  const queue = [...s.record.games].reverse();
  const worker = async () => {
    for (let g = queue.shift(); g; g = queue.shift()) {
      const { answer, via } = await checkGame(g, s.record.chain);
      if (s.run !== run || !box.isConnected) return;
      s.results.set(g.hash, answer);
      s.via.set(g.hash, via);
      paintChecks(box, s);
    }
  };
  await Promise.all(Array.from({ length: CHECKS_AT_ONCE }, worker));
}

function bindRecord(box, s) {
  box.addEventListener("click", async (e) => {
    const on = (sel) => e.target.closest(sel);
    let el;
    if ((el = on("[data-rec]"))) {
      const g = s.record.games.find((x) => x.hash === el.dataset.rec);
      if (g) openReceipt(g, { player: s.record.player, chain: s.record.chain, known: s.results.get(g.hash), via: s.via.get(g.hash) });
    } else if (on("[data-all]")) {
      s.showAll = true;
      paintRecord(box, s);
    } else if (on("[data-recheck]")) {
      void runChecks(box, s);
    } else if ((el = on("[data-copy-link]"))) {
      void copyText(el.dataset.copyLink, "Link copied.");
    } else if ((el = on("[data-send-link]"))) {
      void shareLink({ title: "My verified record on SportsArc", url: el.dataset.sendLink });
    } else if (on("[data-private]")) {
      const next = !s.record.private;
      try {
        const r = await apiSend("/api/web3/record/record/privacy", "POST", { private: next });
        s.record.private = r.private;
        paintRecord(box, s);
        toast(next ? "Your record is private." : "Your record is visible on your profile.");
      } catch (err) {
        toast(err.message);
      }
    } else if ((el = on("[data-export]"))) {
      el.disabled = true;
      try {
        const file = await downloadRecord();
        toast(`Saved your record: ${file.records.length} entries.`);
      } catch (err) {
        toast(err.message);
      } finally {
        el.disabled = false;
      }
    } else if ((el = on("[data-own]"))) {
      el.disabled = true;
      try {
        const o = await signOwnership();
        s.record.ownership = o ? { wallet: o.wallet, signedAt: o.signedAt } : null;
        paintRecord(box, s);
        toast("Signed. Your next download carries it.");
      } catch (err) {
        toast(err.message);
        if (el.isConnected) el.disabled = false;
      }
    } else if (on("[data-share]") || on("[data-unshare]")) {
      const off = Boolean(on("[data-unshare]"));
      try {
        const r = await apiSend("/api/web3/record/record/share", off ? "DELETE" : "POST");
        s.share = off ? null : { token: r.token };
        paintRecord(box, s);
        toast(off ? "Link turned off. It no longer opens." : "Your link is ready.");
      } catch (err) {
        toast(err.message);
      }
    }
  });
}

/**
 * `rest` empty: your own record. A user id is that player's public record.
 * Anything else is a share-link token.
 */
export async function renderRecordPage(rest = "", { guest = false } = {}) {
  main().innerHTML = `<div class="pay-page rec-page"><p class="empty">Loading the record…</p></div>`;
  const box = $(".rec-page");
  const me = getUser();
  const own = !rest || (me && rest.toLowerCase() === me.id.toLowerCase());
  const byUser = !own && UUID.test(rest);
  let record;
  try {
    record = await apiGet(own
      ? "/api/web3/record/mine"
      : byUser
        ? `/api/web3/record/users/${encodeURIComponent(rest)}/record`
        : `/api/web3/record/records/${encodeURIComponent(rest)}`);
  } catch (err) {
    if (box.isConnected) box.innerHTML = notice(rest ? "This link is not available" : "Could not load your record", err.message);
    return;
  }
  if (!box.isConnected) return;
  const s = { record, own, guest, share: record.share ?? null, results: new Map(), via: new Map(), showAll: false };
  paintRecord(box, s);
  bindRecord(box, s);
  if (!record.private || own) {
    if (record.games.length) void runChecks(box, s);
  }
}

// ── the receipt ───────────────────────────────────────────────────────

/** A seat's result in one word, for lists and the receipt. */
const RESULT_WORD = { won: "Won", lost: "Lost", draw: "Draw", sat_out: "Sat out", not_played: "Not played" };

const BARE_TITLE = {
  checkin: "A check-in on the public record",
  missed: "A missed game on the public record",
  result: "A result on the public record",
  game: "A game on the public record",
  presence: "The host's word on the public record",
};

/** A tick, a cross, or a quiet dot while the network has not answered. */
function mark(answer) {
  if (isThere(answer)) return { cls: "is-ok", icon: ICON.check, label: "On the public record" };
  if (answer === false) return { cls: "is-bad", icon: ICON.close, label: "Not on the public record" };
  return { cls: "is-wait", icon: "", label: answer === undefined ? "Checking" : "Could not check" };
}

/** Who recorded the result: the host or a co-host, named only on your own record. */
function recorder(g) {
  const r = g.result?.recordedBy;
  const role = g.result?.recordedByHost === false ? "a co-host" : "the host";
  return r?.name && getUser() ? `${role}, ${firstName(r.name)}` : role;
}

/**
 * The receipt's facts, one row each: what it says, who vouched, and the
 * network's answer for that entry. `answers` holds the main entry's, the
 * result's and the game's.
 */
function factRows(g, answers, mine) {
  const rows = [];
  // A bare #/verify link has no details: one row, the entry itself.
  if (!g.venueName) {
    const label = { checkin: "Check-in", missed: "Missed game", result: "Result", game: "Game", presence: "Host's word" }[g.kind] ?? "Entry";
    rows.push([label, g.recordedAt ? `Written ${fmtStamp(g.recordedAt)}` : "Not written yet", "", answers.main]);
    return rowsHtml(g, rows);
  }
  if (g.kind === "checkin") rows.push(["Showed up", clockText(g.at), mine ? "your phone at the venue" : "phone at the venue", answers.main]);
  if (g.kind === "missed") rows.push(["Missed", "Held a spot, no check-in", "SportsArc", answers.main]);
  if (g.presence) {
    // The host's word beside the phone's: say so when they disagree.
    const differs = (g.kind === "checkin") !== g.presence.present;
    rows.push(["Host", g.presence.present ? "Was here" : "Wasn't here",
      differs ? "the host · differs from the check-in" : "confirmed by the host", answers.presence]);
  }
  if (g.result) rows.push(["Result", RESULT_WORD[g.result.forThem] ?? "", `recorded by ${recorder(g)}`, answers.result]);
  if (g.gameRecord) rows.push(["Game", "Sport, venue and time", "SportsArc", answers.game]);
  return rowsHtml(g, rows);
}

function rowsHtml(g, rows) {
  return rows.map(([k, v, who, answer]) => {
    const m = g.recordedAt ? mark(answer) : { cls: "is-wait", icon: "", label: "Being written" };
    return `<li class="${m.cls}"><span class="rcpt-fact-k">${esc(k)}</span>
      <span class="rcpt-fact-v">${esc(v)}${who ? `<small>${esc(who)}</small>` : ""}</span>
      <span class="rcpt-fact-s" title="${esc(m.label)}" aria-label="${esc(m.label)}">${m.icon}</span></li>`;
  }).join("");
}

/** The one line about the public record: there, missing, or still being written. */
function statusLine(g, answers, via) {
  if (!g.recordedAt) return { cls: "is-wait", text: "Being written to the public record. Usually within a minute or two." };
  const all = [answers.main, g.presence ? answers.presence : null, g.result ? answers.result : null, g.gameRecord ? answers.game : null]
    .filter((a) => a !== null);
  if (all.some((a) => a === undefined)) return { cls: "is-wait", text: "Checking the public record…" };
  if (all.some((a) => a === false)) return { cls: "is-bad", text: "Something here is not on the public record. Don't rely on this game until it's cleared up." };
  if (!isThere(answers.main)) return { cls: "is-wait", text: "The public record could not be reached. Try again in a moment." };
  const from = via === "server" ? "checked by SportsArc" : "checked from your phone";
  return { cls: "is-ok", text: `On the public record since ${fmtStamp(answers.main)}, unchanged. ${from.replace(/^./, (c) => c.toUpperCase())}.` };
}

/** Each entry's ID and transaction, and how to check one without SportsArc. */
function checkYourself(g, chain) {
  if (!g.recordedAt) return "";
  const entries = [
    ["Record", g.hash, g.txHash], ["Host", g.presence?.hash, g.presence?.txHash],
    ["Result", g.result?.hash, g.result?.txHash], ["Game", g.gameRecord?.hash, g.gameRecord?.txHash],
  ]
    .filter(([, h]) => h);
  const contract = g.contract ? explorerUrlFor(g.contract) : "";
  return `
    <details class="rcpt-tech">
      <summary>Check it yourself</summary>
      <ul class="rcpt-ids">${entries.map(([label, hash, tx]) => `
        <li><span>${label}</span><a class="pay-proof" href="#/verify/${esc(hash)}"><code>${esc(short(hash))}</code></a>
          <button type="button" class="icon-btn" data-copy="${esc(hash)}" aria-label="Copy the ${label.toLowerCase()} ID" title="Copy">${ICON.copy}</button>
          ${tx ? `<a class="pay-proof" href="${esc(explorerUrlFor(tx, { kind: "tx" }))}" target="_blank" rel="noopener">Transaction${ICON.external}</a>` : "<span></span>"}</li>`).join("")}
      </ul>
      <p class="res-hint">Paste an ID into <b>writtenAt</b> on the ${contract
        ? `<a class="pay-proof" href="${esc(`${contract}?tab=read_contract`)}" target="_blank" rel="noopener">record contract${ICON.external}</a>`
        : "record contract"}${chain?.name ? ` (${esc(chain.name)})` : ""}. Any answer but 0 is when it was written.</p>
    </details>`;
}

/**
 * One game's receipt. `g` is a record game; `player` is absent on a bare
 * #/verify link, where the details were never shared. `answers` are the
 * network's: { main, result, game }, each a time, false, null or undefined.
 */
function receiptHtml(g, { player, chain, answers = {}, via }) {
  const played = g.kind === "checkin";
  const me = getUser();
  const mine = Boolean(player?.id && me && player.id === me.id);
  const who = player ? (mine ? "You" : firstName(player.name)) : null;
  // A shared link opens signed out. A profile link there would drop the visitor on the sign-in screen.
  const whoHtml = !who ? "" : mine ? "You" : player?.id && me ? personLink(player, { label: who }) : esc(who);
  const title = who
    ? (played ? `${whoHtml} checked in` : `${whoHtml} missed this game`)
    : esc(BARE_TITLE[g.kind] ?? BARE_TITLE.checkin);
  const where = g.venueName
    ? `<p class="pay-sub">${sportIcon(g.sport)} ${esc(titleCase(g.sport))} · ${esc(g.venueName)} · ${esc(fmtDay(g.startsAt))} · ${esc(clockText(g.startsAt))}</p>`
    : "";
  const status = statusLine(g, answers, via);
  const icon = status.cls === "is-bad" ? ICON.close : status.cls === "is-ok"
    ? (g.kind === "missed" ? ICON.clipboard : g.kind === "result" ? ICON.trophy : g.kind === "game" ? ICON.ball : ICON.check)
    : ICON.shield;
  const state = { "is-ok": "verify-ok", "is-bad": "verify-bad", "is-wait": "verify-wait" }[status.cls];
  return `
    <div class="rcpt ${state}${played ? "" : " rcpt-missed"}">
      <span class="verify-mark">${icon}</span>
      <h3>${title}</h3>
      ${where}
      <ul class="rcpt-facts">${factRows(g, answers, mine)}</ul>
      <p class="rcpt-status ${status.cls}" data-live>${status.cls === "is-ok" ? ICON.shield : ""}<span>${esc(status.text)}</span></p>
      ${player ? "" : `<p class="res-hint">This link shows one entry without names. A player can share their whole record instead.</p>`}
      ${checkYourself(g, chain)}
    </div>`;
}

/** The receipt's markup for one state, for docs/verified-record/previews (scripts/record-previews.mjs). */
export const receiptMarkup = receiptHtml;

/**
 * Paint the receipt, then ask the network about this game's entries: the
 * main one (unless the page already has) and its result and game records.
 */
async function showReceipt(el, g, ctx) {
  let answers = { main: ctx.known, presence: undefined, result: undefined, game: undefined };
  let via = ctx.via;
  const paint = () => { el.innerHTML = receiptHtml(g, { ...ctx, answers, via }); bindCopyButtons(el); };
  paint();
  if (!g.recordedAt) return;
  const ask = (hash) => (hash ? checkGame({ hash, chainId: g.chainId, contract: g.contract }, ctx.chain) : Promise.resolve({ answer: null }));
  const [main, presence, result, game] = await Promise.all([
    ctx.known !== undefined ? Promise.resolve({ answer: ctx.known, via: ctx.via }) : ask(g.hash),
    g.presence?.recordedAt ? ask(g.presence.hash) : Promise.resolve({ answer: null }),
    g.result?.recordedAt ? ask(g.result.hash) : Promise.resolve({ answer: null }),
    g.gameRecord?.recordedAt ? ask(g.gameRecord.hash) : Promise.resolve({ answer: null }),
  ]);
  answers = { main: main.answer, presence: presence.answer, result: result.answer, game: game.answer };
  via = main.via;
  if (el.isConnected) paint();
}

function openReceipt(g, ctx) {
  const { body } = openSheet({ id: "receipt-sheet", title: "Receipt", className: "sheet-result" });
  void showReceipt(body, g, ctx);
}

/** #/verify/<id>: one record by its ID, with none of its details. */
export async function renderVerifyPage(hash) {
  main().innerHTML = `<div class="pay-page rec-page"><p class="empty">Checking the record…</p></div>`;
  const box = $(".rec-page");
  let r;
  try { r = await apiGet(`/api/web3/record/hashes/${encodeURIComponent(hash)}`); } catch (err) {
    if (box.isConnected) box.innerHTML = notice("Not found", err.message);
    return;
  }
  if (!box.isConnected) return;
  const g = {
    kind: { "noshow": "missed", "result": "result", "game": "game", "presence": "presence" }[r.kind] ?? "checkin",
    hash: r.hash,
    chainId: r.chain.chainId, contract: r.chain.contract, txHash: r.chain.txHash, blockNumber: r.chain.blockNumber,
    recordedAt: r.chain.writtenAt,
  };
  box.innerHTML = `<div class="verify-card rcpt-card"></div>`;
  void showReceipt($(".rcpt-card", box), g, { chain: r.network });
}
