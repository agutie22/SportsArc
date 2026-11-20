import "./errors.js";
import * as circleSdk from "./circle-sdk.js";
import * as account from "./account.js";
import { renderGames, resumeGames, warmGames, openSport } from "./games.js";
import { renderHome, resumeHome, warmHome } from "./feed.js";
import { renderProfile, renderPeople, warmProfile, warmPeople } from "./profile.js";
import { renderPostPage } from "./posts.js";
import {
  renderNotifications, resumeNotifications, warmNotifications, startBadgePolling, stopBadgePolling, refreshBadge,
} from "./notifications.js";
import { isGuestModulePath, loadEnabledModules, listModules, modulePrefixRoutes, moduleRoutes } from "./modules.js";
import { openComposeSheet } from "./compose.js";
import { refreshAdminStatus, isAdmin, clearAdminStatus, openInviteSheet } from "./invites.js";
import { renderPayments } from "./money.js";
import { renderRecordPage, renderVerifyPage } from "./record.js";
import { renderMap } from "./map.js";
import { apiSend, avatar, esc } from "./api.js";
import { applyTeam, previewTeam, teamPicker } from "./teams.js";
import {
  $, $$, main, getUser, setUser, clearUser, userFromAccount,
  ensureCircleSdk, loadPublicConfig,
  ROLE_META, ICON,
  shortAddr, currentTheme, setTheme,
  toast, balanceText, paintWalletBalance, refreshWalletOnchain,
} from "./shared.js";

// ═══════════════════════════════════════════════════════════════
//  AUTH FLOW
// ═══════════════════════════════════════════════════════════════
/** signup / pin-offer / signin (username + Circle PIN), or identifier → code → profile (email). */
let authStep = account.lastUsername() ? "signin" : "signup";
let authChannel = "email";
let authEmail = "";
let authPhone = "";
let walletSetupBusy = false;
/** Account created this session, waiting on the PIN offer. */
let pendingSignupUser = null;
/** The account on the "Pick your team" step, between the profile and the app. */
let teamStepUser = null;
const PIN_OFFER_KEY = "sportsarc_pin_offer";
/** Login options from GET /api/config (api/auth/mailer.ts, api/auth/invites.ts). */
let authOptions = { emailLogin: true, phoneLogin: false };
/** Set when the API refuses an email for want of an invite. */
let inviteRefused = "";

const AUDIENCE_META = {
  adult: { title: "I'm 18+", desc: "Adult player, coach, or scout" },
  minor: { title: "Under 18", desc: "High-school athlete or student" },
  guardian: { title: "Parent / guardian", desc: "I manage a young athlete" },
};

/** The role choice on the profile step. */
const ROLE_CARDS = [
  { role: "player", icon: ICON.target, desc: "Find games and build a verified record" },
  { role: "coach", icon: ICON.clipboard, desc: "Find players and run your games" },
  { role: "scout", icon: ICON.search, desc: "Discover players by what they actually played" },
];

/** Cards for "I am..." (18+, under 18, guardian). */
const audienceCards = (tag) => Object.entries(AUDIENCE_META).map(([key, m]) => `
  <${tag}${tag === "button" ? ` type="button"` : ""} class="auth-audience-card" data-audience="${key}">
    <h4>${m.title}</h4>
    <p>${m.desc}</p>
  </${tag}>`).join("");

function showAuth() {
  $("#auth-screen").classList.remove("hidden");
  $(".app-main").style.display = "none";
  renderAuthScreen();
}

function hideAuth() {
  $("#auth-screen").classList.add("hidden");
  $(".app-main").style.display = "";
}

function identValue() {
  return authChannel === "phone" ? authPhone : authEmail;
}

function identFields() {
  return account.identPayload(authChannel, identValue());
}

const AUTH_STEPS = {
  signup: renderSignupStep,
  "pin-offer": renderPinOfferStep,
  signin: renderSigninStep,
  identifier: renderIdentifierStep,
  code: renderCodeStep,
  profile: renderProfileStep,
  team: renderTeamStep,
};

function renderAuthScreen() {
  (AUTH_STEPS[authStep] ?? renderIdentifierStep)($("#auth-body"));
}

// ── username + PIN ────────────────────────────────────────────

function pinAltLinks(other) {
  const { emailLogin, phoneLogin } = authOptions;
  const swap = other === "signin"
    ? `<button type="button" class="auth-alt-btn" data-step="signin">Have an account? Sign in</button>`
    : `<button type="button" class="auth-alt-btn" data-step="signup">New here? Create an account</button>`;
  const code = emailLogin || phoneLogin
    ? ` · <button type="button" class="auth-alt-btn" data-step="identifier">Use ${emailLogin ? "email" : "phone"} instead</button>`
    : "";
  return `<div class="auth-alt">${swap}${code}</div>`;
}

function bindAuthStepLinks(body) {
  $$(".auth-alt-btn[data-step]", body).forEach((btn) => {
    btn.addEventListener("click", () => {
      authStep = btn.dataset.step;
      renderAuthScreen();
    });
  });
}

