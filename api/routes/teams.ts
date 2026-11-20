/**
 * Team routes: the list a person picks their team from (signup and the
 * profile editor). The pick itself is saved through PATCH /api/profile.
 *
 *   GET /api/teams?q=   matching teams, or the featured ones with no q
 */

import { authed, json } from "../http.js";
import { get } from "../router.js";
import { searchTeams } from "../teams/catalog.js";

get("/api/teams", authed(async ({ res, query }) => {
  json(res, 200, { ok: true, teams: searchTeams((query.get("q") ?? "").slice(0, 60)) });
}));
