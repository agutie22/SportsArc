/**
 * Pulls college football team colors and logos from ESPN once and writes
 * api/teams/cfb-teams.json, which the app serves (api/teams/catalog.ts).
 * The endpoint is ESPN's public, undocumented site API, so it is read here
 * and committed rather than called while the app runs.
 *
 *   node --import=tsx scripts/cfb-teams.ts
 *
 * Teams ESPN lists with no color, or plain black and no second color, are
 * left out: that is a missing value, not a team's colors.
 */

import { writeFileSync } from "node:fs";

const URL_TEAMS = "https://site.api.espn.com/apis/site/v2/sports/football/college-football/teams?limit=1000";
const OUT = new URL("../api/teams/cfb-teams.json", import.meta.url);

const hex = (v: unknown): string | null =>
  typeof v === "string" && /^[0-9a-f]{6}$/i.test(v) ? `#${v.toLowerCase()}` : null;

const res = await fetch(URL_TEAMS);
if (!res.ok) throw new Error(`ESPN answered ${res.status}`);
const body = await res.json() as any;
const raw: any[] = body?.sports?.[0]?.leagues?.[0]?.teams?.map((t: any) => t.team) ?? [];

const teams = raw.flatMap((t) => {
  const color = hex(t.color);
  const alt = hex(t.alternateColor);
  if (!color || (color === "#000000" && !alt)) return [];
  return [{
    key: `cfb:${t.id}`,
    name: String(t.displayName),
    school: String(t.location),
    mascot: String(t.name ?? ""),
    abbr: String(t.abbreviation ?? ""),
    color,
    alt,
    logo: typeof t.logos?.[0]?.href === "string" ? t.logos[0].href : null,
  }];
}).sort((a, b) => a.name.localeCompare(b.name));

writeFileSync(OUT, JSON.stringify({ source: "espn", fetchedAt: new Date().toISOString(), teams }, null, 0) + "\n");
console.log(`[cfb-teams] wrote ${teams.length} of ${raw.length} teams`);