function renderSignupStep(body) {
  body.innerHTML = `
    <div class="auth-section-label">Create your account</div>
    <div class="auth-form">
      <div>
        <label class="input-label" for="auth-username">Pick a username</label>
        <input type="text" class="input" id="auth-username" placeholder="e.g. hooper_23"
          autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="21">
      </div>
      <div>
        <label class="input-label">I am...</label>
        <div class="auth-audience-cards" id="signup-audience">${audienceCards("button")}</div>
      </div>
    </div>
    <div class="auth-legal">Next you can set a PIN. That PIN signs you in on any device and creates your wallet.</div>
    ${pinAltLinks("signin")}
    <div class="auth-error" id="auth-error"></div>
  `;
  bindAuthStepLinks(body);
  $$(".auth-audience-card", body).forEach((card) => {
    card.addEventListener("click", () => void handleUsernameSignup(card.dataset.audience));
  });
  $("#auth-username", body).focus();
}

function markPinOffer() {
  try { sessionStorage.setItem(PIN_OFFER_KEY, "1"); } catch { /* a refresh hint only */ }
}

function clearPinOffer() {
  try { sessionStorage.removeItem(PIN_OFFER_KEY); } catch { /* ignore */ }
}

function pinOfferPending() {
  try { return sessionStorage.getItem(PIN_OFFER_KEY) === "1"; } catch { return false; }
}

/**
 * The account already exists. Circle's PIN screen used to open on its own
 * the moment signup finished; this step is the pause, and the button is
 * what actually opens it.
 */
function renderPinOfferStep(body) {
  const name = pendingSignupUser?.name || account.lastUsername();
  body.innerHTML = `
    <div class="auth-section-label">You're in</div>
    <p class="auth-welcome">@${esc(name)}</p>
    <div class="auth-note">Want a wallet? A PIN signs you back in on any device, and Circle uses that same PIN to create the wallet you pay with.</div>
    <div class="auth-form auth-pin-offer">
      <div class="connect-stack">
        <button type="button" class="connect-btn" id="auth-set-pin" ${walletSetupBusy ? "disabled" : ""}>
          <span class="connect-btn-icon">${ICON.bolt}</span>
          <span class="connect-btn-label">${walletSetupBusy ? "Opening PIN…" : "Set a PIN"}</span>
        </button>
      </div>
    </div>
    <div class="auth-alt">
      <button type="button" class="auth-alt-btn" id="auth-skip-pin" ${walletSetupBusy ? "disabled" : ""}>Not now</button>
    </div>
    <div class="auth-legal">Until you set a PIN, this browser is the only way back into this account.</div>
    <div class="auth-error" id="auth-error"></div>
  `;
  $("#auth-set-pin", body).addEventListener("click", () => void handleSetupWallet());
  $("#auth-skip-pin", body).addEventListener("click", () => {
    if (walletSetupBusy) return;
    const created = pendingSignupUser;
    pendingSignupUser = null;
    clearPinOffer();
    authStep = "signin";
    enterApp(created);
  });
}

/**
 * "Pick your team", once, after the profile step: the app recolors as
 * soon as a team is tapped (teams.js). Skippable; the profile editor has
 * the same picker. Then the PIN offer for a username signup, else the app.
 */
function renderTeamStep(body) {
  body.innerHTML = `
    <div class="auth-section-label">Pick your team</div>
    <div class="auth-note">SportsArc wears your team's colors. College football for now; change it anytime from your profile.</div>
    <div class="auth-form">
      <div id="auth-team-picker"></div>
      <div class="connect-stack">
        <button type="button" class="connect-btn" id="auth-team-save" disabled>
          <span class="connect-btn-icon">${ICON.bolt}</span>
          <span class="connect-btn-label">Continue</span>
        </button>
      </div>
    </div>
    <div class="auth-alt">
      <button type="button" class="auth-alt-btn" id="auth-team-skip">Skip for now</button>
    </div>
    <div class="auth-error" id="auth-error"></div>
  `;
  let picked = null;
  let busy = false;
  const save = $("#auth-team-save", body);
  teamPicker($("#auth-team-picker", body), {
    onPick: (team) => {
      picked = team;
      previewTeam(team);
      save.disabled = !team;
      $(".connect-btn-label", save).textContent = team ? `Continue as ${team.name}` : "Continue";
    },
  });
  const next = (team) => {
    const user = teamStepUser ? { ...teamStepUser, team } : null;
    teamStepUser = null;
    applyTeam(team);
    if (pendingSignupUser) {
      pendingSignupUser = { ...pendingSignupUser, team };
      authStep = "pin-offer";
      renderAuthScreen();
      return;
    }
    if (user) enterApp(user);
    else { authStep = "signin"; renderAuthScreen(); }
  };
  save.addEventListener("click", async () => {
    if (!picked || busy) return;
    busy = true;
    save.disabled = true;
    try {
      await apiSend("/api/profile", "PATCH", { teamKey: picked.key });
      next(picked);
    } catch (e) {
      $("#auth-error", body).textContent = e?.message ?? "Could not save your team.";
      save.disabled = false;
    } finally {
      busy = false;
    }
  });
  $("#auth-team-skip", body).addEventListener("click", () => {
    if (busy) return;
    next(null);
  });
}

function renderSigninStep(body) {
  body.innerHTML = `
    <div class="auth-section-label">Sign in</div>
    <div class="auth-form">
      <div>
        <label class="input-label" for="auth-username">Username</label>
        <input type="text" class="input" id="auth-username" placeholder="your username"
          autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="21"
          value="${esc(account.lastUsername())}">
      </div>
      <div class="connect-stack">
        <button type="button" class="connect-btn" id="auth-pin-signin">
          <span class="connect-btn-icon">${ICON.bolt}</span>
          <span class="connect-btn-label">Sign in with PIN</span>
        </button>
      </div>
    </div>
    ${pinAltLinks("signup")}
    <div class="auth-error" id="auth-error"></div>
  `;
  bindAuthStepLinks(body);
  $("#auth-pin-signin", body).addEventListener("click", () => void handlePinSignin());
  $("#auth-username", body).addEventListener("keydown", (e) => {
    if (e.key === "Enter") void handlePinSignin();
  });
  $("#auth-username", body).focus();
}

