import { Entity, Index, PrimaryKey, Property, Unique } from "@mikro-orm/core";
import { randomUUID } from "node:crypto";

@Entity({ tableName: "schools" })
@Index({ properties: ["state"] })
@Unique({ properties: ["name", "state"] })
export class School {
  @PrimaryKey({ type: "uuid" })
  id: string = randomUUID();

  @Property({ type: "string", length: 200 })
  name!: string;

  @Property({ type: "string", length: 2, nullable: true })
  state?: string | null;

  @Property({ type: "string", length: 120, nullable: true })
  city?: string | null;

  /** Ids this school is known by upstream, e.g. { maxpreps: "..." }. */
  @Property({ type: "json", nullable: true })
  externalIds?: Record<string, string> | null;

  @Property({ type: "timestamptz", onCreate: () => new Date() })
  createdAt: Date = new Date();
}
