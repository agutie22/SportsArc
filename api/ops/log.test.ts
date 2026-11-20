/**
 * Unit tests for log.ts and the pure parts of request-context.ts: line
 * format, levels, redaction, the console bridge, reqId sanitising, and
 * client error report parsing. No database, no server.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  REDACTED,
  configureLog,
  consoleRecord,
  formatRecord,
  buildRecord,
  installConsoleBridge,
  log,
  parseFormat,
  parseLevel,
  redact,
  scrubString,
  secretField,
  uninstallConsoleBridge,
  withLogContext,
  type Level,
} from "./log.js";
import { accessLevel, clientKey, parseClientError, requestId } from "./request-context.js";
import type { IncomingMessage } from "node:http";

/** Capture JSON lines while `fn` runs. */
function capture(fn: () => void, level: Level = "debug"): Record<string, unknown>[] {
  const lines: string[] = [];
  const prev = configureLog({ format: "json", level, write: (l) => lines.push(l) });
  try {
    fn();
  } finally {
    configureLog(prev);
  }
  return lines.map((l) => {
    assert.ok(!l.includes("\n"), "one line per record");
    return JSON.parse(l) as Record<string, unknown>;
  });
}

test("format and level come from the environment with safe defaults", () => {
  assert.equal(parseFormat(undefined, { NODE_ENV: "production" }), "json");
  assert.equal(parseFormat(undefined, {}), "pretty");
  assert.equal(parseFormat("JSON", {}), "json");
  assert.equal(parseFormat("pretty", { NODE_ENV: "production" }), "pretty");
  assert.equal(parseFormat("xml", { NODE_ENV: "production" }), "json");
  assert.equal(parseLevel(undefined), "info");
  assert.equal(parseLevel("WARN"), "warn");
  assert.equal(parseLevel("verbose"), "info");
});

test("a JSON line has ts, level, msg, source, and caller fields", () => {
  const [rec] = capture(() => log.info("hello", { gameId: "g1", n: 3 }));
  assert.equal(typeof rec.ts, "string");
  assert.ok(!Number.isNaN(Date.parse(rec.ts as string)));
  assert.equal(rec.level, "info");
  assert.equal(rec.msg, "hello");
  assert.equal(rec.source, "server");
  assert.equal(rec.gameId, "g1");
  assert.equal(rec.n, 3);
  assert.equal(rec.reqId, undefined);
});

test("levels below LOG_LEVEL are dropped", () => {
  const recs = capture(() => {
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
  }, "warn");
  assert.deepEqual(recs.map((r) => r.level), ["warn", "error"]);
});

test("context carries reqId and source; callers cannot overwrite ts/level/msg", () => {
  const recs = capture(() => {
    withLogContext({ reqId: "req-12345678", source: "server" }, () => {
      log.info("in request", { level: "error", msg: "nope", ts: "x" });
      withLogContext({ source: "job:recaps" }, () => log.warn("nested"));
    });
    log.info("outside");
  });
  assert.equal(recs[0].reqId, "req-12345678");
  assert.equal(recs[0].level, "info");
  assert.equal(recs[0].msg, "in request");
  assert.equal(recs[1].source, "job:recaps");
  assert.equal(recs[1].reqId, "req-12345678");
  assert.equal(recs[2].reqId, undefined);
  assert.equal(recs[2].source, "server");
});

test("errors are serialized with name, message and stack", () => {
  const [rec] = capture(() => log.error("boom", { err: new TypeError("bad thing") }));
  const err = rec.err as { name: string; message: string; stack: string };
  assert.equal(err.name, "TypeError");
  assert.equal(err.message, "bad thing");
  assert.match(err.stack, /log\.test\.ts/);
  const [plain] = capture(() => log.error("x", { err: "just a string" }));
  assert.equal((plain.err as { message: string }).message, "just a string");
});

