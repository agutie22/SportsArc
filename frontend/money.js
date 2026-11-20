/**
 * Money: the on-chain side of SportsArc, kept in one module so the core
 * pages only call in. What lives here:
 *
 *   - Paying and asking players for money, and splitting a game's cost.
 *   - Moving money out: send your balance to another network (Base,
 *     Ethereum, ...) and any address there, over Circle CCTP. Circle
 *     delivers it on the other side, so nothing is needed on that network.
 *   - Adding money: from an outside wallet (MetaMask or similar) on another
 *     network, straight into the SportsArc wallet, also over CCTP. That
 *     wallet signs in its own window; it is only a source of money here,
 *     never a way to sign in.
 *   - Where money comes back: when a player enters a paid event they choose
 *     between their SportsArc wallet (the default) and an address on
 *     another network. The second is paid automatically when the event
 *     settles (Circle Gateway), less a small network fee.
 *
 * The verified record (check-ins written to SportsArcRecord) is record.js.
 *
 * Everything is signed by the player's own Circle wallet with their PIN.
 * Paying a person costs the player no fee: they sign an authorization
 * (runSignature) and the server sends the transfer for them. Moving money
 * out is a transaction from the player's wallet: the server builds it and
 * broadcasts what Circle signed. The screen
 * says "$5" and "confirm with your PIN", never "transaction", "approve" or
 * "USDC".
 */

import { $, getUser, ensureCircleSdk, toast, openSheet, explorerUrlFor, refreshWalletOnchain, ICON, main, shortAddr, copyText } from "./shared.js";
import { apiGet, apiSend, avatar, dayHeading, esc, personLink, sleep, timeAgo, titleCase, usd } from "./api.js";
import * as circleSdk from "./circle-sdk.js";


/** "5" or "$5.00" from the API, shown as "$5" or "$2.50". */
const money = (amount) => usd(amount, { short: true });

// ── signing ───────────────────────────────────────────────────────────

/** Run a Circle challenge in the SDK's PIN screen; resolves with its result. */
async function sign(challenge) {
  circleSdk.setSdkAuthentication({ userToken: challenge.userToken, encryptionKey: challenge.encryptionKey });
  try {
    return await circleSdk.executeChallenge(challenge.challengeId, "sign");
  } catch (err) {
    const cancelled = /cancel|closed|155706/i.test(err.message);
    throw new Error(cancelled ? "Cancelled. Nothing was sent." : err.message);
  }
}

/** A wallet and the PIN screen, ready to sign; sends the player to wallet setup without one. */
async function ensurePin() {
  if (!getUser()?.circle?.walletAddress) {
    document.dispatchEvent(new CustomEvent("sportsarc:wallet-setup"));
    throw new Error("Set up your wallet first, then try again.");
  }
  await ensureCircleSdk();
}

/**
 * Sign what the server asked for (a challenge it opened) with the PIN and
 * resolve with the signature. Nothing leaves the wallet here and there is
 * no fee: the server sends the transfer the signature authorizes.
 */
export async function runSignature(challenge) {
  await ensurePin();
  const result = await sign(challenge);
  const signature = result?.data?.signature;
  if (!signature) throw new Error("Cancelled. Nothing was sent.");
  return signature;
}

/**
 * The wallet that signs transactions (moving money out): created
 * with the account's wallet, but it needs a one-time PIN confirmation
 * before its first one.
 */
async function ensureSigningWallet() {
  await ensurePin();
  for (let i = 0; i < 12; i++) {
    const r = await apiSend("/api/web3/wallet", "POST");
    if (r.wallet.status === "ready") return;
    if (r.challenge) {
      toast("One-time setup: confirm with your PIN.");
      await sign(r.challenge);
    } else {
      await sleep(1500);
    }
  }
  throw new Error("Your wallet is still getting ready. Try again in a moment.");
}

async function waitForTx(id) {
  for (let i = 0; i < 60; i++) {
    const { tx } = await apiGet(`/api/web3/wallet/tx/${id}`);
    if (tx.status === "confirmed") return tx;
    if (tx.status === "failed" || tx.status === "dropped") {
      throw new Error(tx.error ? `It didn't go through: ${tx.error}` : "It didn't go through.");
    }
    await sleep(1000);
  }
  throw new Error("Still waiting for the network. Check back in a minute.");
}

// ── where money comes back ────────────────────────────────────────────

/**
 * Ask where money that may come back later (an entry fee, if the event does
 * not run) should go. Resolves with what the API takes as `payout`:
 * "wallet", { destinationId } or { chain, address }. Skips the question when
 * other networks are not on offer. Rejects if the player closes the sheet.
 * `copy` sets the sheet's title, hint and wallet note.
 */
