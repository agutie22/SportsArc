/**
 * Private-beta rules (invites.ts) and mail settings (mailer.ts): who may get
 * a login code, who is an admin, and which mail configurations may start.
 * Pure: no database, no network. Run with `pnpm test`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { adminEmails, inviteOnlyEnabled, isAdminEmail, signupAllowed } from "./invites.js";
import {
  consoleCodes,
  emailLoginEnabled,
  loginCodeMessage,
  mailConfig,
  mailConfigError,
  parseFrom,
  providerRequest,
  smsLoginEnabled,
} from "./mailer.js";

const base = { inviteOnly: true, hasAccount: false, kind: "email" as const, invited: false, admin: false };

test("invite-only is off unless BETA_INVITE_ONLY is truthy", () => {
  assert.equal(inviteOnlyEnabled({}), false);
  assert.equal(inviteOnlyEnabled({ BETA_INVITE_ONLY: "false" }), false);
  assert.equal(inviteOnlyEnabled({ BETA_INVITE_ONLY: "0" }), false);
  assert.equal(inviteOnlyEnabled({ BETA_INVITE_ONLY: "true" }), true);
  assert.equal(inviteOnlyEnabled({ BETA_INVITE_ONLY: " TRUE " }), true);
  assert.equal(inviteOnlyEnabled({ BETA_INVITE_ONLY: "1" }), true);
});

test("with invite-only off, anyone may sign up", () => {
  assert.equal(signupAllowed({ ...base, inviteOnly: false }), true);
  assert.equal(signupAllowed({ ...base, inviteOnly: false, kind: "phone" }), true);
});

test("existing accounts always sign in, email or phone", () => {
  assert.equal(signupAllowed({ ...base, hasAccount: true }), true);
  assert.equal(signupAllowed({ ...base, hasAccount: true, kind: "phone" }), true);
});

test("a new email needs an invite", () => {
  assert.equal(signupAllowed(base), false);
  assert.equal(signupAllowed({ ...base, invited: true }), true);
});

test("an admin email may sign up without an invite, so the beta can bootstrap", () => {
  assert.equal(signupAllowed({ ...base, admin: true }), true);
});

test("a new phone number can never sign up in invite-only mode", () => {
  assert.equal(signupAllowed({ ...base, kind: "phone", invited: true, admin: true }), false);
});

test("ADMIN_EMAILS is comma-separated, trimmed, case-insensitive; junk is ignored", () => {
  const env = { ADMIN_EMAILS: " Owner@Example.com, ,not-an-email,ops@example.org " };
  assert.deepEqual([...adminEmails(env)].sort(), ["ops@example.org", "owner@example.com"]);
  assert.equal(isAdminEmail("owner@example.com", env), true);
  assert.equal(isAdminEmail("OWNER@example.com ", env), true);
  assert.equal(isAdminEmail("other@example.com", env), false);
  assert.equal(isAdminEmail(null, env), false);
  assert.equal(isAdminEmail("owner@example.com", {}), false);
  assert.equal(isAdminEmail("", { ADMIN_EMAILS: "," }), false);
});

test("console mail is the dev default and prints codes only outside production", () => {
  assert.equal(mailConfig({}).provider, "console");
  assert.equal(mailConfigError({}), null);
  assert.equal(consoleCodes({}), true);
  assert.equal(consoleCodes({ NODE_ENV: "production" }), false);
  assert.match(mailConfigError({ NODE_ENV: "production" }) ?? "", /production/);
  assert.match(mailConfigError({ NODE_ENV: "production", EMAIL_PROVIDER: "console" }) ?? "", /production/);
  assert.equal(emailLoginEnabled({ NODE_ENV: "production" }), false);
});

test("brevo and resend need a key and a sender; unknown providers are refused", () => {
  assert.match(mailConfigError({ EMAIL_PROVIDER: "brevo" }) ?? "", /BREVO_API_KEY/);
  assert.match(mailConfigError({ EMAIL_PROVIDER: "brevo", BREVO_API_KEY: "k" }) ?? "", /EMAIL_FROM/);
  assert.equal(mailConfigError({ EMAIL_PROVIDER: "brevo", BREVO_API_KEY: "k", EMAIL_FROM: "a@b.co" }), null);
  assert.match(mailConfigError({ EMAIL_PROVIDER: "resend", BREVO_API_KEY: "k", EMAIL_FROM: "a@b.co" }) ?? "", /RESEND_API_KEY/);
  assert.equal(
    mailConfigError({ NODE_ENV: "production", EMAIL_PROVIDER: "resend", RESEND_API_KEY: "k", EMAIL_FROM: "a@b.co" }),
    null,
  );
  assert.match(mailConfigError({ EMAIL_PROVIDER: "smtp" }) ?? "", /not supported/);
  assert.match(mailConfigError({ EMAIL_PROVIDER: "brevo", BREVO_API_KEY: "k", EMAIL_FROM: "nope" }) ?? "", /EMAIL_FROM/);
});

test("an API URL override must be loopback", () => {
  const ok = { EMAIL_PROVIDER: "brevo", BREVO_API_KEY: "k", EMAIL_FROM: "a@b.co" };
  assert.equal(mailConfigError({ ...ok, BREVO_API_URL: "http://127.0.0.1:9999/v3/smtp/email" }), null);
  assert.equal(mailConfigError({ ...ok, BREVO_API_URL: "http://localhost:9999/x" }), null);
  assert.match(mailConfigError({ ...ok, BREVO_API_URL: "https://evil.example/x" }) ?? "", /loopback/);
  assert.match(mailConfigError({ ...ok, BREVO_API_URL: "http://127.0.0.1.evil.example/x" }) ?? "", /loopback/);
});

test("EMAIL_FROM parses as an address or Name <address>", () => {
  assert.deepEqual(parseFrom("a@b.co"), { name: null, email: "a@b.co" });
  assert.deepEqual(parseFrom("SportsArc <login@b.co>"), { name: "SportsArc", email: "login@b.co" });
  assert.deepEqual(parseFrom('"Sports Arc" <login@b.co>'), { name: "Sports Arc", email: "login@b.co" });
  assert.equal(parseFrom("SportsArc"), null);
});

test("request shapes: Brevo uses api-key and sender objects; Resend uses a bearer token", () => {
  const msg = loginCodeMessage("123456", 10);
  const brevo = providerRequest(
    mailConfig({ EMAIL_PROVIDER: "brevo", BREVO_API_KEY: "bk", EMAIL_FROM: "SportsArc <s@b.co>" }),
    "t@x.co",
    msg,
  );
  assert.equal(brevo.headers["api-key"], "bk");
  assert.deepEqual(brevo.body.sender, { name: "SportsArc", email: "s@b.co" });
  assert.deepEqual(brevo.body.to, [{ email: "t@x.co" }]);
  assert.ok(String(brevo.body.textContent).includes("123456"));
  const resend = providerRequest(
    mailConfig({ EMAIL_PROVIDER: "resend", RESEND_API_KEY: "rk", EMAIL_FROM: "s@b.co" }),
    "t@x.co",
    msg,
  );
  assert.equal(resend.headers.Authorization, "Bearer rk");
  assert.deepEqual(resend.body.to, ["t@x.co"]);
});

test("the email carries the code and its expiry in text and HTML", () => {
  const m = loginCodeMessage("042917", 10);
  assert.match(m.subject, /042917/);
  assert.match(m.text, /042917/);
  assert.match(m.text, /10 minutes/);
  assert.match(m.html, /042917/);
  assert.match(m.html, /10 minutes/);
});

test("phone login is not offered: there is no SMS sender", () => {
  assert.equal(smsLoginEnabled({}), false);
});
