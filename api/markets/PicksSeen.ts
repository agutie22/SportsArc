/**
 * When a user last looked at their settled picks: "Needs you" on Your picks
 * lists picks settled after this, until they mark them seen. One row a user.
 */

import { Entity, OneToOne, PrimaryKey, Property } from "@mikro-orm/core";
import { randomUUID } from "node:crypto";
import { User } from "../entities/User.js";

@Entity({ tableName: "picks_seen" })
export class PicksSeen {
  @PrimaryKey({ type: "uuid" })
  id: string = randomUUID();

  @OneToOne(() => User, { owner: true, deleteRule: "cascade", unique: true })
  user!: User;

  @Property({ type: "timestamptz" })
  seenAt!: Date;

  @Property({ type: "timestamptz", onUpdate: () => new Date() })
  updatedAt: Date = new Date();
}
