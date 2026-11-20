/**
 * Data ingestion and athlete records. Any signed-in user can run an import;
 * there is no admin role on these yet.
 */

import { em } from "../db.js";
import { authed, json, parseJsonBody } from "../http.js";
import { claimAthleteRecord, listRuns, runImport, searchAthleteRecords } from "../ingest/pipeline.js";
import { SOURCES } from "../ingest/sources.js";
import { get, post } from "../router.js";
import { gameStatus } from "./status.js";

get("/api/ingest/sources", ({ res }) => {
  json(res, 200, {
    ok: true,
    sources: Object.values(SOURCES).map((s) => ({
      name: s.name,
      available: s.available(),
      reason: s.available() ? null : (s.unavailableReason?.() ?? null),
    })),
  });
});

get("/api/ingest/runs", authed(async ({ res }, { fork }) => {
  json(res, 200, { ok: true, runs: await listRuns(fork) });
}));

post("/api/ingest/:source", authed(async ({ req, res, params }, { fork }) => {
  const body = await parseJsonBody<{ text?: string; url?: string }>(req, res);
  if (body === null) return;
  const result = await runImport(fork, params.source, {
    text: typeof body.text === "string" ? body.text : undefined,
    url: typeof body.url === "string" ? body.url : undefined,
  });
  if (!result.ok) {
    json(res, gameStatus(result), result);
    return;
  }
  json(res, 200, { ok: true, summary: result.summary });
}));

get("/api/athletes", async ({ res, query }) => {
  json(res, 200, {
    ok: true,
    athletes: await searchAthleteRecords(em(), {
      q: query.get("q") ?? undefined,
      sport: query.get("sport") ?? undefined,
      state: query.get("state") ?? undefined,
      limit: query.get("limit") ?? undefined,
    }),
  });
});

post("/api/athletes/:id/claim", authed(async ({ res, params }, { user, fork }) => {
  const result = await claimAthleteRecord(fork, user, params.id);
  json(res, gameStatus(result), result);
}));