let pinAuthBusy = false;

async function handleUsernameSignup(audience) {
  const errEl = $("#auth-error");
  const username = $("#auth-username")?.value.trim() ?? "";
  if (!username) { errEl.textContent = "Pick a username first."; return; }
  if (pinAuthBusy) return;
  pinAuthBusy = true;
  try {
    errEl.textContent = "";
    const user = await account.signupWithUsername({ username, audience });
    account.rememberUsername(user.name ?? username);
    pendingSignupUser = user;
    markPinOffer();
    teamStepUser = user;
    authStep = "team";
    showAuth();
  } catch (e) {
    if (e?.code === "INVITE_REQUIRED") { showInviteRequired(e.message); return; }
    errEl.textContent = e?.message ?? "Could not create account.";
  } finally {
    pinAuthBusy = false;
  }
}

async function handlePinSignin() {
  const errEl = $("#auth-error");
  const username = $("#auth-username")?.value.trim() ?? "";
  if (!username) { errEl.textContent = "Enter your username."; return; }
  if (pinAuthBusy) return;
  pinAuthBusy = true;
  try {
    errEl.textContent = "";
    await ensureCircleSdk();
    const user = await circleSdk.signInWithPin(username);
    account.rememberUsername(user.name || username.replace(/^@/, ""));
    if (!user.profileComplete) {
      authStep = "profile";
      renderAuthScreen();
      return;
    }
    enterApp(user);
  } catch (e) {
    errEl.textContent = e?.message ?? "Could not sign in.";
  } finally {
    pinAuthBusy = false;
  }
}

// ── email / phone code ────────────────────────────────────────

function renderIdentifierStep(body) {
  const { emailLogin, phoneLogin } = authOptions;
  // Back to the username + PIN screens, which are the default.
  const pinLinks = `
    <div class="auth-alt">
      <button type="button" class="auth-alt-btn" data-step="signin">Sign in with username + PIN</button>
      ·
      <button type="button" class="auth-alt-btn" data-step="signup">Create an account</button>
    </div>`;
  if (!emailLogin && !phoneLogin) {
    body.innerHTML = `
      <div class="auth-section-label">Sign in</div>
      <div class="auth-note">Code sign-in is not available right now.</div>
      ${pinLinks}`;
    bindAuthStepLinks(body);
    return;
  }
  // Phone is offered only while an SMS sender exists; email otherwise.
  if (!phoneLogin) authChannel = "email";
  else if (!emailLogin) authChannel = "phone";
  const bothChannels = emailLogin && phoneLogin;
  body.innerHTML = `
    <div class="auth-section-label">Sign in</div>
    ${bothChannels ? `<div class="auth-channel" id="auth-channel">
      <button type="button" class="auth-channel-btn ${authChannel === "email" ? "selected" : ""}" data-channel="email">Email</button>
      <button type="button" class="auth-channel-btn ${authChannel === "phone" ? "selected" : ""}" data-channel="phone">Phone</button>
    </div>` : ""}
    ${inviteRefused ? `
    <div class="auth-invite" id="auth-invite" role="status">
      <div class="auth-invite-title">Invite needed</div>
      <p>${esc(inviteRefused)}</p>
      <p class="auth-invite-sub">Already have an account? Use the email you signed up with.</p>
    </div>` : ""}
    <div class="auth-form">
      <div>
        <label class="input-label">${authChannel === "phone" ? "Phone number" : "Email"}</label>
        <input type="${authChannel === "phone" ? "tel" : "email"}" class="input" id="auth-ident"
          placeholder="${authChannel === "phone" ? "+1 555 123 4567" : "you@example.com"}"
          autocomplete="${authChannel === "phone" ? "tel" : "email"}"
          value="${esc(authChannel === "phone" ? authPhone : authEmail)}">
      </div>
      <div class="connect-stack">
        <button type="button" class="connect-btn" id="auth-send">
          <span class="connect-btn-icon">${ICON.bolt}</span>
          <span class="connect-btn-label">Send code</span>
        </button>
      </div>
    </div>
    <div class="auth-legal">${authChannel === "phone" ? "We’ll text you" : "We’ll email you"} a 6-digit code. Same account on every device.</div>
    ${pinLinks}
    <div class="auth-error" id="auth-error"></div>
  `;
  bindAuthStepLinks(body);

  $$(".auth-channel-btn", body).forEach((btn) => {
    btn.addEventListener("click", () => {
      authChannel = btn.dataset.channel;
      renderAuthScreen();
    });
  });

  $("#auth-send", body).addEventListener("click", () => void handleSendCode());
  $("#auth-ident", body).addEventListener("keydown", (e) => {
    if (e.key === "Enter") void handleSendCode();
  });
}

