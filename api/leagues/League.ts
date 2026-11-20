/**
 * A league an organization runs (kind "league"), e.g. "I-35 3v3". It holds
 * seasons; each season holds teams and fixtures (leagues.ts).
 */

import { Entity, ManyToOne, PrimaryKey, Property } from "@mikro-orm/core";
import { randomUUID } from "node:crypto";
import { Organization } from "../orgs/Organization.js";

@Entity({ tableName: "leagues" })
export class League {
  @PrimaryKey({ type: "uuid" })
  id: string = randomUUID();

  @ManyToOne(() => Organization, { deleteRule: "cascade" })
  org!: Organization;

  @Property({ type: "string", length: 120 })
  name!: string;

  /** One of SPORTS (entities/Game.ts). */
  @Property({ type: "string", length: 24 })
  sport!: string;

  /** Free text shown beside the name, e.g. "3v3 half court". */
  @Property({ type: "string", length: 40, nullable: true })
  format?: string | null;

  @Property({ type: "timestamptz", onCreate: () => new Date() })
  createdAt: Date = new Date();
}
