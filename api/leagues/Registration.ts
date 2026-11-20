/**
 * Signing up for a season. A captain registering a team is placed at once
 * (kind "team", with the team they made); a player signing up alone waits
 * for staff to place them on a team (kind "individual").
 */

import { Entity, ManyToOne, PrimaryKey, Property, Unique } from "@mikro-orm/core";
import { randomUUID } from "node:crypto";
import { User } from "../entities/User.js";
import { Season } from "./Season.js";
import { Team } from "./Team.js";

export type RegistrationKind = "team" | "individual";
export type RegistrationStatus = "waiting" | "placed" | "withdrawn";

@Entity({ tableName: "registrations" })
@Unique({ properties: ["season", "user"] })
export class Registration {
  @PrimaryKey({ type: "uuid" })
  id: string = randomUUID();

  @ManyToOne(() => Season, { deleteRule: "cascade" })
  season!: Season;

  @ManyToOne(() => User, { deleteRule: "cascade" })
  user!: User;

  @Property({ type: "string", length: 16 })
  kind!: RegistrationKind;

  @ManyToOne(() => Team, { nullable: true, deleteRule: "set null" })
  team?: Team | null;

  /** What a free agent tells staff ("guard, Tuesdays only"). */
  @Property({ type: "string", length: 200, nullable: true })
  note?: string | null;

  @Property({ type: "string", length: 16 })
  status: RegistrationStatus = "waiting";

  @Property({ type: "timestamptz", onCreate: () => new Date() })
  createdAt: Date = new Date();
}
