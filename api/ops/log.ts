/**
 * Structured logging: one JSON object per line on stdout in production,
 * readable lines in development. Grafana/Loki (deploy/, the ship stream)
 * parses the JSON form, so its field names are a contract:
 *
 *   ts      ISO timestamp            level   debug | info | warn | error
 *   msg     the message              source  server | client | job:<name>
 *   reqId   set inside a request     module  a console call's "[prefix]"
 *   err     { name, message, stack } on errors
 *   kind    "access" on access lines (with route, method, status, ms, userId)
 *
 * LOG_FORMAT=json|pretty (json when NODE_ENV=production, else pretty) and
 * LOG_LEVEL=debug|info|warn|error (default info).
 *
 * Every line passes through redact(): values under secret-looking field
 * names (token, key, secret, password, cookie, authorization, code, ...)
 * and secret-looking substrings in messages (bearer tokens, session
 * cookies, provider API keys) never reach the output. Callers still must
 * not log request bodies, emails or phone numbers; redaction is the net,
 * not the rule.
 *
 * installConsoleBridge() turns console.log/info/debug/warn/error into lines
 * from this logger, so modules that log with console keep working and still
 * produce JSON. It is only installed for the JSON format; in pretty mode the
 * console is left alone (the dev-only `[otp]` lines print exactly as before).
 *
 * The context (reqId, source, route) lives in an AsyncLocalStorage
 * here so everything logged while handling a request or a job tick carries
 * it without being passed around. request-context.ts fills it for requests
 * and jobs.ts for job ticks.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { format as utilFormat, inspect } from "node:util";

const LEVELS = ["debug", "info", "warn", "error"] as const;
export type Level = (typeof LEVELS)[number];
export type LogFormat = "json" | "pretty";
export type Fields = Record<string, unknown>;

/** What every line logged inside a request or job carries. */
export interface LogContext {
  reqId?: string;
  source?: string;
  /** Route pattern, set once the router has matched. */
  route?: string;
}

export const logContext = new AsyncLocalStorage<LogContext>();

/** Run `fn` with `ctx` as the logging context (merged over any outer one). */
export function withLogContext<T>(ctx: LogContext, fn: () => T): T {
  const outer = logContext.getStore();
  return logContext.run(outer ? { ...outer, ...ctx } : ctx, fn);
}

// ── configuration ─────────────────────────────────────────────────────

type Env = Record<string, string | undefined>;

export interface LogConfig {
  format: LogFormat;
  level: Level;
  /** True under NODE_ENV=production: extra scrubbing of bridged `[otp]` lines. */
  production: boolean;
  /** Where a finished line goes (tests swap this). */
  write: (line: string, level: Level) => void;
}

export function parseLevel(raw: string | undefined): Level {
  const v = raw?.trim().toLowerCase();
  return (LEVELS as readonly string[]).includes(v ?? "") ? (v as Level) : "info";
}

export function parseFormat(raw: string | undefined, env: Env = process.env): LogFormat {
  const v = raw?.trim().toLowerCase();
  if (v === "json" || v === "pretty") return v;
  return env.NODE_ENV?.trim() === "production" ? "json" : "pretty";
}

/** Raw stream writes, captured before any bridge touches the console. */
const stdoutWrite = process.stdout.write.bind(process.stdout);
const stderrWrite = process.stderr.write.bind(process.stderr);

function defaultWrite(format: LogFormat) {
  return (line: string, level: Level) => {
    // JSON: everything on stdout, one line each, which is what Loki reads.
    // Pretty: warnings and errors on stderr, as console.warn/error did.
    if (format === "pretty" && (level === "warn" || level === "error")) stderrWrite(line + "\n");
    else stdoutWrite(line + "\n");
  };
}

function configFromEnv(env: Env = process.env): LogConfig {
  const format = parseFormat(env.LOG_FORMAT, env);
  return {
    format,
    level: parseLevel(env.LOG_LEVEL),
    production: env.NODE_ENV?.trim() === "production",
    write: defaultWrite(format),
  };
}

let config: LogConfig | null = null;

function cfg(): LogConfig {
  if (!config) config = configFromEnv();
  return config;
}

/** Change the configuration (tests); returns the previous one to restore. */
export function configureLog(next: Partial<LogConfig>): LogConfig {
  const prev = cfg();
  config = { ...prev, ...next };
  if (next.format && !next.write) config.write = defaultWrite(next.format);
  return prev;
}

export function logFormat(): LogFormat {
  return cfg().format;
}

function levelEnabled(level: Level): boolean {
  return LEVELS.indexOf(level) >= LEVELS.indexOf(cfg().level);
}

// ── redaction ─────────────────────────────────────────────────────────

export const REDACTED = "[redacted]";