export async function choosePayout(amount, copy = {}) {
  const title = copy.title ?? money(amount);
  const hint = copy.hint ?? `If ${money(amount)} comes back to you, where should it go?`;
  const walletNote = copy.walletNote ?? "It comes back to your SportsArc wallet.";
  let opts;
  try {
    opts = await apiGet("/api/web3/gateway/options");
  } catch {
    return "wallet";
  }
  if (!opts.available || !opts.chains.length) return "wallet";

  return new Promise((resolve, reject) => {
    const sheet = openSheet({ id: "payout-sheet", title, className: "sheet-result sheet-pay" });
    const body = sheet.body;
    let done = false;
    // Closed any other way (X, Escape, the scrim, navigation): nothing was sent.
    const watch = new MutationObserver(() => {
      if (sheet.sheet.isConnected) return;
      watch.disconnect();
      if (!done) reject(new Error("Cancelled. Nothing was sent."));
    });
    watch.observe(document.body, { childList: true });

    body.innerHTML = `
      <p class="res-hint">${esc(hint)}</p>
      <div class="payout-options" role="radiogroup" aria-label="Where your money comes back">
        <button type="button" class="chip chip-active" role="radio" aria-checked="true" data-pick="wallet">SportsArc wallet</button>
        ${opts.saved.map((d) => `<button type="button" class="chip" role="radio" aria-checked="false" data-pick="${esc(d.id)}">${esc(d.chainName)} · ${esc(shortAddr(d.address))}</button>`).join("")}
        <button type="button" class="chip" role="radio" aria-checked="false" data-pick="new">Another network…</button>
      </div>
      <form class="host-form pay-form" novalidate>
        <div class="pay-fields" data-new hidden>
          <label><span>Network</span>
            <select name="chain">${opts.chains.map((c) => `<option value="${esc(c.key)}">${esc(c.name)}</option>`).join("")}</select>
          </label>
          <label><span>Address</span>
            <input name="address" autocomplete="off" spellcheck="false" placeholder="0x…">
          </label>
        </div>
        <p class="res-hint" data-note>${esc(walletNote)}</p>
        <div class="pay-actions"><button type="submit" class="btn-game">${esc(title)}</button></div>
      </form>`;
    const form = $(".pay-form", body);
    let pick = "wallet";
    body.querySelectorAll("[data-pick]").forEach((b) => b.addEventListener("click", () => {
      pick = b.dataset.pick;
      body.querySelectorAll("[data-pick]").forEach((x) => {
        x.classList.toggle("chip-active", x === b);
        x.setAttribute("aria-checked", x === b ? "true" : "false");
      });
      $("[data-new]", body).hidden = pick !== "new";
      $("[data-note]", body).textContent = pick === "wallet"
        ? walletNote
        : "Sent there automatically after the game, less a small network fee (about $0.06). If it can't be delivered it goes to your SportsArc wallet.";
    }));
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      let choice = "wallet";
      if (pick === "new") {
        const address = form.address.value.trim();
        if (!/^0x[0-9a-fA-F]{40}$/.test(address)) { toast("That address doesn't look right."); return; }
        choice = { chain: form.chain.value, address };
      } else if (pick !== "wallet") {
        choice = { destinationId: pick };
      }
      done = true;
      sheet.close();
      resolve(choice);
    });
  });
}

// ── shared pieces of the money screens ────────────────────────────────


/**
 * The big amount entry every money sheet opens with. `quick` are one-tap
 * dollar amounts; `max` adds a "Max" chip once the balance is known.
 */
function amountField({ name = "amount", quick = [], max = false } = {}) {
  return `
    <div class="amt">
      <label class="amt-field"><span class="amt-cur">$</span><input name="${name}" type="text" inputmode="decimal" autocomplete="off" placeholder="0" aria-label="Amount in dollars" required></label>
      <p class="amt-sub" data-amt-sub aria-live="polite"></p>
      ${quick.length || max ? `<div class="amt-quick">
        ${quick.map((q) => `<button type="button" class="chip" data-amt="${q}">${money(q)}</button>`).join("")}
        ${max ? `<button type="button" class="chip" data-amt-max hidden>Max</button>` : ""}
      </div>` : ""}
    </div>`;
}

/**
 * Wire an amountField: keeps the input to dollars and cents, sizes it to
 * its text, and shows what is available under it. `spends` warns when the
 * amount is more than the wallet holds; `note(n)` may supply its own line.
 */
function wireAmount(root, { name = "amount", spends = true, note, onChange } = {}) {
  const input = root.querySelector(`input[name="${name}"]`);
  const sub = $("[data-amt-sub]", root);
  const field = input.closest(".amt-field");
  let balance = null;
  const paint = () => {
    const n = Number(input.value);
    input.style.width = `${Math.max(1, input.value.length)}ch`;
    field.classList.toggle("amt-long", input.value.length > 6);
    const over = spends && balance !== null && n > balance;
    sub.classList.toggle("amt-over", over);
    const own = note?.(n);
    sub.textContent = over
      ? `More than your balance (${usd(balance)})`
      : own ?? (spends && balance !== null ? `${usd(balance)} available` : "");
  };
  const set = (v) => { input.value = v; paint(); onChange?.(); };
  input.addEventListener("input", () => {
    const [whole, ...rest] = input.value.replace(/[^0-9.]/g, "").split(".");
    const clean = rest.length ? `${whole}.${rest.join("").slice(0, 2)}` : whole;
    if (clean !== input.value) input.value = clean;
    paint();
    onChange?.();
  });
  root.querySelectorAll("[data-amt]").forEach((b) => b.addEventListener("click", () => set(b.dataset.amt)));
  $("[data-amt-max]", root)?.addEventListener("click", () => { if (balance !== null) set(String(Math.floor(balance * 100) / 100)); });
  paint();
  if (spends) {
    void refreshWalletOnchain().then((b) => {
      if (b == null || !input.isConnected) return;
      balance = Number(b);
      const maxBtn = $("[data-amt-max]", root);
      if (maxBtn && balance > 0) maxBtn.hidden = false;
      paint();
    });
  }
  setTimeout(() => input.focus(), 60);
  return { input, value: () => input.value.trim(), repaint: paint };
}

/** A button that is working: spinner and a short label, back with `false`. */
function setBusy(btn, label) {
  if (!btn) return;
  if (label === false) {
    btn.disabled = false;
    btn.classList.remove("is-busy");
    if (btn.dataset.label) btn.textContent = btn.dataset.label;
    return;
  }
  btn.dataset.label ??= btn.textContent;
  btn.disabled = true;
  btn.classList.add("is-busy");
  btn.textContent = label;
}

/** The sheet's closing screen: what happened, in one line, and a way out. `title` and `text` are plain text. */
function showDone(sheet, { title, text = "", link = "", pending = false }) {
  sheet.body.innerHTML = `
    <div class="pay-done">
      <span class="pay-done-mark${pending ? " is-pending" : ""}">${pending ? ICON.arrowUp : ICON.check}</span>
      <h3>${esc(title)}</h3>
      ${text ? `<p class="res-hint">${esc(text)}</p>` : ""}
      ${link}
      <div class="pay-actions"><button type="button" class="btn-game" data-done>Done</button></div>
    </div>`;
  $("[data-done]", sheet.body).addEventListener("click", sheet.close);
}

