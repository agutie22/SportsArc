/**
 * Outgoing mail, starting with login codes.
 *
 * One seam, `sendLoginCode`, with the provider chosen by EMAIL_PROVIDER:
 *
 *   console  the default outside production: prints `[otp] email <to> <code>`
 *            to the API log, as before. Never prints a code in production.
 *   brevo    Brevo's transactional email API (BREVO_API_KEY, EMAIL_FROM).
 *            The beta's provider: Brevo sends from a single verified sender
 *            address, so it works before SportsArc owns a mail domain.
 *   resend   Resend's email API (RESEND_API_KEY, EMAIL_FROM). Resend only
 *            delivers to arbitrary recipients from a verified domain, so use
 *            it once a domain exists.
 *
 * BREVO_API_URL / RESEND_API_URL may point at a loopback stub for tests; any
 * other host is refused. Both are plain fetch calls, no SDK.
 *
 * In production (NODE_ENV=production) a missing or console provider is a
 * configuration error: server.ts refuses to start (see mailConfigError), and
 * the console provider also refuses at send time, so a code can never reach
 * the log even if the boot check is bypassed.
 *
 * Nothing here logs a code outside the console provider in development:
 * errors are logged by status and a scrubbed message only.
 */

export const DEFAULT_RESEND_API_URL = "https://api.resend.com/emails";
export const DEFAULT_BREVO_API_URL = "https://api.brevo.com/v3/smtp/email";
const DEFAULT_TIMEOUT_MS = 8_000;

export const MAIL_PROVIDERS = ["console", "brevo", "resend"] as const;
export type MailProvider = (typeof MAIL_PROVIDERS)[number];

const PROVIDER_LABEL: Record<MailProvider, string> = { console: "console", brevo: "Brevo", resend: "Resend" };
const KEY_VAR: Record<MailProvider, string> = { console: "", brevo: "BREVO_API_KEY", resend: "RESEND_API_KEY" };
const DEFAULT_URL: Record<MailProvider, string> = {
  console: "",
  brevo: DEFAULT_BREVO_API_URL,
  resend: DEFAULT_RESEND_API_URL,
};

export interface MailConfig {
  provider: MailProvider;
  production: boolean;
  apiKey: string;
  from: string;
  apiUrl: string;
  timeoutMs: number;
}

export interface MailError {
  ok: false;
  error: { code: string; message: string };
}

export type MailResult = { ok: true; provider: MailProvider; id: string | null } | MailError;

type Env = Record<string, string | undefined>;

export function isProduction(env: Env = process.env): boolean {
  return env.NODE_ENV?.trim() === "production";
}

/** Read mail settings from the environment. Pure; never throws. */
export function mailConfig(env: Env = process.env): MailConfig {
  const raw = env.EMAIL_PROVIDER?.trim().toLowerCase() || "console";
  const provider: MailProvider = (MAIL_PROVIDERS as readonly string[]).includes(raw)
    ? (raw as MailProvider)
    : "console";
  const timeout = Number.parseInt(env.EMAIL_TIMEOUT_MS ?? "", 10);
  const urlVar = provider === "brevo" ? env.BREVO_API_URL : provider === "resend" ? env.RESEND_API_URL : "";
  return {
    provider,
    production: isProduction(env),
    apiKey: provider === "console" ? "" : env[KEY_VAR[provider]]?.trim() ?? "",
    from: env.EMAIL_FROM?.trim() ?? "",
    apiUrl: urlVar?.trim() || DEFAULT_URL[provider],
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS,
  };
}

function isLoopbackUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    return (url.protocol === "http:" || url.protocol === "https:") &&
      (host === "127.0.0.1" || host === "localhost" || host === "::1");
  } catch {
    return false;
  }
}

/** "SportsArc <login@x.com>" or "login@x.com" into name and address. */
export function parseFrom(raw: string): { name: string | null; email: string } | null {
  const m = /^\s*(?:(.*?)\s*<([^<>\s]+@[^<>\s]+)>|([^<>\s]+@[^<>\s]+))\s*$/.exec(raw);
  if (!m) return null;
  const name = (m[1] ?? "").replace(/^\u0022|\u0022$/g, "").trim();
  return { name: name || null, email: m[2] ?? m[3] };
}

