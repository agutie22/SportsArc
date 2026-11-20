import { Entity, Index, ManyToOne, PrimaryKey, Property, Unique } from "@mikro-orm/core";
import { randomUUID } from "node:crypto";
import { School } from "./School.js";
import { User } from "./User.js";

/**
 * An athlete as some external source describes them. Deliberately NOT a User:
 * imported records are unclaimed until a real person proves the record is
 * theirs. That separation matters most for minors — we hold a
 * public stat line, not an account, and nobody is signed up by being scraped.
 */
@Entity({ tableName: "athlete_records" })
@Index({ properties: ["sport", "classYear"] })
@Index({ properties: ["school"] })
@Unique({ properties: ["source", "sourceId"] })
export class AthleteRecord {
  @PrimaryKey({ type: "uuid" })
  id: string = randomUUID();

  @Property({ type: "string", length: 32 })
  source!: string;

  /** Stable id within the source. Together with source, the upsert key. */
  @Property({ type: "string", length: 200 })
  sourceId!: string;

  @Property({ type: "string", length: 500, nullable: true })
  sourceUrl?: string | null;

  @Property({ type: "string", length: 160 })
  name!: string;

  @ManyToOne(() => School, { nullable: true, deleteRule: "set null" })
  school?: School | null;

  @Property({ type: "string", length: 24 })
  sport!: string;

  @Property({ type: "string", length: 32, nullable: true })
  position?: string | null;

  @Property({ type: "string", length: 16, nullable: true })
  classYear?: string | null;

  @Property({ type: "int", nullable: true })
  heightInches?: number | null;

  @Property({ type: "int", nullable: true })
  weightLbs?: number | null;

  /** Sport-specific stat line, kept as given so we never lose the original. */
  @Property({ type: "json", nullable: true })
  stats?: Record<string, number | string> | null;

  /** Set once a signed-in user proves this record describes them. */
  @ManyToOne(() => User, { nullable: true, deleteRule: "set null" })
  claimedBy?: User | null;

  @Property({ type: "timestamptz", nullable: true })
  claimedAt?: Date | null;

  @Property({ type: "timestamptz", onCreate: () => new Date() })
  firstSeenAt: Date = new Date();

  @Property({ type: "timestamptz", onCreate: () => new Date(), onUpdate: () => new Date() })
  lastSeenAt: Date = new Date();
}