function receiptLink(href, label = "Receipt") {
  return href ? `<a class="pay-proof" href="${esc(href)}" target="_blank" rel="noopener">${label}</a>` : "";
}

function txLink(explorer, hash, label) {
  if (!explorer || !hash) return "";
  return receiptLink(`${explorer.replace(/\/+$/, "")}/tx/${hash}`, label);
}

// ── payments ──────────────────────────────────────────────────────────

/** Pay a request, or start a direct payment: one PIN, no fee. Resolves once it is paid. */
async function pay(body, label) {
  await ensurePin();
  const started = await apiSend("/api/web3/pay", "POST", body);
  const confirm = `/api/web3/pay/${started.payment.id}/confirm`;
  let signature;
  try {
    toast(`Confirm with your PIN to pay ${label}.`);
    signature = await runSignature(started.challenge);
  } catch (err) {
    await apiSend(`/api/web3/pay/${started.payment.id}/cancel`, "POST").catch(() => {});
    throw err;
  }
  let { payment } = await apiSend(confirm, "POST", { signature });
  for (let i = 0; payment.status === "pending" && i < 30; i++) {
    await sleep(2000);
    ({ payment } = await apiSend(confirm, "POST", {}));
  }
  if (payment.status === "pending") throw new Error("Still waiting for the network. Check back in a minute.");
  if (payment.status !== "paid") throw new Error("It didn't go through. Nothing was taken.");
  void refreshWalletOnchain();
  return payment;
}

/** Pay or ask someone for money, from their profile or the Payments page. */
export function openPaySheet(person, onDone) {
  const sheet = openSheet({ id: "pay-sheet", title: "Pay or request", className: "sheet-result sheet-pay" });
  const body = sheet.body;
  const name = person.name ?? "Player";
  body.innerHTML = `
    <div class="pay-who">${avatar(person, "md", { href: person.id ? `#/u/${person.id}` : "" })}${personLink(person, { fallback: "Player" })}</div>
    <form class="host-form pay-form" novalidate>
      ${amountField({ quick: [5, 10, 20] })}
      <input class="pay-note" name="note" maxlength="80" placeholder="What's it for? Court fee, balls, a ride…" aria-label="What it is for">
      <div class="pay-actions">
        <button type="button" class="btn-game btn-game-ghost" data-request>Request</button>
        <button type="submit" class="btn-game">Pay</button>
      </div>
    </form>`;
  const form = $(".pay-form", body);
  const payBtn = form.querySelector("button[type=submit]");
  const askBtn = $("[data-request]", body);
  const amt = wireAmount(form, {
    onChange: () => { payBtn.textContent = Number(amt?.value()) > 0 ? `Pay ${money(amt.value())}` : "Pay"; },
  });
  const values = () => ({ amount: amt.value(), note: form.note.value.trim() || undefined });
  const idle = () => { setBusy(payBtn, false); setBusy(askBtn, false); delete payBtn.dataset.label; };

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = values();
    if (!(Number(v.amount) > 0)) { toast("Enter an amount."); return; }
    askBtn.disabled = true;
    setBusy(payBtn, "Paying…");
    try {
      const paid = await pay({ userId: person.id, ...v }, `${name} ${money(v.amount)}`);
      const href = paid.txHash ? explorerUrlFor(paid.txHash, { kind: "tx" }) : "";
      showDone(sheet, { title: `Paid ${name} ${money(v.amount)}`, text: v.note ?? "", link: receiptLink(href, "See the receipt") });
      onDone?.();
    } catch (err) {
      toast(err.message);
      idle();
    }
  });
  askBtn.addEventListener("click", async () => {
    const v = values();
    if (!(Number(v.amount) > 0)) { toast("Enter an amount."); return; }
    payBtn.disabled = true;
    setBusy(askBtn, "Asking…");
    try {
      await apiSend("/api/web3/pay/requests", "POST", { userId: person.id, ...v });
      showDone(sheet, {
        title: `Asked ${name} for ${money(v.amount)}`,
        text: "They get a request they can pay in one tap.",
      });
      onDone?.();
    } catch (err) {
      toast(err.message);
      idle();
    }
  });
}

/** Pick who to pay or ask: people you have played with first, anyone by search. */
function openSendSheet(onDone) {
  const sheet = openSheet({ id: "send-sheet", title: "Pay or request", className: "sheet-result sheet-pay" });
  const body = sheet.body;
  body.innerHTML = `
    <input class="pay-note pay-search" type="search" placeholder="Search by name" aria-label="Search people" enterkeyhint="search">
    <h4 class="pay-kicker" data-kicker></h4>
    <ul class="pay-list pay-ledger" data-people></ul>`;
  const list = $("[data-people]", body);
  const kicker = $("[data-kicker]", body);
  const me = getUser()?.id;
  let people = [];
  let seq = 0;
  const show = (found, label, empty) => {
    people = found.filter((p) => p.id !== me);
    kicker.textContent = people.length ? label : "";
    list.innerHTML = people.length
      ? people.map((p) => `
          <li><button type="button" class="led-row led-pick" data-person="${esc(p.id)}">
            ${avatar(p, "sm")}
            <span class="led-main"><span class="led-title">${esc(p.name ?? "Player")}</span>
              <span class="led-sub">${esc([p.primarySport && titleCase(p.primarySport), p.school, p.location].filter(Boolean).join(" · "))}</span></span>
          </button></li>`).join("")
      : `<li class="pay-empty"><p>${esc(empty)}</p></li>`;
  };
  const load = async (q) => {
    const mine = ++seq;
    try {
      const r = q ? await apiGet("/api/people", { q }) : await apiGet("/api/people/played-with");
      if (mine !== seq || !list.isConnected) return;
      show(r.people ?? [], q ? "People" : "Played with", q ? "Nobody matches that." : "Search for someone to pay or ask.");
    } catch (err) {
      if (mine === seq) show([], "", err.message);
    }
  };
  let timer;
  $(".pay-search", body).addEventListener("input", (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => void load(e.target.value.trim()), 250);
  });
  list.addEventListener("click", (e) => {
    const person = people.find((p) => p.id === e.target.closest("[data-person]")?.dataset.person);
    if (!person) return;
    sheet.close();
    openPaySheet(person, onDone);
  });
  void load("");
}

/** The host splits a cost (court fee, balls) across everyone in the game. */
export function openSplitSheet(game) {
  const sheet = openSheet({ id: "split-sheet", title: "Split a cost", className: "sheet-result sheet-pay" });
  const body = sheet.body;
  const people = Math.max(1, game.joinedCount);
  body.innerHTML = `
    <form class="host-form pay-form" novalidate>
      ${amountField({ name: "total", quick: [10, 20, 40] })}
      <input class="pay-note" name="note" maxlength="80" value="Court fee" aria-label="What it is for">
      <p class="res-hint">Everyone in the game pays an equal share, you included. Each player gets a request they can pay in one tap.</p>
      <div class="pay-actions"><button type="submit" class="btn-game">Send requests</button></div>
    </form>`;
  const form = $(".pay-form", body);
  const amt = wireAmount(form, {
    name: "total",
    spends: false,
    note: (n) => (n > 0
      ? `${people} players · ${money(Math.floor((n / people) * 100) / 100)} each`
      : `Split between ${people} player${people === 1 ? "" : "s"}`),
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!(Number(amt.value()) > 0)) { toast("Enter the total."); return; }
    const btn = form.querySelector("button[type=submit]");
    setBusy(btn, "Sending…");
    try {
      const r = await apiSend("/api/web3/pay/requests", "POST", {
        gameId: game.id, total: amt.value(), note: form.note.value.trim() || undefined,
      });
      showDone(sheet, {
        title: `Asked ${r.requests.length} player${r.requests.length === 1 ? "" : "s"} for ${money(r.amountUsdc)} each`,
        text: "You'll see each one land in Payments as it's paid.",
      });
    } catch (err) {
      toast(err.message);
      setBusy(btn, false);
    }
  });
}

// ── moving money out (CCTP) ───────────────────────────────────────────

const OUT_ACTIVE = ["burn_approval", "burn", "attestation", "receive"];

/**
 * Run a withdrawal as far as it goes from here: each step that needs the
 * player's PIN (allow, then send) is signed and waited for; it stops once
 * the money has left and Circle is delivering it.
 */
async function driveWithdrawal(id) {
  for (let i = 0; i < 10; i++) {
    const r = await apiSend(`/api/web3/cctp/transfers/${id}/advance`, "POST");
    const t = r.transfer;
    if (t.state === "failed") throw new Error(t.lastError?.message ?? "It didn't go through.");
    if (r.waitingOn === "signature") {
      if (t.lastError?.code === "INSUFFICIENT_GAS") {
        throw new Error("Not enough money in your wallet to cover this and its fee.");
      }
      const challenge = r.challenge
        ?? (await apiSend(`/api/web3/wallet/tx/${t.stepTxId}/challenge`, "POST")).challenge;
      toast(t.state === "burn_approval" ? "Confirm with your PIN (1 of 2)." : "Confirm with your PIN to send it.");
      const res = await sign(challenge);
      const signed = res?.data?.signedTransaction;
      if (!signed) throw new Error("Cancelled. Nothing was sent.");
      await apiSend(`/api/web3/wallet/tx/${t.stepTxId}/signed`, "POST", { signedTransaction: signed });
      await waitForTx(t.stepTxId);
      continue;
    }
    if (r.waitingOn === "confirmation") {
      await waitForTx(t.stepTxId);
      continue;
    }
    if (r.waitingOn === "retry") throw new Error(t.lastError?.message ?? "Something went wrong. Try again.");
    return t;
  }
  throw new Error("Still working on it. Check back in a minute.");
}

/** The line-by-line cost of a transfer, shown before the player commits. */
function quoteRows(rows) {
  return rows.map(([k, v, strong]) => `<div${strong ? ` class="is-total"` : ""}><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("");
}

