/**
 * Ingestion pipeline: source -> normalise -> upsert -> run record.
 *
 * Upserts are keyed on (source, sourceId), so re-running an import updates
 * rather than duplicates. Imported athletes are AthleteRecords, never Users:
 * nobody gets an account because their stat line was published somewhere.
 * A real person can later claim the record.
 */

import type { EntityManager } from "@mikro-orm/postgresql";
import { AthleteRecord } from "../entities/AthleteRecord.js";
import { ImportRun } from "../entities/ImportRun.js";
import { School } from "../entities/School.js";
import { User } from "../entities/User.js";
import { SOURCES, type AthleteInput } from "./sources.js";
import { fail, type Failure } from "../failure.js";

const MAX_ROWS = 5000;

async function upsertSchool(
  em: EntityManager,
  cache: Map<string, School>,
  row: AthleteInput,
  source: string,
): Promise<School | null> {
  const name = row.schoolName?.trim();
  if (!name) return null;
  const state = row.schoolState?.trim() || null;
  const key = `${name.toLowerCase()}|${(state ?? "").toLowerCase()}`;
  const hit = cache.get(key);
  if (hit) return hit;

  let school = await em.findOne(School, { name, state });
  if (!school) {
    school = new School();
    school.name = name.slice(0, 200);
    school.state = state;
    school.city = row.schoolCity?.slice(0, 120) ?? null;
    em.persist(school);
  } else if (!school.city && row.schoolCity) {
    school.city = row.schoolCity.slice(0, 120);
  }
  if (row.sourceUrl) {
    school.externalIds = { ...(school.externalIds ?? {}), [source]: row.sourceId };
  }
  cache.set(key, school);
  return school;
}

export interface ImportSummary {
  runId: string;
  source: string;
  created: number;
  updated: number;
  skipped: number;
  problems: string[];
}

export async function runImport(
  em: EntityManager,
  sourceName: string,
  input: { text?: string; url?: string },
): Promise<{ ok: true; summary: ImportSummary } | Failure> {
  const source = SOURCES[sourceName];
  if (!source) return fail("UNKNOWN_SOURCE", `No source named "${sourceName}".`);
  if (!source.available()) {
    return fail("SOURCE_UNAVAILABLE", source.unavailableReason?.() ?? "Source is not configured.");
  }

  const run = new ImportRun();
  run.source = sourceName;
  await em.persistAndFlush(run);

  try {
    const { rows, problems } = await source.load(input);
    if (rows.length === 0) {
      run.status = "failed";
      run.error = problems[0] ?? "Source produced no rows.";
      run.problems = problems.slice(0, 50);
      run.finishedAt = new Date();
      await em.flush();
      return fail("NO_ROWS", run.error);
    }
    if (rows.length > MAX_ROWS) {
      run.status = "failed";
      run.error = `Import is limited to ${MAX_ROWS} rows (got ${rows.length}).`;
      run.finishedAt = new Date();
      await em.flush();
      return fail("TOO_MANY_ROWS", run.error);
    }

    const schools = new Map<string, School>();
    for (const row of rows) {
      const school = await upsertSchool(em, schools, row, sourceName);
      let rec = await em.findOne(AthleteRecord, { source: sourceName, sourceId: row.sourceId });

      if (!rec) {
        rec = new AthleteRecord();
        rec.source = sourceName;
        rec.sourceId = row.sourceId.slice(0, 200);
        em.persist(rec);
        run.created += 1;
      } else {
        run.updated += 1;
      }

      rec.name = row.name;
      rec.sport = row.sport;
      rec.school = school;
      rec.position = row.position ?? null;
      rec.classYear = row.classYear ?? null;
      rec.heightInches = row.heightInches ?? null;
      rec.weightLbs = row.weightLbs ?? null;
      rec.stats = row.stats ?? null;
      rec.sourceUrl = row.sourceUrl ?? null;
      rec.lastSeenAt = new Date();
    }

    run.skipped = problems.length;
    run.problems = problems.slice(0, 50);
    run.status = "ok";
    run.finishedAt = new Date();
    await em.flush();

    return {
      ok: true,
      summary: {
        runId: run.id,
        source: sourceName,
        created: run.created,
        updated: run.updated,
        skipped: run.skipped,
        problems: run.problems ?? [],
      },
    };
  } catch (err) {
    run.status = "failed";
    run.error = err instanceof Error ? err.message : String(err);
    run.finishedAt = new Date();
    await em.flush();
    return fail("IMPORT_FAILED", run.error);
  }
}

export async function listRuns(em: EntityManager, limit = 20) {
  const runs = await em.find(ImportRun, {}, { orderBy: { startedAt: "DESC" }, limit });
  return runs.map((r) => ({
    id: r.id,
    source: r.source,
    status: r.status,
    created: r.created,
    updated: r.updated,
    skipped: r.skipped,
    problems: r.problems ?? [],
    error: r.error ?? null,
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
  }));
}

export async function searchAthleteRecords(
  em: EntityManager,
  opts: { q?: unknown; sport?: unknown; state?: unknown; limit?: unknown },
) {
  const where: Record<string, unknown> = {};
  const q = typeof opts.q === "string" ? opts.q.trim() : "";
  if (q) where.name = { $ilike: `%${q}%` };
  const sport = typeof opts.sport === "string" ? opts.sport.trim().toLowerCase() : "";
  if (sport) where.sport = sport;

  const records = await em.find(AthleteRecord, where, {
    populate: ["school", "claimedBy"],
    orderBy: { lastSeenAt: "DESC" },
    limit: Math.min(Math.trunc(Number(opts.limit) || 50), 100),
  });

  const state = typeof opts.state === "string" ? opts.state.trim().toUpperCase() : "";
  return records
    .filter((r) => !state || r.school?.state === state)
    .map((r) => ({
      id: r.id,
      name: r.name,
      sport: r.sport,
      position: r.position,
      classYear: r.classYear,
      heightInches: r.heightInches,
      weightLbs: r.weightLbs,
      stats: r.stats ?? {},
      school: r.school ? { id: r.school.id, name: r.school.name, state: r.school.state } : null,
      source: r.source,
      sourceUrl: r.sourceUrl,
      claimed: Boolean(r.claimedBy),
    }));
}

/**
 * Claim an imported record as your own. Deliberately self-service and
 * unverified for now — it links a stat line to an account, nothing more.
 * Before this affects rankings it needs real verification.
 */
export async function claimAthleteRecord(
  em: EntityManager,
  user: User,
  recordId: string,
): Promise<{ ok: true } | Failure> {
  const rec = await em.findOne(AthleteRecord, { id: recordId }, { populate: ["claimedBy"] });
  if (!rec) return fail("RECORD_NOT_FOUND", "That record does not exist.");
  if (rec.claimedBy && rec.claimedBy.id !== user.id) {
    return fail("ALREADY_CLAIMED", "Someone has already claimed that record.");
  }
  rec.claimedBy = user;
  rec.claimedAt = new Date();
  await em.flush();
  return { ok: true };
}
