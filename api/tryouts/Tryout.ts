/**
 * A club's tryout (tryouts.ts): an ordinary paid event (kind "event") the
 * club's signer hosts, so its entry fees go to the club's wallet, plus what
 * a tryout adds: who was invited to register, who agreed to show their
 * record to the club's staff, and who the club invites to camp.
 */

import { Entity, ManyToOne, PrimaryKey, Property, Unique } from "@mikro-orm/core";
import { randomUUID } from "node:crypto";
import { Game } from "../entities/Game.js";
import { User } from "../entities/User.js";
import { Organization } from "../orgs/Organization.js";

@Entity({ tableName: "tryouts" })
export class Tryout {
  @PrimaryKey({ type: "uuid" })
  id: string = randomUUID();

  @ManyToOne(() => Organization, { deleteRule: "cascade" })
  org!: Organization;

  /** The paid event players register for and check in to. */
  @Unique()
  @ManyToOne(() => Game, { deleteRule: "cascade" })
  game!: Game;

  @Property({ type: "string", length: 120 })
  name!: string;

  /** How many the club invites to camp afterwards. */
  @Property({ type: "smallint" })
  campSpots: number = 3;

  @ManyToOne(() => User, { nullable: true, deleteRule: "set null" })
  createdBy?: User | null;

  @Property({ type: "timestamptz", onCreate: () => new Date() })
  createdAt: Date = new Date();
}