/** Send money to another network, to your own wallet there or any address. */
async function openWithdrawSheet(onDone) {
  const sheet = openSheet({ id: "withdraw-sheet", title: "Move money out", className: "sheet-result sheet-pay" });
  const body = sheet.body;
  body.innerHTML = `<div class="pay-loading"><span class="skel"></span><span class="skel"></span></div>`;
  let dest;
  try {
    dest = await apiGet("/api/web3/cctp/destinations");
  } catch (err) {
    body.innerHTML = `<p class="empty">${esc(err.message)}</p>`;
    return;
  }
  body.innerHTML = `
    <form class="host-form pay-form" novalidate>
      ${amountField({ max: true })}
      <div class="pay-fields">
        <label><span>To network</span>
          <select name="destination">${dest.destinations.map((d) => `<option value="${esc(d.key)}">${esc(d.name)}</option>`).join("")}</select>
        </label>
        <label><span>Address</span>
          <input name="recipient" autocomplete="off" spellcheck="false" placeholder="Your own wallet there">
        </label>
      </div>
      <dl class="pay-quote" data-quote hidden></dl>
      <p class="res-hint" data-quote-err hidden></p>
      <p class="res-hint">From your SportsArc wallet on ${esc(dest.source.name)}. Circle delivers it on the other side, usually within a few minutes.</p>
      <div class="pay-actions"><button type="submit" class="btn-game">Move money</button></div>
    </form>`;
  const form = $(".pay-form", body);
  const quoteEl = $("[data-quote]", body);
  const quoteErr = $("[data-quote-err]", body);
  let seq = 0;
  let timer;
  const requote = () => {
    clearTimeout(timer);
    const amount = amt.value();
    if (!(Number(amount) > 0)) { seq++; quoteEl.hidden = true; quoteErr.hidden = true; return; }
    timer = setTimeout(async () => {
      const mine = ++seq;
      try {
        const q = await apiGet("/api/web3/cctp/quote", { amount, destination: form.destination.value });
        if (mine !== seq) return;
        quoteEl.innerHTML = quoteRows([
          ["You send", usd(amount)],
          ["Network fee", usd(q.fee)],
          [`Arrives on ${q.destination.name}`, usd(q.receive), true],
        ]);
        quoteEl.hidden = false;
        quoteErr.hidden = true;
      } catch (err) {
        if (mine !== seq) return;
        quoteErr.textContent = err.message;
        quoteErr.hidden = false;
        quoteEl.hidden = true;
      }
    }, 300);
  };
  const amt = wireAmount(form, { onChange: requote });
  form.destination.addEventListener("change", requote);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const amount = amt.value();
    if (!(Number(amount) > 0)) { toast("Enter an amount."); return; }
    const recipient = form.recipient.value.trim();
    if (recipient && !/^0x[0-9a-fA-F]{40}$/.test(recipient)) { toast("That address doesn't look right."); return; }
    const btn = form.querySelector("button[type=submit]");
    setBusy(btn, "Moving…");
    try {
      await ensureSigningWallet();
      const { transfer } = await apiSend("/api/web3/cctp/withdrawals", "POST", {
        amount, destination: form.destination.value, recipient: recipient || undefined,
      });
      const t = await driveWithdrawal(transfer.id);
      void refreshWalletOnchain();
      const arrived = t.state === "completed";
      showDone(sheet, {
        title: arrived ? `${money(amount)} arrived on ${t.destination.name}` : `${money(amount)} is on its way to ${t.destination.name}`,
        text: arrived ? "" : "It usually lands within a few minutes. Payments shows when it arrives.",
        link: txLink(t.source.explorer, t.txs?.burn, "See the receipt"),
        pending: !arrived,
      });
      onDone?.();
    } catch (err) {
      toast(err.message);
      setBusy(btn, false);
    }
  });
}

