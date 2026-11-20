/**
 * A player on a team. One team per season per player (leagues.ts checks).
 */

import { Entity, ManyToOne, PrimaryKey, Property, Unique } from "@mikro-orm/core";
import { randomUUID } from "node:crypto";
import { User } from "../entities/User.js";
import { Team } from "./Team.js";

@Entity({ tableName: "team_members" })
@Unique({ properties: ["team", "user"] })
export class TeamMember {
  @PrimaryKey({ type: "uuid" })
  id: string = randomUUID();

  @ManyToOne(() => Team, { deleteRule: "cascade" })
  team!: Team;

  @ManyToOne(() => User, { deleteRule: "cascade" })
  user!: User;

  @ManyToOne(() => User, { nullable: true, deleteRule: "set null" })
  addedBy?: User | null;

  @Property({ type: "timestamptz", onCreate: () => new Date() })
  createdAt: Date = new Date();
}