test("secret field names are redacted, error codes are kept", () => {
  for (const k of ["authorization", "cookie", "set-cookie", "apiKey", "api_key", "privateKey", "PRIVATE_KEY",
    "token", "accessToken", "secret", "sessionSecret", "password", "otp", "body", "email", "phone", "loginCode"]) {
    assert.equal(secretField(k, "v"), true, k);
  }
  for (const k of ["userId", "reqId", "route", "status", "ms", "gameId", "statusCode", "method"]) {
    assert.equal(secretField(k, "v"), false, k);
  }
  assert.equal(secretField("code", "123456"), true);
  assert.equal(secretField("code", 123456), true);
  assert.equal(secretField("code", "RATE_LIMITED"), false);
  assert.equal(secretField("code", "ECONNREFUSED"), false);

  const [rec] = capture(() => log.info("r", {
    code: "482913",
    headers: { authorization: "Bearer abc.def", cookie: "sportsarc_session=xyz", accept: "json" },
    error: { code: "SEND_FAILED", message: "no" },
    nested: { deeper: { apiKey: "xkeysib-123", ok: 1 } },
  }));
  assert.equal(rec.code, REDACTED);
  const h = rec.headers as Record<string, unknown>;
  assert.equal(h.authorization, REDACTED);
  assert.equal(h.cookie, REDACTED);
  assert.equal(h.accept, "json");
  assert.deepEqual(rec.error, { code: "SEND_FAILED", message: "no" });
  assert.deepEqual((rec.nested as { deeper: unknown }).deeper, { apiKey: REDACTED, ok: 1 });
  const line = JSON.stringify(rec);
  for (const bad of ["482913", "abc.def", "xyz", "xkeysib-123"]) assert.ok(!line.includes(bad), bad);
});

test("secret-looking substrings are scrubbed from messages and stacks", () => {
  const s = scrubString(
    "Authorization: Bearer eyJhbGciOi.x.y; Cookie: sportsarc_session=abc.def; key xkeysib-aaaa-bbbb re_123456789_abcdef api_key=hunter2 TEST_API_KEY:aa:bb",
  );
  for (const bad of ["eyJhbGciOi", "abc.def", "xkeysib-aaaa", "re_123456789_abcdef", "hunter2", "aa:bb"]) {
    assert.ok(!s.includes(bad), `${bad} in ${s}`);
  }
  const [rec] = capture(() => log.warn("request failed: Bearer sekrit-token"));
  assert.ok(!String(rec.msg).includes("sekrit-token"));
  const err = new Error("upstream said token=abcdef123");
  const [e] = capture(() => log.error("x", { err }));
  assert.ok(!JSON.stringify(e).includes("abcdef123"));
});

test("redact bounds cycles, depth and odd values", () => {
  const a: Record<string, unknown> = { n: 1n, d: new Date(0), f: () => 1 };
  a.self = a;
  const r = redact(a) as Record<string, unknown>;
  assert.equal(r.n, "1");
  assert.equal(r.d, "1970-01-01T00:00:00.000Z");
  assert.equal(r.f, undefined);
  assert.equal(r.self, "[circular]");
  let deep: Record<string, unknown> = { v: 1 };
  for (let i = 0; i < 10; i++) deep = { deep };
  assert.match(JSON.stringify(redact(deep)), /\[truncated\]/);
});

test("pretty format is one readable line plus a stack for errors", () => {
  const rec = buildRecord("warn", "slow", { module: "jobs", ms: 12 }, new Date("2026-01-02T03:04:05.678Z"));
  assert.equal(formatRecord(rec, "pretty"), "03:04:05.678 WARN  [jobs] slow  ms=12");
  const a = buildRecord("info", "GET /api/games/:id 200",
    { kind: "access", method: "GET", route: "/api/games/:id", status: 200, ms: 1.5 }, new Date("2026-01-02T03:04:05.678Z"));
  assert.equal(formatRecord(a, "pretty"), "03:04:05.678 INFO  GET /api/games/:id 200  ms=1.5");
  const e = buildRecord("error", "bad", { err: new Error("x") });
  assert.match(formatRecord(e, "pretty"), /ERROR bad\nError: x\n\s+at /);
});

test("console bridge: prefix becomes module, Errors carry their stack", () => {
  const { msg, fields } = consoleRecord(["[recaps] tick failed:", new Error("db down")], false);
  assert.equal(fields.module, "recaps");
  assert.equal(msg, "tick failed: Error: db down");
  assert.ok(fields.err instanceof Error);

  const nested = consoleRecord(["[auth] createUser failed:", { userId: "u1", error: new Error("nope") }], false);
  assert.ok(nested.fields.err instanceof Error);
  assert.match(nested.msg, /userId: 'u1'/);

  const formatted = consoleRecord(["%s has %d items", "cart", 3], false);
  assert.equal(formatted.msg, "cart has 3 items");
  assert.equal(formatted.fields.module, undefined);

  const secret = consoleRecord(["[auth] config", { apiKey: "k-123", ok: true }], false);
  assert.ok(!secret.msg.includes("k-123"));
});

test("console bridge: production scrubs digit runs from otp and mail lines", () => {
  assert.equal(consoleRecord(["[otp] email a@b.co 123456"], true).msg, "email a@b.co ******");
  assert.equal(consoleRecord(["[otp] email a@b.co 123456"], false).msg, "email a@b.co 123456");
  assert.equal(consoleRecord(["[recaps] wrote 123456 recaps"], true).msg, "wrote 123456 recaps");
});