// ── adding money from an outside wallet (CCTP) ────────────────────────

/** Switch the outside wallet to a chain, adding it first if the wallet has never seen it. */
async function switchChain(eth, params) {
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: params.chainId }] });
  } catch (err) {
    if (err?.code !== 4902 && !/unrecognized|not been added|unknown chain/i.test(err?.message ?? "")) throw err;
    await eth.request({ method: "wallet_addEthereumChain", params: [params] });
  }
}

async function waitForOutsideTx(eth, hash) {
  for (let i = 0; i < 90; i++) {
    const receipt = await eth.request({ method: "eth_getTransactionReceipt", params: [hash] });
    if (receipt) {
      if (receipt.status === "0x1") return;
      throw new Error("That transaction didn't go through.");
    }
    await sleep(2000);
  }
  throw new Error("Still waiting for the network. Check your wallet.");
}


/** Add money from an outside wallet on another network. */
export async function openAddMoneySheet(onDone) {
  const sheet = openSheet({ id: "add-money-sheet", title: "Add money", className: "sheet-result sheet-pay" });
  const body = sheet.body;
  const eth = window.ethereum;
  const mine = getUser()?.circle?.walletAddress ?? "";
  if (!eth) {
    body.innerHTML = `
      <p class="res-hint">To add money from another network, open SportsArc in a browser with a wallet such as MetaMask.</p>
      ${mine ? `<p class="res-hint">You can also send money on the SportsArc network straight to your wallet address:</p>
      <button type="button" class="pay-address" data-copy title="Copy address"><span>${esc(mine)}</span>${ICON.copy}</button>` : ""}`;
    $("[data-copy]", body)?.addEventListener("click", () => void copyText(mine, "Address copied."));
    return;
  }
  body.innerHTML = `<div class="pay-loading"><span class="skel"></span><span class="skel"></span></div>`;
  let src;
  try {
    src = await apiGet("/api/web3/cctp/sources");
  } catch (err) {
    body.innerHTML = `<p class="empty">${esc(err.message)}</p>`;
    return;
  }
  body.innerHTML = `
    <form class="host-form pay-form" novalidate>
      ${amountField({ quick: [10, 25, 50] })}
      <div class="pay-fields">
        <label><span>From network</span>
          <select name="source">${src.sources.map((s) => `<option value="${esc(s.key)}">${esc(s.name)}</option>`).join("")}</select>
        </label>
      </div>
      <p class="pay-status" data-status aria-live="polite" hidden></p>
      <p class="res-hint">It lands in your SportsArc wallet, usually in under a minute. Your outside wallet is only used to send this.</p>
      <div class="pay-actions"><button type="submit" class="btn-game">Connect wallet and add</button></div>
    </form>`;
  const form = $(".pay-form", body);
  const status = $("[data-status]", body);
  const say = (text) => { status.textContent = text; status.hidden = !text; };
  const amt = wireAmount(form, { spends: false });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const amount = amt.value();
    if (!(Number(amount) > 0)) { toast("Enter an amount."); return; }
    const btn = form.querySelector("button[type=submit]");
    setBusy(btn, "Adding…");
    try {
      say("Connecting your wallet…");
      const [from] = await eth.request({ method: "eth_requestAccounts" });
      if (!from) throw new Error("No wallet account was shared.");
      const plan = await apiSend("/api/web3/cctp/fund/steps", "POST", { source: form.source.value, amount, from });
      await switchChain(eth, plan.source.wallet);
      let hash = "";
      for (const step of plan.steps) {
        say(step.step === "approve"
          ? "Confirm in your wallet (1 of 2): allow the transfer."
          : `Confirm in your wallet: send ${money(plan.amountUsdc)}. Fee ${money(plan.feeUsdc)}, ${money(plan.receiveUsdc)} arrives.`);
        hash = await eth.request({ method: "eth_sendTransaction", params: [{ from, to: step.to, data: step.data }] });
        say("Waiting for the network…");
        await waitForOutsideTx(eth, hash);
      }
      await apiSend("/api/web3/cctp/fund", "POST", { source: form.source.value, txHash: hash });
      showDone(sheet, {
        title: `${money(plan.receiveUsdc)} is on its way`,
        text: "It lands in your SportsArc wallet, usually in under a minute.",
        pending: true,
      });
      onDone?.();
    } catch (err) {
      const refused = err?.code === 4001 || /user rejected|denied/i.test(err?.message ?? "");
      say("");
      toast(refused ? "Cancelled. Nothing was sent." : err.message);
      setBusy(btn, false);
    }
  });
}

