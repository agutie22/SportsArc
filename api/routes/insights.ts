/**
 * Insights (api/insights/): the public map of where people play, and a
 * sponsor org's own insights for its staff, as JSON or CSV (/insights/csv).
 */

import { em } from "../db.js";
import { authed, json } from "../http.js";
import { get } from "../router.js";
import { mapActivity } from "../insights/map.js";
import { insightsCsv, orgInsights } from "../insights/org.js";
import { leagueStatus } from "./status.js";

// Public: counts only (insights/map.ts says what is withheld).
get("/api/insights/map", async ({ res, query }) => {
  json(res, 200, { ok: true, ...(await mapActivity(em(), { sport: query.get("sport"), weeks: query.get("weeks") })) });
});

get("/api/orgs/:id/insights", authed(async ({ res, params, query }, { user, fork }) => {
  const result = await orgInsights(fork, user, params.id, { weeks: query.get("weeks") });
  json(res, leagueStatus(result), result);
}));

get("/api/orgs/:id/insights/csv", authed(async ({ res, params, query }, { user, fork }) => {
  const result = await orgInsights(fork, user, params.id, { weeks: query.get("weeks") });
  if (!result.ok) {
    json(res, leagueStatus(result), result);
    return;
  }
  const table = query.get("table") === "funnel" ? "funnel" : "courts";
  res.writeHead(200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${result.insights.org.slug}-${table}-${result.insights.weeks.length}w.csv"`,
    "Cache-Control": "no-store",
  });
  res.end(insightsCsv(result.insights, table));
}));
