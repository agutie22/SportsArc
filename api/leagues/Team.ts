/**
 * A team in one season, with a captain and a join code: anyone with the
 * link (#/join/<code>) can claim a spot while the roster has room.
 */

import { Entity, ManyToOne, PrimaryKey, Property, Unique } from "@mikro-orm/core";
import { randomUUID } from "node:crypto";
import { User } from "../entities/User.js";
import { Season } from "./Season.js";

@Entity({ tableName: "teams" })
@Unique({ properties: ["season", "name"] })
export class Team {
  @PrimaryKey({ type: "uuid" })
  id: string = randomUUID();

  @ManyToOne(() => Season, { deleteRule: "cascade" })
  season!: Season;

  @Property({ type: "string", length: 60 })
  name!: string;

  @ManyToOne(() => User, { nullable: true, deleteRule: "set null" })
  captain?: User | null;

  /** The join link's secret. Shown only to the captain and the org's staff. */
  @Unique()
  @Property({ type: "string", length: 24 })
  joinCode!: string;

  @ManyToOne(() => User, { nullable: true, deleteRule: "set null" })
  createdBy?: User | null;

  @Property({ type: "timestamptz", onCreate: () => new Date() })
  createdAt: Date = new Date();
}
