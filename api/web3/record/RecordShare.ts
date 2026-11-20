/**
 * A player's link to their verified record. One per player: the token in it
 * is the whole secret, so whoever holds the link can read that player's
 * verified games (record.ts). Deleting the row turns the link off; making a
 * new one gives a new token.
 */

import { Entity, ManyToOne, PrimaryKey, Property, Unique } from "@mikro-orm/core";
import { randomUUID } from "node:crypto";
import { User } from "../../entities/User.js";

@Entity({ tableName: "record_shares" })
@Unique({ properties: ["user"] })
export class RecordShare {
  @PrimaryKey({ type: "uuid" })
  id: string = randomUUID();

  @ManyToOne(() => User, { deleteRule: "cascade" })
  user!: User;

  /** 32 random bytes, base64url. */
  @Unique()
  @Property({ type: "string", length: 43 })
  token!: string;

  @Property({ type: "timestamptz", onCreate: () => new Date() })
  createdAt: Date = new Date();
}
