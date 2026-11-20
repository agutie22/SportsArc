/**
 * Image uploads and serving them back.
 */

import { authed, errorJson, json } from "../http.js";
import { get, post } from "../router.js";
import { readUpload, saveUpload } from "../social/uploads.js";
import { gameStatus } from "./status.js";

// Raw image bytes in the body, not multipart: one file per request keeps
// the parser to a size-capped read and a magic-byte check.
post("/api/uploads", authed(async ({ req, res }) => {
  const result = await saveUpload(req);
  json(res, result.ok ? 201 : gameStatus(result), result);
}));

get("/uploads/:name", async ({ res, params }) => {
  const file = await readUpload(params.name);
  if (!file) {
    errorJson(res, 404, "NOT_FOUND", "No such file.");
    return;
  }
  res.writeHead(200, {
    "Content-Type": file.mime,
    "Content-Length": file.data.length,
    // Names are random uuids and never reused, so the bytes cannot change.
    "Cache-Control": "public, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(file.data);
});
