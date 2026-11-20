/**
 * One season of a league.
 *
 *   draft    staff are setting it up: add teams directly, no sign-ups yet
 *   open     registration is open: captains register teams, players sign
 *            up alone and staff place them; staff can still add teams
 *   running  the schedule exists; rosters can still change
 *   final    over; standings are fixed
 *   cancelled
 */

import { Entity, ManyToOne, PrimaryKey, Property } from "@mikro-orm/core";
import { randomUUID } from "node:crypto";
import { League } from "./League.js";
import { Game } from "../entities/Game.js";

export const SEASON_STATUSES = ["draft", "open", "running", "final", "cancelled"] as const;
export type SeasonStatus = (typeof SEASON_STATUSES)[number];

export function isSeasonStatus(v: unknown): v is SeasonStatus {
  return typeof v === "string" && (SEASON_STATUSES as readonly string[]).includes(v);
}

@Entity({ tableName: "seasons" })
export class Season {
  @PrimaryKey({ type: "uuid" })
  id: string = randomUUID();

  @ManyToOne(() => League, { deleteRule: "cascade" })
  league!: League;

  @Property({ type: "string", length: 120 })
  name!: string;

  @Property({ type: "date" })
  startsOn!: string;

  @Property({ type: "date" })
  endsOn!: string;

  @Property({ type: "string", length: 16 })
  status: SeasonStatus = "draft";

  /** A team needs this many players before the schedule is made. */
  @Property({ type: "smallint" })
  rosterMin: number = 3;

  @Property({ type: "smallint" })
  rosterMax: number = 5;

  /**
   * When the organizer finished it. Standings count only results settled
   * before this, and the season's records (standing, member, season) carry it.
   */
  @Property({ type: "timestamptz", nullable: true })
  finalAt?: Date | null;

  /**
   * The season's finals: an ordinary paid event (kind "event") the league's
   * staff host and link here. Its prize can come from the season's sponsor.
   */
  @ManyToOne(() => Game, { nullable: true, deleteRule: "set null" })
  finals?: Game | null;

  /** Null: no cap on teams. */
  @Property({ type: "smallint", nullable: true })
  teamsMax?: number | null;

  @Property({ type: "timestamptz", onCreate: () => new Date() })
  createdAt: Date = new Date();

  @Property({ type: "timestamptz", onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date();
}
