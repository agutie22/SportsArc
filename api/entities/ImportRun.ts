import { Entity, Index, PrimaryKey, Property } from "@mikro-orm/core";
import { randomUUID } from "node:crypto";

export const IMPORT_STATUSES = ["running", "ok", "failed"] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

@Entity({ tableName: "import_runs" })
@Index({ properties: ["source", "startedAt"] })
export class ImportRun {
  @PrimaryKey({ type: "uuid" })
  id: string = randomUUID();

  @Property({ type: "string", length: 32 })
  source!: string;

  @Property({ type: "string", length: 16 })
  status: ImportStatus = "running";

  @Property({ type: "int" })
  created: number = 0;

  @Property({ type: "int" })
  updated: number = 0;

  @Property({ type: "int" })
  skipped: number = 0;

  /** Per-row problems, capped so one bad file cannot bloat the table. */
  @Property({ type: "json", nullable: true })
  problems?: string[] | null;

  @Property({ type: "text", nullable: true })
  error?: string | null;

  @Property({ type: "timestamptz", onCreate: () => new Date() })
  startedAt: Date = new Date();

  @Property({ type: "timestamptz", nullable: true })
  finishedAt?: Date | null;
}
