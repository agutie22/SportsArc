/**
 * Source adapters. Each one turns something external into AthleteInput rows;
 * the pipeline handles persistence, so adapters stay small and testable.
 *
 * On MaxPreps specifically — worth reading before adding a crawler:
 *
 *   MaxPreps (a CBS Sports property) disallows /school/, /team/, /scores/
 *   and /discovery/ for User-agent: * in robots.txt. Those are exactly the
 *   roster and stat pages. There is no public API. So the supported path is
 *   a licensed feed, and the adapter below requires one to be configured
 *   rather than quietly crawling. Every network fetch also goes through
 *   robots.ts, which will refuse a disallowed path even if someone points
 *   the config at one.
 *
 * The csv adapter needs no permission from anyone and is the path that works
 * today: coaches and athletic directors export a roster and upload it.
 */

import { checkUrl, MAX_CRAWL_WAIT_MS, USER_AGENT, waitTurn } from "./robots.js";

export interface AthleteInput {
  sourceId: string;
  sourceUrl?: string | null;
  name: string;
  sport: string;
  schoolName?: string | null;
  schoolState?: string | null;
  schoolCity?: string | null;
  position?: string | null;
  classYear?: string | null;
  heightInches?: number | null;
  weightLbs?: number | null;
  stats?: Record<string, number | string> | null;
}

export interface SourceResult {
  rows: AthleteInput[];
  problems: string[];
}

export interface Source {
  name: string;
  /** False when the source needs credentials that are not configured. */
  available(): boolean;
  unavailableReason?(): string;
  load(input: { text?: string; url?: string }): Promise<SourceResult>;
}

// ── csv ───────────────────────────────────────────────────────────────

/** RFC4180-ish: handles quoted fields, embedded commas, and "" escapes. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ",") { row.push(field); field = ""; continue; }
    if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
      continue;
    }
    field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/[\s_-]+/g, "");

const HEADER_ALIASES: Record<string, string> = {
  name: "name", athlete: "name", player: "name", fullname: "name",
  sport: "sport",
  school: "schoolName", schoolname: "schoolName", team: "schoolName",
  state: "schoolState", city: "schoolCity",
  position: "position", pos: "position",
  classyear: "classYear", class: "classYear", grad: "classYear", gradyear: "classYear",
  height: "heightInches", heightinches: "heightInches", heightin: "heightInches",
  weight: "weightLbs", weightlbs: "weightLbs", weightlb: "weightLbs",
  id: "sourceId", sourceid: "sourceId", externalid: "sourceId",
  url: "sourceUrl", sourceurl: "sourceUrl", profile: "sourceUrl",
};

/** `6'2"` or `74` or `6-2` -> inches. */
function parseHeight(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  const ft = s.match(/^(\d)\s*(?:'|ft|-)\s*(\d{1,2})?/i);
  if (ft) {
    const inches = Number(ft[1]) * 12 + Number(ft[2] ?? 0);
    return inches >= 36 && inches <= 96 ? inches : null;
  }
  const n = Number(s.replace(/[^\d.]/g, ""));
  return Number.isFinite(n) && n >= 36 && n <= 96 ? Math.round(n) : null;
}

const csvSource: Source = {
  name: "csv",
  available: () => true,
  async load({ text }) {
    const problems: string[] = [];
    const rows: AthleteInput[] = [];
    if (!text || !text.trim()) return { rows, problems: ["File was empty."] };

    const table = parseCsv(text);
    if (table.length < 2) return { rows, problems: ["Needs a header row and at least one data row."] };

    const header = table[0].map((h) => HEADER_ALIASES[norm(h)] ?? norm(h));
    const known = new Set(Object.values(HEADER_ALIASES));

    for (let r = 1; r < table.length; r++) {
      const cells = table[r];
      const rec: Record<string, string> = {};
      const stats: Record<string, number | string> = {};
      header.forEach((key, i) => {
        const v = (cells[i] ?? "").trim();
        if (!v) return;
        if (known.has(key)) rec[key] = v;
        // Unrecognised columns become the stat line rather than being dropped.
        else stats[key] = Number.isFinite(Number(v)) ? Number(v) : v;
      });

      if (!rec.name) { problems.push(`Row ${r + 1}: no name, skipped.`); continue; }
      if (!rec.sport) { problems.push(`Row ${r + 1}: no sport, skipped.`); continue; }

      const weight = rec.weightLbs ? Number(rec.weightLbs.replace(/[^\d.]/g, "")) : NaN;
      rows.push({
        sourceId: rec.sourceId || `${norm(rec.name)}|${norm(rec.schoolName ?? "")}|${norm(rec.sport)}`,
        sourceUrl: rec.sourceUrl ?? null,
        name: rec.name.slice(0, 160),
        sport: rec.sport.toLowerCase().slice(0, 24),
        schoolName: rec.schoolName?.slice(0, 200) ?? null,
        schoolState: rec.schoolState?.slice(0, 2).toUpperCase() ?? null,
        schoolCity: rec.schoolCity?.slice(0, 120) ?? null,
        position: rec.position?.slice(0, 32) ?? null,
        classYear: rec.classYear?.slice(0, 16) ?? null,
        heightInches: rec.heightInches ? parseHeight(rec.heightInches) : null,
        weightLbs: Number.isFinite(weight) && weight >= 50 && weight <= 500 ? Math.round(weight) : null,
        stats: Object.keys(stats).length ? stats : null,
      });
    }
    return { rows, problems: problems.slice(0, 50) };
  },
};

// ── maxpreps ──────────────────────────────────────────────────────────

const MAXPREPS_FEED_URL = () => process.env.MAXPREPS_FEED_URL?.trim() ?? "";
const MAXPREPS_API_KEY = () => process.env.MAXPREPS_API_KEY?.trim() ?? "";

/**
 * Reads a licensed MaxPreps feed. Refuses to run without one, and refuses
 * any URL robots.txt disallows even when configured.
 *
 * The expected feed shape is a JSON array of athlete objects; map fields in
 * `mapFeedRow` once the real contract is known, since licensed feeds differ.
 */
const maxprepsSource: Source = {
  name: "maxpreps",
  available: () => Boolean(MAXPREPS_FEED_URL() && MAXPREPS_API_KEY()),
  unavailableReason: () =>
    "MaxPreps needs a licensed feed. Their robots.txt disallows /school/, /team/ " +
    "and /scores/ for all crawlers and there is no public API, so set " +
    "MAXPREPS_FEED_URL and MAXPREPS_API_KEY from a data agreement with CBS Sports.",

  async load({ url }) {
    const target = url?.trim() || MAXPREPS_FEED_URL();
    if (!target) {
      return { rows: [], problems: [maxprepsSource.unavailableReason!()] };
    }

    const check = await checkUrl(target);
    if (!check.allowed) {
      return { rows: [], problems: [`Refusing to fetch: ${check.reason}`] };
    }
    if (!(await waitTurn(target, check.crawlDelayMs))) {
      return { rows: [], problems: [`Refusing to fetch: the site's Crawl-delay would mean waiting over ${MAX_CRAWL_WAIT_MS / 1000}s. Try again later.`] };
    }

    const res = await fetch(target, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
        ...(MAXPREPS_API_KEY() ? { Authorization: `Bearer ${MAXPREPS_API_KEY()}` } : {}),
      },
    });
    if (!res.ok) {
      return { rows: [], problems: [`Feed responded ${res.status}.`] };
    }

    const payload: unknown = await res.json();
    const list = Array.isArray(payload)
      ? payload
      : Array.isArray((payload as { athletes?: unknown })?.athletes)
        ? (payload as { athletes: unknown[] }).athletes
        : [];
    if (list.length === 0) {
      return { rows: [], problems: ["Feed returned no athletes."] };
    }

    const problems: string[] = [];
    const rows: AthleteInput[] = [];
    list.forEach((raw, i) => {
      const mapped = mapFeedRow(raw, i);
      if (typeof mapped === "string") problems.push(mapped);
      else rows.push(mapped);
    });
    return { rows, problems: problems.slice(0, 50) };
  },
};