// ── payments page (#/pay) ─────────────────────────────────────────────
//
// One balance, the things waiting on the player, then a single activity
// ledger: payments, money added, money moved out and game payouts merged
// and grouped by day. Each source maps to the same row shape:
//   { kind, at, icon, title, sub, amount, sign, state, action }
// `title`, `sub` and `action` are HTML; `state` is done | pending | failed.

const KIND_LABEL = { pay: "Payments", add: "Added", out: "Moved out", payout: "Game payouts", event: "Events" };
let activityFilter = "all";

const badge = (dir) => `<span class="led-ico led-ico-${dir}">${dir === "in" ? ICON.arrowDown : ICON.arrowUp}</span>`;

function paymentItem(p) {
  const out = p.direction === "out";
  const what = esc(p.note ?? (p.game ? `${titleCase(p.game.sport)} game` : ""));
  const paid = p.status === "paid";
  const href = paid && p.txHash ? explorerUrlFor(p.txHash, { kind: "tx" }) : "";
  const verb = paid ? (out ? "You paid" : "Paid you") : "You asked";
  return {
    kind: "pay",
    at: p.paidAt ?? p.createdAt,
    icon: avatar(p.other, "sm", { href: `#/u/${p.other.id}` }),
    title: personLink(p.other, { fallback: "Player" }),
    sub: `${verb}${what ? ` · ${what}` : ""}`,
    amount: p.amountUsdc,
    sign: paid ? (out ? "-" : "+") : "",
    state: paid ? "done" : "pending",
    status: paid ? "" : "Waiting",
    action: paid
      ? receiptLink(href)
      : `<button class="btn-game btn-game-ghost" data-withdraw="${esc(p.id)}">Cancel</button>`,
  };
}

function fundingItem(f) {
  const failed = f.state === "failed";
  return {
    kind: "add",
    at: f.completedAt ?? f.createdAt,
    icon: badge("in"),
    title: `Added from ${esc(f.sourceName)}`,
    sub: failed ? esc(f.error ?? "Didn't arrive") : "",
    amount: f.receivedUsdc ?? f.amountUsdc,
    sign: "+",
    state: f.state === "arrived" ? "done" : failed ? "failed" : "pending",
    status: f.state === "arrived" ? "" : failed ? "Failed" : "On its way",
    action: receiptLink(f.receipt),
  };
}

function withdrawalItem(t) {
  const to = t.destination.name ?? `chain ${t.destination.chainId}`;
  const other = t.recipient.toLowerCase() !== t.wallet.toLowerCase();
  const needsPin = t.state === "burn_approval" || t.state === "burn";
  const done = t.state === "completed";
  const failed = t.state === "failed";
  return {
    kind: "out",
    at: t.completedAt ?? t.createdAt,
    icon: badge("out"),
    title: `Moved to ${esc(to)}`,
    sub: other ? `To ${esc(shortAddr(t.recipient))}` : "To your wallet there",
    amount: done && t.mintedAmount ? t.mintedAmount.usdc : t.amount.usdc,
    sign: "-",
    state: done ? "done" : failed ? "failed" : "pending",
    status: done ? "" : failed ? "Didn't go through" : needsPin ? "Needs your PIN" : "On its way",
    action: needsPin
      ? `<button class="btn-game" data-out-continue="${esc(t.id)}">Continue</button>`
      : done
        ? txLink(t.destination.explorer, t.txs.receive, "Receipt") || txLink(t.source.explorer, t.txs.burn, "Receipt")
        : failed ? "" : txLink(t.source.explorer, t.txs.burn, "Receipt"),
  };
}

function eventItem(e) {
  return {
    kind: "event",
    at: e.at,
    icon: badge(e.sign === "-" ? "out" : "in"),
    title: esc(e.title),
    sub: esc(titleCase(e.sport ?? "")),
    amount: e.amountUsd,
    sign: e.sign,
    state: e.state,
    status: e.state === "pending" ? "On its way" : "",
    action: e.txHash ? receiptLink(explorerUrlFor(e.txHash, { kind: "tx" })) : "",
  };
}

function payoutItem(p) {
  const settled = p.state === "completed" || p.state === "fallback";
  const where = `${esc(p.chainName)} · ${esc(shortAddr(p.address))}`;
  if (p.toWallet) {
    return {
      kind: "payout",
      at: p.completedAt ?? p.createdAt,
      icon: badge("in"),
      title: "Game payout to your wallet",
      sub: esc(p.reason ?? `It couldn't be sent to ${p.chainName}.`),
      amount: p.amountUsdc,
      sign: "+",
      state: settled ? "done" : "pending",
      status: settled ? "" : "On its way",
      action: receiptLink(p.receipt),
    };
  }
  const done = p.state === "completed";
  return {
    kind: "payout",
    at: p.completedAt ?? p.createdAt,
    icon: badge("out"),
    title: `Game payout to ${where}`,
    sub: done && p.feeUsdc ? `${usd(p.feeUsdc)} network fee` : "",
    amount: done ? (p.sentUsdc ?? p.amountUsdc) : p.amountUsdc,
    sign: "",
    state: done ? "done" : "pending",
    status: done ? "" : "On its way",
    action: receiptLink(p.receipt),
  };
}

