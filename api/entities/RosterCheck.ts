/**
 * The host's confirmation of who was at a game, one per game. The answer
 * for each player is GameParticipant.hostPresent; this row says who
 * confirmed and when, so the correction window can run from the first
 * confirmation (games/roster.ts).
 */

import { Entity, ManyToOne, PrimaryKey, Property, Unique } from "@mikro-orm/core";
import { randomUUID } from "node:crypto";
import { Game } from "./Game.js";
import { User } from "./User.js";

@Entity({ tableName: "roster_checks" })
@Unique({ properties: ["game"] })
export class RosterCheck {
  @PrimaryKey({ type: "uuid" })
  id: string = randomUUID();

  @ManyToOne(() => Game, { deleteRule: "cascade" })
  game!: Game;

  /** The host or co-host who last confirmed it. */
  @ManyToOne(() => User, { nullable: true, deleteRule: "set null" })
  confirmedBy?: User | null;

  /** When it was first confirmed; the correction window runs from it. */
  @Property({ type: "timestamptz" })
  firstConfirmedAt!: Date;

  /** When it was last confirmed (a correction moves it). */
  @Property({ type: "timestamptz" })
  confirmedAt!: Date;

  @Property({ type: "timestamptz", onCreate: () => new Date() })
  createdAt: Date = new Date();
}