function renderCodeStep(body) {
  const dest = identValue();
  body.innerHTML = `
    <div class="auth-section-label">Enter code</div>
    <p class="auth-welcome">Sent to ${esc(dest)}</p>
    <p class="auth-legal auth-code-hint">Check your inbox (and spam folder). The code expires in 10 minutes.</p>
    <div class="auth-form">
      <div>
        <label class="input-label">6-digit code</label>
        <input type="text" class="input auth-code-input" id="auth-code" inputmode="numeric" maxlength="6"
          autocomplete="one-time-code" placeholder="000000">
      </div>
      <div class="connect-stack">
        <button type="button" class="connect-btn" id="auth-verify">
          <span class="connect-btn-icon">${ICON.bolt}</span>
          <span class="connect-btn-label">Continue</span>
        </button>
      </div>
    </div>
    <div class="auth-alt">
      <button type="button" class="auth-alt-btn" id="auth-resend">Resend code</button>
      ·
      <button type="button" class="auth-alt-btn" id="auth-back">Use a different ${authChannel}</button>
    </div>
    <div class="auth-error" id="auth-error"></div>
  `;
  $("#auth-verify", body).addEventListener("click", () => void handleVerifyCode());
  $("#auth-code", body).addEventListener("keydown", (e) => {
    if (e.key === "Enter") void handleVerifyCode();
  });
  $("#auth-resend", body).addEventListener("click", () => void handleSendCode({ stayOnCode: true }));
  $("#auth-back", body).addEventListener("click", () => {
    authStep = "identifier";
    renderAuthScreen();
  });
  $("#auth-code", body).focus();
}

function renderProfileStep(body) {
  body.innerHTML = `
    <div class="auth-section-label">Finish your profile</div>
    <div class="auth-form">
      <div>
        <label class="input-label">Full name</label>
        <input type="text" class="input" id="connect-name" placeholder="Enter your name" autocomplete="name">
      </div>
      <div>
        <label class="input-label">I am a...</label>
        <div class="auth-role-cards" id="connect-roles">
          ${ROLE_CARDS.map((c) => `
          <div class="auth-role-card" data-role="${c.role}">
            <div class="auth-role-card-icon">${c.icon}</div>
            <h4>${ROLE_META[c.role].label}</h4>
            <p>${c.desc}</p>
          </div>`).join("")}
        </div>
      </div>
      <div>
        <label class="input-label">I am...</label>
        <div class="auth-audience-cards" id="connect-audience">${audienceCards("div")}</div>
      </div>
      <div class="connect-stack">
        <button type="button" class="connect-btn" id="auth-profile">
          <span class="connect-btn-icon">${ICON.bolt}</span>
          <span class="connect-btn-label">Continue</span>
        </button>
      </div>
    </div>
    <div class="auth-error" id="auth-error"></div>
  `;

  let selectedRole = "";
  let selectedAudience = "";
  $$(".auth-role-card", body).forEach((card) => {
    card.addEventListener("click", () => {
      $$(".auth-role-card", body).forEach((c) => c.classList.remove("selected"));
      card.classList.add("selected");
      selectedRole = card.dataset.role;
    });
  });
  $$(".auth-audience-card", body).forEach((card) => {
    card.addEventListener("click", () => {
      $$(".auth-audience-card", body).forEach((c) => c.classList.remove("selected"));
      card.classList.add("selected");
      selectedAudience = card.dataset.audience;
    });
  });
  $("#auth-profile", body).addEventListener("click", () => {
    void handleSaveProfile({
      name: $("#connect-name", body).value.trim(),
      role: selectedRole,
      audience: selectedAudience,
    });
  });
}

async function handleSendCode({ stayOnCode = false } = {}) {
  const errEl = $("#auth-error");
  const input = $("#auth-ident");
  if (input) {
    const value = input.value.trim();
    if (authChannel === "phone") authPhone = value;
    else authEmail = value;
  }
  if (!identValue()) {
    if (errEl) errEl.textContent = authChannel === "phone" ? "Enter your phone number." : "Enter your email.";
    return;
  }
  try {
    if (errEl) errEl.textContent = "";
    await account.startOtp(identFields());
    inviteRefused = "";
    authStep = "code";
    if (!stayOnCode) renderAuthScreen();
    else if (errEl) errEl.textContent = "";
    toast(authChannel === "phone" ? "Code sent — check your messages." : "Code sent — check your email.");
  } catch (e) {
    if (e?.code === "INVITE_REQUIRED") { showInviteRequired(e.message); return; }
    if (errEl) errEl.textContent = e?.message ?? "Could not send code.";
  }
}

function showInviteRequired(message) {
  inviteRefused = message || "You need an invite to create an account.";
  authStep = "identifier";
  renderAuthScreen();
}

async function handleVerifyCode() {
  const errEl = $("#auth-error");
  const code = $("#auth-code")?.value.trim() ?? "";
  try {
    if (errEl) errEl.textContent = "";
    const user = await account.verifyOtp({ ...identFields(), code });
    if (!user.profileComplete) {
      authStep = "profile";
      renderAuthScreen();
      return;
    }
    enterApp(user);
  } catch (e) {
    if (e?.code === "INVITE_REQUIRED") { showInviteRequired(e.message); return; }
    if (errEl) errEl.textContent = e?.message ?? "Could not verify code.";
  }
}