/**
 * Words that mark a field as secret wherever they appear in its name
 * (camelCase, snake_case and kebab-case are split into words first).
 */
const SECRET_WORDS = new Set([
  "token", "tokens", "secret", "secrets", "password", "passwd", "passphrase",
  "cookie", "cookies", "authorization", "auth", "otp", "key", "keys",
  "apikey", "privatekey", "mnemonic", "seed", "signature", "credential",
  "credentials", "session", "body", "email", "phone",
]);

function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Whether a field's value must not be logged. `code` is special: error
 * codes such as RATE_LIMITED or ECONNREFUSED stay (they are what alerts key
 * on), any other value under a `code` field (a login code) is redacted, as
 * is anything named like loginCode or verificationCode.
 */
export function secretField(name: string, value?: unknown): boolean {
  const w = words(name);
  if (w.some((x) => SECRET_WORDS.has(x))) return true;
  const last = w[w.length - 1];
  const prev = w[w.length - 2] ?? "";
  if (w.length === 1 && last === "code") {
    return !(typeof value === "string" && /^[A-Z][A-Z0-9_]*$/.test(value));
  }
  return last === "code" && ["login", "verification", "verify", "sms", "access", "auth"].includes(prev);
}

/** Secret-looking substrings, replaced inside any logged string. */
const SECRET_PATTERNS: [RegExp, string][] = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`],
  [/\b(sportsarc_session)=[^;\s,"]+/g, `$1=${REDACTED}`],
  [/\bxkeysib-[A-Za-z0-9-]+/g, REDACTED],
  [/\bxsmtpsib-[A-Za-z0-9-]+/g, REDACTED],
  [/\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9_]+/g, REDACTED],
  [/\b(TEST_API_KEY|LIVE_API_KEY):[A-Za-z0-9:]+/g, `$1:${REDACTED}`],
  [/\b((?:api[_-]?key|token|secret|password)["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi, `$1${REDACTED}`],
];

export function scrubString(s: string): string {
  let out = s;
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
  return out;
}

export interface LoggedError {
  name: string;
  message: string;
  stack?: string;
  code?: string;
}

function serializeError(err: unknown): LoggedError {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    const out: LoggedError = {
      name: err.name || "Error",
      message: scrubString(err.message ?? ""),
      stack: err.stack ? scrubString(err.stack) : undefined,
    };
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]*$/.test(code)) out.code = code;
    return out;
  }
  if (err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string") {
    const e = err as { name?: unknown; message: string; stack?: unknown };
    return {
      name: typeof e.name === "string" && e.name ? e.name : "Error",
      message: scrubString(e.message),
      stack: typeof e.stack === "string" ? scrubString(e.stack) : undefined,
    };
  }
  return { name: "NonError", message: scrubString(typeof err === "string" ? err : inspect(err, { depth: 2 })) };
}

/**
 * A copy of `value` safe to log: secret fields replaced, strings scrubbed,
 * Errors serialized, depth and size bounded, cycles cut.
 */
export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return scrubString(value.length > 8_000 ? value.slice(0, 8_000) + "…" : value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return undefined;
  if (value instanceof Error) return serializeError(value);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[circular]";
  if (depth >= 5) return "[truncated]";
  seen.add(value);
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return `[${value.constructor.name} ${(value as { length?: number }).length ?? ""}]`;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1, seen));
  const out: Record<string, unknown> = {};
  let n = 0;
  for (const [k, v] of Object.entries(value)) {
    if (n++ >= 50) {
      out["…"] = "[truncated]";
      break;
    }
    out[k] = secretField(k, v) && v !== undefined && v !== null ? REDACTED : redact(v, depth + 1, seen);
  }
  return out;
}

// ── lines ─────────────────────────────────────────────────────────────

/** Fields a caller may not override: they are the line's frame. */
const FRAME = new Set(["ts", "level", "msg"]);

/**
 * Build one log record: frame, then context, then the caller's fields
 * (redacted). `err` is serialized wherever it appears in `fields`.
 */
export function buildRecord(level: Level, msg: string, fields: Fields = {}, now = new Date()): Record<string, unknown> {
  const ctx = logContext.getStore();
  const rec: Record<string, unknown> = {
    ts: now.toISOString(),
    level,
    msg: scrubString(msg),
    source: ctx?.source ?? "server",
  };
  if (ctx?.reqId) rec.reqId = ctx.reqId;
  for (const [k, v] of Object.entries(fields)) {
    if (FRAME.has(k) || v === undefined) continue;
    if (k === "err") rec.err = serializeError(v);
    else if (secretField(k, v)) rec[k] = REDACTED;
    else rec[k] = redact(v);
  }
  return rec;
}

const PRETTY_LEVEL: Record<Level, string> = { debug: "DEBUG", info: "INFO ", warn: "WARN ", error: "ERROR" };

export function formatRecord(rec: Record<string, unknown>, format: LogFormat): string {
  if (format === "json") return JSON.stringify(rec);
  const { ts, level, msg, source, module, err, ...rest } = rec;
  const time = String(ts).slice(11, 23);
  const tag = module ? `[${module}] ` : "";
  const src = source && source !== "server" ? `(${source}) ` : "";
  // An access line's msg already reads "GET /api/x/:id 200".
  if (rest.kind === "access") for (const k of ["kind", "method", "route", "status"]) delete rest[k];
  const extra = Object.entries(rest)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
  let line = `${time} ${PRETTY_LEVEL[level as Level] ?? level} ${src}${tag}${msg}${extra ? `  ${extra}` : ""}`;
  const e = err as LoggedError | undefined;
  if (e) line += `\n${e.stack ?? `${e.name}: ${e.message}`}`;
  return line;
}

function emit(level: Level, msg: string, fields?: Fields): void {
  if (!levelEnabled(level)) return;
  const c = cfg();
  let line: string;
  try {
    line = formatRecord(buildRecord(level, msg, fields), c.format);
  } catch (e) {
    // A logger must never throw into its caller.
    line = JSON.stringify({ ts: new Date().toISOString(), level, msg: scrubString(String(msg)), logError: String(e) });
  }
  c.write(line, level);
}

export const log = {
  debug: (msg: string, fields?: Fields) => emit("debug", msg, fields),
  info: (msg: string, fields?: Fields) => emit("info", msg, fields),
  warn: (msg: string, fields?: Fields) => emit("warn", msg, fields),
  error: (msg: string, fields?: Fields) => emit("error", msg, fields),
};

// ── console bridge ────────────────────────────────────────────────────

const CONSOLE_LEVEL = { debug: "debug", log: "info", info: "info", warn: "warn", error: "error" } as const;
type ConsoleMethod = keyof typeof CONSOLE_LEVEL;

let originalConsole: Partial<Record<ConsoleMethod, (...args: unknown[]) => void>> | null = null;

/** The first Error among the arguments, or one level inside an object argument. */
function findError(args: unknown[]): Error | undefined {
  for (const a of args) if (a instanceof Error) return a;
  for (const a of args) {
    if (a && typeof a === "object" && !Array.isArray(a)) {
      for (const v of Object.values(a)) if (v instanceof Error) return v;
    }
  }
  return undefined;
}

/**
 * Turn console arguments into a message and fields: a leading `[prefix]`
 * becomes `module`, Errors become `err` (with the stack) and their
 * `name: message` in the text, other objects are redacted and inspected.
 */
export function consoleRecord(args: unknown[], production = cfg().production): { msg: string; fields: Fields } {
  const fields: Fields = {};
  const err = findError(args);
  if (err) fields.err = err;
  const parts = args.map((a) => {
    if (a instanceof Error) return `${a.name}: ${a.message}`;
    if (typeof a === "string") return a;
    if (a && typeof a === "object") return inspect(redact(a), { depth: 4, breakLength: Infinity });
    return a;
  });
  let msg = (typeof parts[0] === "string" && parts.length > 1 && /%[sdifjoOc%]/.test(parts[0]))
    ? utilFormat(...(parts as [string, ...unknown[]]))
    : parts.map((p) => (typeof p === "string" ? p : String(p))).join(" ");
  msg = msg.trim();
  const m = /^\[([A-Za-z0-9_.:-]{1,40})\]\s*/.exec(msg);
  if (m) {
    fields.module = m[1];
    msg = msg.slice(m[0].length);
  }
  // Second lock behind mailer.ts: in production no bridged otp/mail line
  // can carry a 4–8 digit run (a login code).
  if (production && (fields.module === "otp" || fields.module === "mail")) {
    msg = msg.replace(/\b\d{4,8}\b/g, "******");
  }
  return { msg, fields };
}

/**
 * Route console.* through the logger. Idempotent; uninstallConsoleBridge()
 * restores the originals (tests).
 */
export function installConsoleBridge(): void {
  if (originalConsole) return;
  originalConsole = {};
  for (const method of Object.keys(CONSOLE_LEVEL) as ConsoleMethod[]) {
    originalConsole[method] = console[method];
    console[method] = (...args: unknown[]) => {
      const level = CONSOLE_LEVEL[method];
      if (!levelEnabled(level)) return;
      const { msg, fields } = consoleRecord(args);
      emit(level, msg, fields);
    };
  }
}

export function uninstallConsoleBridge(): void {
  if (!originalConsole) return;
  for (const [method, fn] of Object.entries(originalConsole)) {
    if (fn) (console as unknown as Record<string, unknown>)[method] = fn;
  }
  originalConsole = null;
}
