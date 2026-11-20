/**
 * One fact about a player and a tryout:
 *
 *   invited   the club invited them to register (from a league season's
 *             standings, or one by one); `season` says which season
 *   consent   they agreed to show their verified record to the club's
 *             staff before registering; the scout board shows a record
 *             only with this
 *   camp      the club invited them to camp after the tryout
 */

import { Entity, ManyToOne, PrimaryKey, Property, Unique } from "@mikro-orm/core";
import { randomUUID } from "node:crypto";
import { User } from "../entities/User.js";
import { Season } from "../leagues/Season.js";
import { Tryout } from "./Tryout.js";

export type TryoutMarkKind = "invited" | "consent" | "camp";

@Entity({ tableName: "tryout_marks" })
@Unique({ properties: ["tryout", "user", "kind"] })
export class TryoutMark {
  @PrimaryKey({ type: "uuid" })
  id: string = randomUUID();

  @ManyToOne(() => Tryout, { deleteRule: "cascade" })
  tryout!: Tryout;

  @ManyToOne(() => User, { deleteRule: "cascade" })
  user!: User;

  @Property({ type: "string", length: 16 })
  kind!: TryoutMarkKind;

  @ManyToOne(() => Season, { nullable: true, deleteRule: "set null" })
  season?: Season | null;

  @ManyToOne(() => User, { nullable: true, deleteRule: "set null" })
  by?: User | null;

  @Property({ type: "timestamptz", onCreate: () => new Date() })
  createdAt: Date = new Date();
}