async function handleSaveProfile({ name, role, audience }) {
  const errEl = $("#auth-error");
  if (!name) { errEl.textContent = "Enter your name first."; return; }
  if (!role) { errEl.textContent = "Select a role."; return; }
  if (!audience) { errEl.textContent = "Select whether you are 18+, under 18, or a parent/guardian."; return; }
  try {
    errEl.textContent = "";
    const user = await account.updateProfile({ name, role, audience });
    if (user?.team) { enterApp(user); return; }
    teamStepUser = user;
    authStep = "team";
    renderAuthScreen();
  } catch (e) {
    errEl.textContent = e?.message ?? "Could not save profile.";
  }
}

function enterApp(accountUser) {
  const profile = userFromAccount(accountUser);
  if (!profile) {
    authStep = "profile";
    renderAuthScreen();
    return;
  }
  setUser(profile);
  applyTeam(accountUser?.team ?? null);
  hideAuth();
  // Chrome is cosmetic; if it fails the app must still route somewhere.
  try {
    renderChrome();
  } catch (err) {
    console.error("[app] account chrome failed:", err);
  }
  void refreshWalletOnchain();
  startBadgePolling();
  // Admins get "Invites" in the account menu.
  void refreshAdminStatus().then(() => renderAccountPopper());
  navigate(location.hash || "#/");
}

async function signOut() {
  stopBadgePolling();
  clearUser();
  clearAdminStatus();
  applyTeam(null);
  // Kept pages and per-user caches (the markets account) must not outlive
  // the person who signed out; the next sign-in may be someone else.
  document.dispatchEvent(new CustomEvent("sportsarc:user-changed"));
  await account.logout();
  authStep = "signin";
  showAuth();
}

/** The header avatar, account menu and wallet chip for the signed-in user. */
function renderChrome() {
  renderAccountPopper();
  paintWalletBalance();
}

/**
 * Account menu: who you are, then what has no other home. A popover on
 * desktop; on phones the same element slides in from the left as a
 * drawer, where it also carries the wallet the header chip shows on
 * wider screens.
 */
function renderAccountPopper() {
  const user = getUser();
  const container = $("#account-popper");
  if (!container) return;
  if (!user) { container.innerHTML = ""; return; }

  const addr = user.circle?.walletAddress;

  container.innerHTML = `
    <div class="popper-head">
      ${avatar(user, "md", { href: "#/profile" })}
      <div class="popper-id">
        <a class="popper-name person-link" href="#/profile">${esc(user.name || "You")}</a>
        <div class="popper-role">${esc(ROLE_META[user.role]?.full || user.role)}</div>
      </div>
    </div>
    <div class="popper-wallet">
      ${addr
        ? `<span>Wallet · ${esc(shortAddr(addr))}</span><strong data-wallet-balance>${esc(balanceText())}</strong>`
        : `<span>No wallet yet</span><button class="btn-join" id="popper-wallet-setup">Set up</button>`}
    </div>
    <div class="popper-links">
      <a class="popper-link" href="#/profile">${ICON.user}<span>Profile</span></a>
      <a class="popper-link" href="#/pay">${ICON.dollar}<span>Payments</span></a>
      <a class="popper-link popper-nav" href="#/people">${ICON.people}<span>Find people</span></a>
      <a class="popper-link" href="#/profile/edit">${ICON.camera}<span>Edit profile</span></a>
      ${isAdmin() ? `<button class="popper-link" id="popper-invites">${ICON.people}<span>Invites</span></button>` : ""}
      <button class="popper-link" id="popper-theme" role="switch" aria-checked="${currentTheme() === "dark"}">
        ${ICON.moon}<span>Dark mode</span>
        <span class="theme-switch${currentTheme() === "dark" ? " on" : ""}"></span>
      </button>
      <button class="popper-link popper-link-danger" id="popper-signout">${ICON.logout}<span>Sign out</span></button>
    </div>`;

  $("#popper-signout")?.addEventListener("click", () => { setAccount(false); void signOut(); });
  $("#popper-invites")?.addEventListener("click", () => { setAccount(false); openInviteSheet(); });
  $("#popper-wallet-setup")?.addEventListener("click", () => { setAccount(false); void handleSetupWallet(); });
  $("#popper-theme")?.addEventListener("click", () => {
    setTheme(currentTheme() === "dark" ? "light" : "dark");
    renderAccountPopper();
  });
  container.querySelectorAll("a").forEach((a) => a.addEventListener("click", () => setAccount(false)));

  $("#account-btn").innerHTML = avatar(user, "xs");
}

// ── account menu ──────────────────────────────────────────────

function setAccount(open) {
  const p = $("#account-popper");
  p.hidden = !open;
  $("#popper-scrim").hidden = !open;
  $("#account-btn").setAttribute("aria-expanded", String(open));
}

$("#account-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  const opening = $("#account-popper").hidden;
  if (opening) renderAccountPopper();
  setAccount(opening);
});

$("#popper-scrim").addEventListener("click", () => setAccount(false));

document.addEventListener("click", (e) => {
  const ap = $("#account-popper");
  if (!ap.hidden && !ap.contains(e.target) && !$("#account-btn").contains(e.target)) setAccount(false);
});

document.addEventListener("keydown", (e) => { if (e.key === "Escape") setAccount(false); });

// A profile edit changes the avatar the header and menu show.
document.addEventListener("sportsarc:user-changed", () => renderAccountPopper());

// Home's profile card asks for wallet setup; the flow itself lives here.
document.addEventListener("sportsarc:wallet-setup", () => void handleSetupWallet());

// The chip opens the money page, or wallet setup when there is no wallet.
$("#wallet-chip").addEventListener("click", (e) => {
  e.stopPropagation();
  setAccount(false);
  if (getUser()?.circle?.walletAddress) location.hash = "#/pay";
  else void handleSetupWallet();
});

