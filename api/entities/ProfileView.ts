import { Entity, Index, ManyToOne, PrimaryKey, Property, Unique } from "@mikro-orm/core";
import { randomUUID } from "node:crypto";
import { User } from "./User.js";

/**
 * One row per viewer per profile per UTC day, so a refresh is not a view.
 * Who may be shown to the profile's owner is decided in discovery.ts, not
 * here: every view is recorded, few are ever named.
 */
@Entity({ tableName: "profile_views" })
@Unique({ properties: ["viewer", "viewed", "day"] })
@Index({ properties: ["viewed", "createdAt"] })
export class ProfileView {
  @PrimaryKey({ type: "uuid" })
  id: string = randomUUID();

  @ManyToOne(() => User, { deleteRule: "cascade" })
  viewer!: User;

  @ManyToOne(() => User, { deleteRule: "cascade" })
  viewed!: User;

  /** YYYY-MM-DD in UTC. */
  @Property({ type: "string", length: 10 })
  day!: string;

  @Property({ type: "timestamptz", onCreate: () => new Date() })
  createdAt: Date = new Date();
}