test("console bridge routes console.* to JSON lines at matching levels, and uninstalls", () => {
  const lines: string[] = [];
  const prev = configureLog({ format: "json", level: "debug", write: (l) => lines.push(l) });
  installConsoleBridge();
  try {
    withLogContext({ reqId: "abcdefgh-1" }, () => {
      console.log("[games] hello");
      console.warn("[results] tick failed:", "db");
      console.error(new RangeError("out"));
      console.debug("quiet");
    });
  } finally {
    uninstallConsoleBridge();
    configureLog(prev);
  }
  const recs = lines.map((l) => JSON.parse(l));
  assert.deepEqual(recs.map((r) => r.level), ["info", "warn", "error", "debug"]);
  assert.equal(recs[0].module, "games");
  assert.equal(recs[0].msg, "hello");
  assert.equal(recs[0].reqId, "abcdefgh-1");
  assert.equal(recs[2].err.name, "RangeError");
  assert.ok(recs[2].err.stack.includes("RangeError: out"));
  assert.equal(typeof console.log, "function");
});

test("reqId: sane incoming ids are kept, anything else is replaced", () => {
  const uuid = "3f1c2a4e-9b7d-4c1e-8a2b-0d9e8f7a6b5c";
  assert.equal(requestId(uuid), uuid);
  assert.equal(requestId([uuid, "other"]), uuid);
  assert.equal(requestId("  abc12345  "), "abc12345");
  const UUID = /^[0-9a-f-]{36}$/;
  for (const bad of [undefined, "", "short", "x".repeat(129), "has space in it", "evil\ninjected-line", "<script>alert(1)</script>", "a\"b\"cdefgh"]) {
    const id = requestId(bad);
    assert.match(id, UUID, String(bad));
  }
  assert.notEqual(requestId(undefined), requestId(undefined));
});

test("access lines: health, static and uploads at debug, 5xx at warn", () => {
  assert.equal(accessLevel("/health", 200), "debug");
  assert.equal(accessLevel("/health/ready", 503), "warn");
  assert.equal(accessLevel("(static)", 200), "debug");
  assert.equal(accessLevel("/uploads/:name", 200), "debug");
  assert.equal(accessLevel("/api/games/:id/join", 200), "info");
  assert.equal(accessLevel("/api/games/:id/join", 500), "warn");
});

test("client error reports are bounded and stripped of queries and emails", () => {
  assert.equal(parseClientError(null), null);
  assert.equal(parseClientError({}), null);
  assert.equal(parseClientError({ message: "   " }), null);
  const r = parseClientError({
    message: "TypeError: x is undefined for jo@example.com",
    stack: "at render (http://h/app.js?v=2:10:5)\n".repeat(40),
    url: "http://h/games/abc?token=secret#frag",
    line: 10,
    col: -1,
    reqId: "3f1c2a4e-9b7d-4c1e-8a2b-0d9e8f7a6b5c",
    extra: "ignored",
  })!;
  assert.equal(r.message, "TypeError: x is undefined for [email]");
  assert.equal(r.url, "/games/abc");
  assert.equal(r.line, 10);
  assert.equal(r.col, undefined);
  assert.equal(r.reqId, "3f1c2a4e-9b7d-4c1e-8a2b-0d9e8f7a6b5c");
  assert.equal(r.stack!.split("\n").length, 20);
  assert.ok(!r.stack!.includes("?v=2"));
  assert.equal(parseClientError({ message: "m".repeat(2000) })!.message.length, 500);
  assert.equal(parseClientError({ message: "m", reqId: "bad id!" })!.reqId, undefined);
});

test("client key: user id, else peer, else the proxy's last forwarded hop", () => {
  const req = (remoteAddress: string, xff?: string) =>
    ({ socket: { remoteAddress }, headers: xff ? { "x-forwarded-for": xff } : {} }) as unknown as IncomingMessage;
  assert.equal(clientKey(req("1.2.3.4"), "u-1"), "user:u-1");
  assert.equal(clientKey(req("1.2.3.4", "9.9.9.9"), undefined), "ip:1.2.3.4");
  assert.equal(clientKey(req("127.0.0.1", "6.6.6.6, 5.5.5.5"), undefined), "ip:5.5.5.5");
  assert.equal(clientKey(req("172.18.0.3", "5.5.5.5"), undefined), "ip:5.5.5.5");
  assert.equal(clientKey(req("127.0.0.1"), undefined), "ip:127.0.0.1");
});