// ═══════════════════════════════════════════════════════════════
//  WALLET SETUP (Circle PIN)
// ═══════════════════════════════════════════════════════════════
function pinSetupMessage(err) {
  const raw = String(err?.message ?? "");
  if (/cancel/i.test(raw)) return "PIN setup cancelled. You can try again, or skip for now.";
  const cleaned = raw.replace(/^\[pin\+wallet\]\s*/i, "");
  return cleaned || "Could not set a PIN.";
}

async function handleSetupWallet() {
  if (walletSetupBusy) return;
  const offering = authStep === "pin-offer";
  walletSetupBusy = true;
  if (offering) renderAuthScreen();
  try {
    await ensureCircleSdk();
    const result = await circleSdk.setupWallet();
    const me = await account.fetchMe();
    if (me) {
      const profile = userFromAccount(me);
      if (profile) setUser(profile);
    }
    walletSetupBusy = false;
    if (offering) {
      const created = pendingSignupUser;
      pendingSignupUser = null;
      clearPinOffer();
      authStep = "signin";
      enterApp(me ?? created);
    } else {
      renderChrome();
      void refreshWalletOnchain();
      navigate(location.hash || "#/");
    }
    if (result?.walletAddress) {
      toast(`Wallet ready: ${shortAddr(result.walletAddress)}`);
    }
  } catch (e) {
    walletSetupBusy = false;
    if (offering) {
      renderAuthScreen();
      const errEl = $("#auth-error");
      if (errEl) errEl.textContent = pinSetupMessage(e);
      return;
    }
    renderChrome();
    toast(pinSetupMessage(e));
  }
}

// ═══════════════════════════════════════════════════════════════
//  ROUTER
// ═══════════════════════════════════════════════════════════════
/** `keep` routes stay alive between visits; see swap(). */
const CORE_ROUTES = {
  "/":        { render: renderHome, keep: true, resume: resumeHome, warm: warmHome },
  "/games":   { render: renderGames, keep: true, resume: resumeGames, warm: warmGames },
  "/people":  { render: renderPeople, keep: true, warm: warmPeople },
  "/profile": { render: () => renderProfile(), keep: true, warm: warmProfile },
  "/profile/edit": { render: () => renderProfile(undefined, { edit: true }), tab: "profile" },
  "/notifications": { render: renderNotifications, keep: true, resume: resumeNotifications, warm: warmNotifications },
  "/map":     { render: renderMap },
  "/pay": { render: renderPayments, tab: "profile" },
  "/sport": { render: () => openSport(), tab: "games" },
};

/**
 * `mobile: false` keeps a tab out of the phone bottom bar, which has room
 * for four plus compose. People is still one tap away in the drawer.
 */
const CORE_TABS = [
  { id: "home",          label: "Home",          path: "/",              icon: ICON.home },
  { id: "games",         label: "Games",         path: "/games",         icon: ICON.ball },
  { id: "map",           label: "Map",           path: "/map",           icon: ICON.map },
  { id: "people",        label: "People",        path: "/people",        icon: ICON.people, mobile: false },
  { id: "notifications", label: "Notifications", path: "/notifications", icon: ICON.bell, badge: true },
  { id: "profile",       label: "Profile",       path: "/profile",       icon: ICON.user },
];

/**
 * Paths with an id or token after a fixed prefix. `rest` is what follows
 * the prefix; `tab` is the tab to light up (or a function of `rest`).
 */
const PREFIX_ROUTES = [
  // Post permalinks: #/p/<id>
  { prefix: "/p/", tab: null, render: (rest) => renderPostPage(rest) },
  // One verified record by its ID: #/verify/<id>
  { prefix: "/verify/", tab: null, render: (rest) => renderVerifyPage(rest) },
  // A verified record: #/record is your own, #/record/<token> a shared one.
  {
    prefix: "/record/", tab: null,
    match: (path) => path === "/record" || path.startsWith("/record/"),
    render: (rest, { guest }) => renderRecordPage(rest, { guest }),
  },
  // Shared game links: #/games/<id>
  { prefix: "/games/", tab: "games", render: (rest) => renderGames({ focus: decodeURIComponent(rest) }) },
  // Old sport-page links and the Gemini connect return (?gemini=…): Games, with that sport chosen
  { prefix: "/sport/", tab: "games", render: (rest) => openSport(rest) },
  // Profile permalinks: #/u/<id>
  { prefix: "/u/", tab: (id) => (id === getUser()?.id ? "profile" : null), render: (rest) => renderProfile(rest) },
].map((r) => ({ match: (path) => path.startsWith(r.prefix), ...r }));

/** Recomputed after modules load, so a module can add a route. */
let ROUTES = { ...CORE_ROUTES };

/**
 * Tabs are rendered rather than hardcoded, so modules can contribute one.
 * The same list drives the header on desktop and the bottom bar on
 * phones, where a compose button sits in the middle.
 */