function mapFeedRow(raw: unknown, i: number): AthleteInput | string {
  if (!raw || typeof raw !== "object") return `Row ${i + 1}: not an object.`;
  const r = raw as Record<string, unknown>;
  const s = (k: string): string | null => (typeof r[k] === "string" ? (r[k] as string).trim() || null : null);
  const n = (k: string): number | null => {
    const v = typeof r[k] === "number" ? r[k] : Number(r[k]);
    return Number.isFinite(v) ? (v as number) : null;
  };

  const name = s("name") ?? s("fullName") ?? s("athleteName");
  const sport = (s("sport") ?? "").toLowerCase();
  if (!name) return `Row ${i + 1}: no name.`;
  if (!sport) return `Row ${i + 1}: no sport.`;

  const id = s("id") ?? s("athleteId") ?? s("careerId");
  return {
    sourceId: id ?? `${norm(name)}|${norm(s("school") ?? "")}|${norm(sport)}`,
    sourceUrl: s("url") ?? s("profileUrl"),
    name: name.slice(0, 160),
    sport: sport.slice(0, 24),
    schoolName: s("school") ?? s("schoolName"),
    schoolState: s("state")?.slice(0, 2).toUpperCase() ?? null,
    schoolCity: s("city"),
    position: s("position") ?? s("pos"),
    classYear: s("classYear") ?? s("gradYear"),
    heightInches: s("height") ? parseHeight(s("height")!) : n("heightInches"),
    weightLbs: n("weight") ?? n("weightLbs"),
    stats: (r.stats && typeof r.stats === "object")
      ? (r.stats as Record<string, number | string>)
      : null,
  };
}

export const SOURCES: Record<string, Source> = {
  csv: csvSource,
  maxpreps: maxprepsSource,
};
