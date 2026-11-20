/**
 * Browser error reports (frontend/errors.js).
 */

import { em } from "../db.js";
import { errorJson, json } from "../http.js";
import { log } from "../ops/log.js";
import {
  CLIENT_ERROR_MAX_BYTES,
  clientErrorRateLimited,
  clientKey,
  logClientError,
  parseClientError,
  readCappedBody,
} from "../ops/request-context.js";
import { post } from "../router.js";
import { readSession } from "../auth/session.js";

/**
 * One report per call: { message, stack, url (path only), line, col, reqId }.
 * Body capped at CLIENT_ERROR_MAX_BYTES; limited per user (or IP when signed
 * out) through rate_limit_hits; logged at level error with source "client".
 */
post("/api/client-errors", async ({ req, res }) => {
  const raw = await readCappedBody(req, CLIENT_ERROR_MAX_BYTES);
  if (raw === null) {
    errorJson(res, 413, "TOO_LARGE", "Error report is too large.");
    return;
  }
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    errorJson(res, 400, "INVALID_JSON", "Request body must be valid JSON.");
    return;
  }
  const report = parseClientError(parsed);
  if (!report) {
    errorJson(res, 400, "VALIDATION_ERROR", "An error report needs a message.");
    return;
  }
  const userId = readSession(req)?.userId;
  if (await clientErrorRateLimited(em(), clientKey(req, userId))) {
    log.debug("client error report dropped: rate limited", { userId });
    errorJson(res, 429, "RATE_LIMITED", "Too many error reports.");
    return;
  }
  logClientError(report, userId);
  json(res, 202, { ok: true });
});