function ledgerRow(it) {
  const amount = it.amount == null || it.amount === "" ? "" : `${it.sign === "-" ? "−" : it.sign}${usd(it.amount)}`;
  const sub = [it.status ? `<span class="led-status led-${it.state}">${esc(it.status)}</span>` : "", it.sub, esc(timeAgo(it.at))]
    .filter(Boolean).join(`<span class="led-dot">·</span>`);
  const isButton = /<button/.test(it.action ?? "");
  return `
    <li class="led-row${it.state === "failed" ? " is-failed" : ""}">
      ${it.icon}
      <div class="led-main"><span class="led-title">${it.title}</span><span class="led-sub">${sub}</span></div>
      <div class="led-side">
        <span class="led-amt${it.sign === "+" && it.state !== "failed" ? " is-in" : ""}">${amount}</span>
        ${it.action && !isButton ? it.action : ""}
      </div>
      ${isButton ? `<div class="led-actions">${it.action}</div>` : ""}
    </li>`;
}

function ledgerHtml(items) {
  const shown = activityFilter === "all" ? items : items.filter((i) => i.kind === activityFilter);
  if (!shown.length) {
    return `<div class="pay-empty"><span class="led-ico">${ICON.dollar}</span>
      <p><strong>No activity yet</strong></p><p>Money you send, receive, add or move out shows up here.</p></div>`;
  }
  const days = new Map();
  for (const it of shown) {
    const key = dayHeading(it.at);
    if (!days.has(key)) days.set(key, []);
    days.get(key).push(it);
  }
  return [...days].map(([day, rows]) => `
    <h5 class="led-day">${esc(day)}</h5>
    <ul class="pay-list pay-ledger">${rows.map(ledgerRow).join("")}</ul>`).join("");
}