/**
 * What is wrong with the mail settings, or null when a code can be sent.
 * server.ts calls this at boot and refuses to start in production when it
 * returns anything.
 */
export function mailConfigError(env: Env = process.env): string | null {
  const unknown = env.EMAIL_PROVIDER?.trim().toLowerCase();
  if (unknown && !(MAIL_PROVIDERS as readonly string[]).includes(unknown)) {
    return `EMAIL_PROVIDER "${unknown}" is not supported (use console, brevo or resend).`;
  }
  const cfg = mailConfig(env);
  if (cfg.provider === "console") {
    if (cfg.production) {
      return "EMAIL_PROVIDER is console (or unset) in production; login codes would never be delivered. Set EMAIL_PROVIDER=brevo (or resend once a domain is verified).";
    }
    return null;
  }
  const name = cfg.provider;
  if (!cfg.apiKey) return `EMAIL_PROVIDER=${name} needs ${KEY_VAR[name]}.`;
  if (!cfg.from) return `EMAIL_PROVIDER=${name} needs EMAIL_FROM, e.g. "SportsArc <login@example.com>".`;
  if (!parseFrom(cfg.from)) return "EMAIL_FROM must be an address or \"Name <address>\".";
  if (cfg.apiUrl !== DEFAULT_URL[name] && !isLoopbackUrl(cfg.apiUrl)) {
    return `${name.toUpperCase()}_API_URL may only point at a loopback address (tests).`;
  }
  return null;
}

/** Whether email login can deliver a code right now. */
export function emailLoginEnabled(env: Env = process.env): boolean {
  return mailConfigError(env) === null;
}

/** Whether codes are printed to the API log (development only). */
export function consoleCodes(env: Env = process.env): boolean {
  const cfg = mailConfig(env);
  return cfg.provider === "console" && !cfg.production;
}

// ── message ───────────────────────────────────────────────────────────