function renderTabs() {
  const tabs = [
    ...CORE_TABS,
    ...listModules().map((m) => ({
      id: m.id, label: m.label, path: m.path, featured: m.featured, icon: m.icon ?? ICON.globe,
    })),
  ];

  const nav = $("#topbar-tabs");
  if (nav) {
    nav.innerHTML = tabs.map((t) => `
      <a href="#${t.path}" class="topbar-tab${t.featured ? " topbar-tab-featured" : ""}${t.badge ? " topbar-tab-icon" : ""}"
         data-page="${t.id}" ${t.badge ? `aria-label="${t.label}" title="${t.label}"` : ""}>
         <span class="nav-icon">${t.icon}${t.badge ? `<span class="nav-badge" data-badge hidden></span>` : ""}</span>
         <span class="nav-text">${t.label}</span></a>`).join("");
  }

  const bottom = $("#bottom-nav");
  if (bottom) {
    const item = (t) => `
      <a href="#${t.path}" class="bnav-item" data-page="${t.id}" aria-label="${t.label}">
        <span class="nav-icon">${t.icon}${t.badge ? `<span class="nav-badge" data-badge hidden></span>` : ""}</span>
        <span class="bnav-label">${t.id === "notifications" ? "Alerts" : t.label}</span></a>`;
    const phoneTabs = tabs.filter((t) => t.mobile !== false);
    const mid = Math.ceil(phoneTabs.length / 2);
    bottom.innerHTML =
      phoneTabs.slice(0, mid).map(item).join("") +
      `<button class="bnav-item bnav-compose" id="bnav-compose" aria-label="New post">
         <span class="bnav-plus">${ICON.plus}</span></button>` +
      phoneTabs.slice(mid).map(item).join("");
    $("#bnav-compose").addEventListener("click", () => openComposeSheet());
  }
}

/**
 * Tapping the tab already open scrolls it to the top, and from the top
 * reloads it, as on X. Bound once to the containers, which outlive renderTabs().
 */
function onTabTap(e) {
  const a = e.target.closest("a[data-page]");
  if (!a || a.getAttribute("href") !== (location.hash || "#/")) return;
  e.preventDefault();
  if (window.scrollY > 40) window.scrollTo({ top: 0, behavior: reducedMotion.matches ? "auto" : "smooth" });
  else navigate(location.hash || "#/");
}
$("#topbar-tabs")?.addEventListener("click", onTabTap);
$("#bottom-nav")?.addEventListener("click", onTabTap);

/**
 * Warm the tabs the viewer is not on, so the first visit to each fills in
 * at once (see warm() in api.js). It waits for the page just opened to
 * load first, then runs when the browser is idle; a tab still kept alive
 * needs nothing. Warming is deduped and expires, so calling this after
 * every navigation costs at most one fetch per URL a minute.
 */
let warmTimer = null;
function warmRoute(path) {
  const route = ROUTES[path];
  if (!route?.warm || path === domPath) return;
  const k = kept.get(path);
  if (k && Date.now() - k.at < KEEP_MS) return;
  route.warm();
}
function scheduleWarmTabs() {
  clearTimeout(warmTimer);
  warmTimer = setTimeout(() => {
    const idle = window.requestIdleCallback ?? ((fn) => setTimeout(fn, 0));
    idle(() => {
      if (!getUser() || document.hidden) return;
      for (const path of Object.keys(ROUTES)) warmRoute(path);
    }, { timeout: 3000 });
  }, 1500);
}

// A pointer on a tab, or a finger pressing one, is a head start on its click.
const warmTabLink = (e) => {
  const a = e.target.closest?.("a[data-page]");
  if (a) warmRoute(a.getAttribute("href").slice(1) || "/");
};
for (const nav of [$("#topbar-tabs"), $("#bottom-nav")]) {
  for (const type of ["pointerover", "pointerdown", "focusin"]) nav?.addEventListener(type, warmTabLink, { passive: true });
}

// What a kept page shows can go stale behind its back.
document.addEventListener("sportsarc:user-changed", () => forgetPages());
document.addEventListener("sportsarc:posted", () => forgetPages("/profile"));
// A follow made on one page changes the counts and buttons the others show.
// The page it was made on is on screen, not kept, so it is never dropped here.
document.addEventListener("sportsarc:follow-changed", () => forgetPages("/profile", "/people"));

function refreshRoutes() {
  ROUTES = { ...CORE_ROUTES, ...moduleRoutes() };
  for (const r of modulePrefixRoutes()) {
    if (!PREFIX_ROUTES.some((p) => p.prefix === r.prefix)) PREFIX_ROUTES.push(r);
  }
  renderTabs();
}

function setActiveTab(page) {
  $$(".topbar-tab, .bnav-item[data-page]").forEach((t) => {
    const on = t.dataset.page === page;
    t.classList.toggle("active", on);
    if (on) t.setAttribute("aria-current", "page"); else t.removeAttribute("aria-current");
  });
}

/**
 * Pages that open without an account: a verified record, one receipt, the
 * map, and any module page registered with `guest: true` (modules.js).
 */
const SHARED_CORE = new Set(["/map"]);
const isSharedPath = (path) =>
  /^\/record\/.|^\/verify\/./.test(path) || SHARED_CORE.has(path) || isGuestModulePath(path);

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
let shownPath = null;  // the path asked for last, so a re-render of it does not animate
let domPath = null;    // the path whose page is in #main-content right now
let swapSeq = 0;       // a newer navigation cancels a swap still waiting on its transition

/**
 * Kept tabs. Leaving a route marked `keep` moves its nodes, listeners and
 * all, into a fragment with the scroll position; coming back puts them
 * back as they were and calls the route's `resume` to refresh in place.
 * A page left mid-load (it still holds a .skel) or kept longer than
 * KEEP_MS renders fresh instead.
 */