function requestRow(p) {
  const what = esc(p.note ?? (p.game ? `${titleCase(p.game.sport)} game` : ""));
  const pending = p.status === "pending";
  return `
    <li class="led-row">
      ${avatar(p.other, "sm", { href: `#/u/${p.other.id}` })}
      <div class="led-main"><span class="led-title">${personLink(p.other, { fallback: "Player" })}</span>
        <span class="led-sub">${pending ? "Not finished" : "Asks you"}${what ? `<span class="led-dot">·</span>${what}` : ""}<span class="led-dot">·</span>${esc(timeAgo(p.createdAt))}</span></div>
      <div class="led-side"><span class="led-amt">${usd(p.amountUsdc)}</span></div>
      <div class="led-actions">
        ${pending ? "" : `<button class="btn-game btn-game-ghost" data-decline="${esc(p.id)}">Decline</button>`}
        <button class="btn-game" data-pay="${esc(p.id)}">${pending ? "Finish paying" : `Pay ${money(p.amountUsdc)}`}</button>
      </div>
    </li>`;
}

function savedAddressRow(d) {
  return `
    <li class="led-row">
      <span class="led-ico">${ICON.link}</span>
      <div class="led-main"><span class="led-title">${esc(d.chainName)}</span><span class="led-sub led-mono">${esc(d.address)}</span></div>
      <div class="led-actions"><button class="btn-game btn-game-ghost" data-forget="${esc(d.id)}">Remove</button></div>
    </li>`;
}

function heroHtml({ balance, address, canMove }) {
  if (!address) {
    return `
      <section class="wal-hero">
        <span class="wal-label">SportsArc wallet</span>
        <p class="wal-none">Set up your wallet to hold spots, pay players and get paid back.</p>
        <div class="pay-actions"><button class="btn-game" data-setup>Set up wallet</button></div>
      </section>`;
  }
  const [whole, cents] = balance == null ? ["—", ""] : usd(balance).slice(1).split(".");
  const act = (attr, icon, label, extra = "") => `
    <button class="wal-act" ${attr} ${extra}><span class="wal-act-ico">${icon}</span><span>${label}</span></button>`;
  return `
    <section class="wal-hero">
      <div class="wal-top">
        <span class="wal-label">Balance</span>
        <button class="wal-addr" data-copy-addr title="Copy your wallet address">${esc(shortAddr(address))}${ICON.copy}</button>
      </div>
      <div class="wal-balance" aria-label="${balance == null ? "Balance unavailable" : usd(balance)}"><span class="wal-cur">$</span><span data-bal>${whole}</span>${cents ? `<span class="wal-cents">.${cents}</span>` : ""}</div>
      <div class="wal-actions">
        ${canMove ? act("data-add-money", ICON.arrowDown, "Add") : ""}
        ${act("data-send", ICON.send, "Pay")}
        ${canMove ? act("data-cash-out", ICON.arrowUp, "Move out") : ""}
      </div>
    </section>`;
}

const paySkeleton = () => `
  <section class="wal-hero" aria-hidden="true">
    <span class="skel" style="width:70px;height:12px"></span>
    <span class="skel" style="width:190px;height:54px"></span>
    <span class="skel" style="width:100%;max-width:300px;height:56px"></span>
  </section>
  ${Array.from({ length: 4 }, () => `
    <div class="skel-row" aria-hidden="true">
      <div class="skel skel-circle" style="width:44px;height:44px"></div>
      <div><div class="skel skel-line" style="width:45%"></div><div class="skel skel-line" style="width:70%;margin:0"></div></div>
    </div>`).join("")}`;

export async function renderPayments() {
  // A refresh (after an action, or while money is moving) swaps the new
  // page in when it is ready instead of flashing back to a skeleton.
  let old = $("#pay-body");
  if (!old) {
    main().innerHTML = `<div class="pay-page"><h3 class="games-title">Payments</h3><div id="pay-body">${paySkeleton()}</div></div>`;
    old = $("#pay-body");
  }
  const address = getUser()?.circle?.walletAddress ?? "";
  let r, out, paid, added, opts, balance, events;
  try {
    [r, out, paid, added, opts, balance, events] = await Promise.all([
      apiGet("/api/web3/pay"),
      apiGet("/api/web3/cctp/transfers").catch(() => null),
      apiGet("/api/web3/gateway/payouts").catch(() => null),
      apiGet("/api/web3/cctp/fundings").catch(() => null),
      apiGet("/api/web3/gateway/options").catch(() => null),
      address ? refreshWalletOnchain().catch(() => null) : null,
      apiGet("/api/web3/events/activity").catch(() => null),
    ]);
  } catch (err) {
    if (old.isConnected) old.innerHTML = `<p class="empty">${esc(err.message)}</p>`;
    return;
  }
  if (!old.isConnected) return;

  const withdrawals = (out?.transfers ?? []).filter((t) => t.forward);
  const payouts = paid?.payouts ?? [];
  const fundings = added?.fundings ?? [];
  const saved = opts?.saved ?? [];
  const items = [
    ...r.waiting.map(paymentItem),
    ...r.recent.map(paymentItem),
    ...fundings.map(fundingItem),
    ...withdrawals.map(withdrawalItem),
    ...payouts.map(payoutItem),
    ...(events?.items ?? []).map(eventItem),
  ].sort((a, b) => new Date(b.at) - new Date(a.at));
  const kinds = Object.keys(KIND_LABEL).filter((k) => items.some((i) => i.kind === k));
  if (activityFilter !== "all" && !kinds.includes(activityFilter)) activityFilter = "all";
  const filters = () => (kinds.length > 1
    ? `<div class="pay-filter" role="tablist" aria-label="Activity">
        ${["all", ...kinds].map((k) => `<button type="button" role="tab" aria-selected="${k === activityFilter}" data-filter="${k}">${k === "all" ? "All" : KIND_LABEL[k]}</button>`).join("")}
       </div>`
    : "");

  const box = document.createElement("div");
  box.id = "pay-body";
  box.innerHTML = `
    ${heroHtml({ balance, address, canMove: r.eligible !== false })}
    ${r.toPay.length ? `
      <section class="pay-sec">
        <h4 class="pay-kicker">Requests <span class="pay-count">${r.toPay.length}</span></h4>
        <ul class="pay-list pay-ledger pay-requests">${r.toPay.map(requestRow).join("")}</ul>
      </section>` : ""}
    <section class="pay-sec">
      <div class="pay-sec-head"><h4 class="pay-kicker">Activity</h4><span data-filters>${filters()}</span></div>
      <div data-ledger>${ledgerHtml(items)}</div>
    </section>
    ${saved.length ? `
      <section class="pay-sec">
        <h4 class="pay-kicker">Saved payout addresses</h4>
        <ul class="pay-list pay-ledger">${saved.map(savedAddressRow).join("")}</ul>
      </section>` : ""}`;
  const first = !old.querySelector("[data-ledger]");
  old.replaceWith(box);
  if (first) countUp($("[data-bal]", box), balance);

  // Anything still moving: look again soon, so "On its way" turns into "Arrived".
  const moving = withdrawals.some((t) => OUT_ACTIVE.includes(t.state) && t.state !== "burn_approval" && t.state !== "burn")
    || payouts.some((p) => p.state !== "completed" && p.state !== "fallback")
    || fundings.some((f) => f.state === "sent");
  if (moving) {
    setTimeout(() => {
      if (!box.isConnected || !location.hash.startsWith("#/pay") || document.querySelector(".sheet")) return;
      void renderPayments();
    }, 6_000);
  }
  const refresh = () => { if (box.isConnected) void renderPayments(); };

  box.addEventListener("click", async (e) => {
    const t = e.target.closest("[data-pay], [data-decline], [data-withdraw], [data-cash-out], [data-out-continue], [data-add-money], [data-forget], [data-send], [data-filter], [data-copy-addr], [data-setup]");
    if (!t || t.disabled) return;
    if (t.matches("[data-filter]")) {
      activityFilter = t.dataset.filter;
      $("[data-filters]", box).innerHTML = filters();
      $("[data-ledger]", box).innerHTML = ledgerHtml(items);
      return;
    }
    if (t.matches("[data-copy-addr]")) { void copyText(address, "Wallet address copied."); return; }
    if (t.matches("[data-setup]")) { document.dispatchEvent(new CustomEvent("sportsarc:wallet-setup")); return; }
    if (t.matches("[data-send]")) { openSendSheet(refresh); return; }
    if (t.matches("[data-cash-out]")) { void openWithdrawSheet(refresh); return; }
    if (t.matches("[data-add-money]")) { void openAddMoneySheet(refresh); return; }
    const isBtn = t.classList.contains("btn-game");
    if (isBtn) setBusy(t, "Working…"); else t.disabled = true;
    try {
      if (t.matches("[data-forget]")) {
        await apiSend(`/api/web3/gateway/destinations/${t.dataset.forget}`, "DELETE");
      } else if (t.matches("[data-out-continue]")) {
        await ensureSigningWallet();
        const moved = await driveWithdrawal(t.dataset.outContinue);
        toast(`On its way to ${moved.destination.name}.`);
      } else if (t.matches("[data-pay]")) {
        const p = r.toPay.find((x) => x.id === t.dataset.pay);
        await pay({ requestId: t.dataset.pay }, `${p?.other.name ?? "them"} ${money(p?.amountUsdc ?? "")}`);
        toast("Paid.");
      } else if (t.matches("[data-decline]")) {
        await apiSend(`/api/web3/pay/${t.dataset.decline}/decline`, "POST");
      } else {
        await apiSend(`/api/web3/pay/${t.dataset.withdraw}/cancel`, "POST");
      }
      void renderPayments();
    } catch (err) {
      toast(err.message);
      if (isBtn) setBusy(t, false); else t.disabled = false;
    }
  });
}

/** Roll the balance up from zero the first time the page shows it. */
function countUp(el, balance) {
  if (!el || balance == null || !(Number(balance) > 0)) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const cents = el.parentElement.querySelector(".wal-cents");
  const target = Number(balance);
  const start = performance.now();
  const tick = (now) => {
    if (!el.isConnected) return;
    const k = Math.min(1, (now - start) / 600);
    const [whole, frac] = usd(target * (1 - (1 - k) ** 3)).slice(1).split(".");
    el.textContent = whole;
    if (cents) cents.textContent = `.${frac}`;
    if (k < 1) window.requestAnimationFrame(tick);
  };
  window.requestAnimationFrame(tick);
}