export interface LoginCodeMessage {
  subject: string;
  text: string;
  html: string;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function loginCodeMessage(code: string, expiresInMinutes: number): LoginCodeMessage {
  const mins = `${expiresInMinutes} minute${expiresInMinutes === 1 ? "" : "s"}`;
  const subject = `${code} is your SportsArc code`;
  const text = [
    `Your SportsArc login code is ${code}`,
    "",
    `It expires in ${mins}. Enter it on the sign-in screen to continue.`,
    "",
    "If you did not ask for this code, you can ignore this email; nobody can sign in without it.",
    "",
    "SportsArc",
  ].join("\n");
  const c = escapeHtml(code);
  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f4f5f7;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#0f1115">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" cellpadding="0" cellspacing="0" style="max-width:440px;width:100%;background:#ffffff;border-radius:14px;padding:28px">
<tr><td style="font-size:20px;font-weight:700;letter-spacing:.5px">SportsArc</td></tr>
<tr><td style="padding-top:18px;font-size:15px;line-height:1.5">Your login code is</td></tr>
<tr><td style="padding:10px 0 14px;font-size:34px;font-weight:700;letter-spacing:8px;font-family:SFMono-Regular,Menlo,Consolas,monospace">${c}</td></tr>
<tr><td style="font-size:14px;line-height:1.5;color:#4a515c">It expires in ${escapeHtml(mins)}. Enter it on the sign-in screen to continue.</td></tr>
<tr><td style="padding-top:18px;font-size:12px;line-height:1.5;color:#7a818c">If you did not ask for this code, you can ignore this email; nobody can sign in without it.</td></tr>
</table></td></tr></table>
</body></html>`;
  return { subject, text, html };
}

// ── providers ─────────────────────────────────────────────────────────

/** Remove the code from anything that might be logged. */
function scrub(s: string, code: string): string {
  return code ? s.split(code).join("******") : s;
}

function fail(code: string, message: string): MailError {
  return { ok: false, error: { code, message } };
}

/** The provider-specific part of a request: headers and JSON body. */
export function providerRequest(
  cfg: MailConfig,
  to: string,
  msg: LoginCodeMessage,
): { headers: Record<string, string>; body: Record<string, unknown> } {
  if (cfg.provider === "brevo") {
    const from = parseFrom(cfg.from)!;
    return {
      headers: { "api-key": cfg.apiKey, "Content-Type": "application/json", Accept: "application/json" },
      body: {
        sender: from.name ? { name: from.name, email: from.email } : { email: from.email },
        to: [{ email: to }],
        subject: msg.subject,
        textContent: msg.text,
        htmlContent: msg.html,
      },
    };
  }
  return {
    headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
    body: { from: cfg.from, to: [to], subject: msg.subject, text: msg.text, html: msg.html },
  };
}

async function sendViaHttp(
  cfg: MailConfig,
  to: string,
  code: string,
  msg: LoginCodeMessage,
): Promise<MailResult> {
  const label = PROVIDER_LABEL[cfg.provider];
  const request = providerRequest(cfg, to, msg);
  let res: Response;
  try {
    res = await fetch(cfg.apiUrl, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(cfg.timeoutMs),
      redirect: "error",
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      console.warn(`[mail] ${label} timed out after ${cfg.timeoutMs}ms`);
    } else {
      const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      console.warn(`[mail] ${label} request failed: ${scrub(detail, code)}`);
    }
    return fail("SEND_FAILED", "Could not send the code. Try again in a moment.");
  }

  let body: { id?: unknown; messageId?: unknown; name?: unknown; code?: unknown; message?: unknown } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    /* non-JSON answer; the status says enough */
  }
  if (!res.ok) {
    const kind = typeof body.name === "string" ? body.name : typeof body.code === "string" ? body.code : "";
    const message = typeof body.message === "string" ? body.message : "";
    console.warn(`[mail] ${label} refused (${res.status}) ${scrub(`${kind} ${message}`.trim(), code).slice(0, 200)}`);
    return fail("SEND_FAILED", "Could not send the code. Try again in a moment.");
  }
  const id = typeof body.id === "string" ? body.id : typeof body.messageId === "string" ? body.messageId : null;
  return { ok: true, provider: cfg.provider, id };
}

/**
 * Deliver a login code by email. Returns a result object; never throws.
 */
export async function sendLoginCode(
  opts: { to: string; code: string; expiresInMinutes: number },
  env: Env = process.env,
): Promise<MailResult> {
  const cfg = mailConfig(env);
  const problem = mailConfigError(env);
  if (problem) {
    console.error(`[mail] not sending a login code: ${problem}`);
    return fail("EMAIL_NOT_CONFIGURED", "Email sign-in is not available right now.");
  }
  if (cfg.provider === "console") {
    // mailConfigError already refuses console in production; this is the
    // second lock, so a code can never be printed there.
    if (cfg.production) return fail("EMAIL_NOT_CONFIGURED", "Email sign-in is not available right now.");
    console.log(`[otp] email ${opts.to} ${opts.code}`);
    return { ok: true, provider: "console", id: null };
  }
  const msg = loginCodeMessage(opts.code, opts.expiresInMinutes);
  return sendViaHttp(cfg, opts.to, opts.code, msg);
}

/**
 * There is no SMS sender yet. Outside production a phone code prints to the
 * log like before, so the API path stays usable in development; in
 * production nothing is printed and the request fails.
 */
export function smsLoginEnabled(_env: Env = process.env): boolean {
  return false;
}

export async function sendLoginCodeSms(
  opts: { to: string; code: string },
  env: Env = process.env,
): Promise<MailResult> {
  if (isProduction(env)) {
    console.error("[otp] no SMS sender is configured; a phone code was not sent.");
    return fail("SMS_NOT_CONFIGURED", "Phone sign-in is not available. Use email.");
  }
  console.log(`[otp] phone ${opts.to} ${opts.code}`);
  return { ok: true, provider: "console", id: null };
}
