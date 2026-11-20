/**
 * Browser error reporting. Uncaught errors, unhandled promise rejections
 * and API responses with status >= 500 (reported by api.js) are POSTed to
 * /api/client-errors, where the server logs them with source "client".
 *
 * Each distinct error is sent once per page load, and at most MAX_REPORTS
 * in all, so a render loop that throws cannot flood the server. Only the
 * page path is sent (no query string or hash, which can carry ids or
 * tokens). Reporting never throws and never reports its own failures.
 */

const ENDPOINT = "/api/client-errors";
const MAX_REPORTS = 5;
const MAX_STACK = 4000;

const seen = new Set();
let sent = 0;

function trimStack(stack) {
  if (typeof stack !== "string") return undefined;
  return stack.split("\n").slice(0, 20).join("\n").slice(0, MAX_STACK);
}

/**
 * Report one error. `info`: { message, stack, line, col, reqId }.
 * Returns true when a report was sent.
 */
function reportError(info) {
  try {
    const message = String(info?.message ?? "").slice(0, 500);
    // "Script error." is a cross-origin error with every detail hidden.
    if (!message || message === "Script error.") return false;
    const key = `${message}|${info.line ?? ""}|${info.col ?? ""}`;
    if (seen.has(key) || sent >= MAX_REPORTS) return false;
    seen.add(key);
    sent += 1;
    const body = JSON.stringify({
      message,
      stack: trimStack(info.stack),
      url: location.pathname,
      line: Number.isInteger(info.line) ? info.line : undefined,
      col: Number.isInteger(info.col) ? info.col : undefined,
      reqId: typeof info.reqId === "string" ? info.reqId : undefined,
    });
    fetch(ENDPOINT, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

/** A failed API call (status >= 500), from the shared client in api.js. */
export function reportApiFailure(path, status, reqId, code) {
  const route = String(path ?? "").split("?")[0];
  reportError({
    message: `API ${status} ${route}${code ? ` ${code}` : ""}`,
    reqId,
  });
}

window.addEventListener("error", (e) => {
  // Resource load failures (img, script) reach here too, without a message.
  if (!e.message && !e.error) return;
  reportError({
    message: e.error?.message ? `${e.error.name ?? "Error"}: ${e.error.message}` : e.message,
    stack: e.error?.stack,
    line: e.lineno,
    col: e.colno,
  });
});

window.addEventListener("unhandledrejection", (e) => {
  const r = e.reason;
  // An API 5xx the shared client already reported.
  if (r?.reported) return;
  reportError({
    message: r instanceof Error ? `Unhandled rejection: ${r.name}: ${r.message}` : `Unhandled rejection: ${String(r)}`,
    stack: r instanceof Error ? r.stack : undefined,
  });
});
