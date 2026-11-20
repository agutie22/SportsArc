/**
 * Request dispatch: the route table, then the static frontend, then 404/405.
 * Importing this binds no port, so a test can serve it directly.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { errorJson, json } from "./http.js";
import { ROUTE_OPTIONS, ROUTE_STATIC, ROUTE_UNMATCHED, setRoute } from "./ops/request-context.js";
import { match, pathExists } from "./router.js";
import "./routes/index.js";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const FRONTEND = join(ROOT, "frontend");

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

async function serveStatic(res: ServerResponse, urlPath: string): Promise<void> {
  // Collapse leading slashes first: "//x" would otherwise parse as a
  // protocol-relative URL and throw, or resolve against a foreign host.
  const raw = "/" + urlPath.replace(/^\/+/, "");
  let pathname: string;
  try {
    pathname = new URL(raw, "http://127.0.0.1").pathname.replace(/\.\./g, "") || "/";
  } catch {
    pathname = "/";
  }
  const relative =
    pathname === "/" || pathname === "" ? "index.html" : pathname.replace(/^\/+/, "");
  const fullPath = join(FRONTEND, relative);
  const mime = MIME[extname(fullPath)] ?? "application/octet-stream";

  try {
    const data = await readFile(fullPath);
    res.writeHead(200, {
      "Content-Type": mime,
      "Content-Length": data.length,
      // The frontend is served straight from disk with no build step or
      // content hashing, so a heuristically cached module can be paired with
      // a fresh index.html. One missing element then throws at module load
      // and takes the whole app down. Revalidate every time.
      "Cache-Control": "no-cache, must-revalidate",
    });
    res.end(data);
  } catch {
    json(res, 404, {
      ok: false,
      error: { code: "NOT_FOUND", message: `${pathname} not found.` },
    });
  }
}

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";
  const qIdx = url.indexOf("?");
  const pathname = qIdx >= 0 ? url.slice(0, qIdx) : url;
  const query = new URLSearchParams(qIdx >= 0 ? url.slice(qIdx + 1) : "");

  if (method === "OPTIONS") {
    setRoute(ROUTE_OPTIONS);
    res.writeHead(204, {
      "Access-Control-Allow-Methods": "POST, GET, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  const hit = match(method, pathname);
  if (hit) {
    setRoute(hit.pattern);
    await hit.handler({ req, res, params: hit.params, query });
    return;
  }

  if (method === "GET" && !pathname.startsWith("/api/")) {
    setRoute(ROUTE_STATIC);
    await serveStatic(res, url);
    return;
  }

  setRoute(ROUTE_UNMATCHED);
  if (pathExists(pathname)) {
    errorJson(res, 405, "METHOD_NOT_ALLOWED", `${method} not allowed on ${pathname}.`);
    return;
  }

  errorJson(res, 404, "NOT_FOUND", `${method} ${url} not found.`);
}