const KEEP_MS = 5 * 60_000;
const kept = new Map();  // path → { frag, y, at }

function stashPage() {
  const el = main();
  if (!domPath || !ROUTES[domPath]?.keep || !el.firstChild) return;
  const y = window.scrollY;  // before the nodes leave and the page collapses
  const frag = document.createDocumentFragment();
  frag.append(...el.childNodes);
  kept.set(domPath, { frag, y, at: Date.now() });
}

/** html has scroll-behavior: smooth; a page swap must land at once, not glide. */
const jumpTo = (y) => window.scrollTo({ top: y, behavior: "instant" });

function forgetPages(...paths) {
  if (paths.length) paths.forEach((p) => kept.delete(p)); else kept.clear();
}

/**
 * Replace the page. A kept tab comes back instantly where it was left, as
 * on X. Otherwise moving to another path cross-fades through a view
 * transition (the header and bottom bar are held still by their own
 * view-transition-name), or plays .page-enter where the API is missing.
 * Re-rendering the same path, as wallet setup does, swaps without motion.
 */
function swap(path, paint) {
  const moved = shownPath !== path;
  shownPath = path;
  const seq = ++swapSeq;
  const el = main();

  const saved = moved ? kept.get(path) : null;
  kept.delete(path);
  if (saved && Date.now() - saved.at < KEEP_MS && !saved.frag.querySelector(".skel")) {
    stashPage();
    domPath = path;
    // Re-inserted rows would replay their fade-in; .is-restored holds them still.
    el.classList.add("is-restored");
    el.replaceChildren(saved.frag);
    jumpTo(saved.y);
    ROUTES[path].resume?.();
    return;
  }

  const run = () => {
    if (seq !== swapSeq) return;
    if (moved) stashPage();
    domPath = path;
    el.classList.remove("is-restored");
    el.innerHTML = "";
    jumpTo(0);
    paint();
  };
  if (!moved || reducedMotion.matches) { run(); return; }
  if (document.startViewTransition) {
    // A newer navigation skips this one's transition; that rejection is expected, not an error.
    const t = document.startViewTransition(run);
    for (const p of [t.ready, t.finished, t.updateCallbackDone]) p?.catch(() => {});
    return;
  }
  run();
  el.classList.remove("page-enter");
  void el.offsetWidth;  // restart the animation
  el.classList.add("page-enter");
}

function navigate(hash) {
  const user = getUser();
  const path = hash.replace("#", "") || "/";
  // A signed-out visitor sees a shared page with no tabs or account menu.
  const guest = !user && isSharedPath(path);
  document.body.classList.toggle("guest", guest);
  if (guest) hideAuth();
  else if (!user) { shownPath = domPath = null; forgetPages(); showAuth(); return; }

  setAccount(false);
  // Sheets and the image viewer belong to the page they opened on.
  $$(".sheet, .lightbox").forEach((el) => el.remove());
  document.body.classList.remove("sheet-open");

  let render;
  const prefixed = PREFIX_ROUTES.find((r) => r.match(path));
  if (prefixed) {
    const rest = path.slice(prefixed.prefix.length);
    setActiveTab(typeof prefixed.tab === "function" ? prefixed.tab(rest) : prefixed.tab);
    render = () => prefixed.render(rest, { guest });
  } else {
    const route = ROUTES[path] ?? ROUTES["/"];
    const tab = route.tab ?? [...CORE_TABS, ...listModules()].find((t) => t.path === path)?.id ?? "home";
    setActiveTab(ROUTES[path] ? tab : "home");
    render = route.render;
  }

  swap(path, () => {
    try {
      // An async page's own failures are its business; a sync throw lands here.
      void render();
    } catch (err) {
      // A page that throws should say so rather than leave a blank screen.
      console.error("[app] render failed:", err);
      main().innerHTML =
        `<div class="empty"><p>Something went wrong loading this page.</p>
         <p class="empty-sub">${esc(String(err?.message ?? err))}</p></div>`;
    }
  });
  if (path !== "/notifications") void refreshBadge();
  scheduleWarmTabs();
}

window.addEventListener("hashchange", () => navigate(location.hash));

// ═══════════════════════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════════════════════
void (async function boot() {
  try {
    const cfg = await loadPublicConfig();
    if (cfg?.auth) authOptions = { ...authOptions, ...cfg.auth };
    if (cfg?.showcaseRecord) {
      const a = document.createElement("a");
      a.className = "auth-explore-link";
      a.href = `#/record/${encodeURIComponent(cfg.showcaseRecord)}`;
      a.textContent = "See a verified record";
      $("#auth-explore").append(a);
    }
  } catch (err) {
    console.warn("[app] public config not ready:", err);
  }

  // Optional modules register routes and tabs, so they load before routing.
  await loadEnabledModules();
  refreshRoutes();

  const me = await account.fetchMe();
  if (me?.profileComplete) {
    // A refresh during the offer should land back on the question, not in the app.
    if (!me.walletAddress && pinOfferPending()) {
      pendingSignupUser = me;
      authStep = "pin-offer";
      showAuth();
      return;
    }
    clearPinOffer();
    enterApp(me);
    return;
  }
  if (me) {
    authStep = "profile";
    showAuth();
    return;
  }

  if (getUser()) clearUser();
  // Signed out: navigate() shows a shared page, or the sign-in screen.
  navigate(location.hash || "#/");
})();
