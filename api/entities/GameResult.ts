import { Entity, ManyToOne, PrimaryKey, Property, Unique } from "@mikro-orm/core";
import { randomUUID } from "node:crypto";
import { Game } from "./Game.js";
import { User } from "./User.js";

/**
 * locked   — sides are fixed; the host has not recorded the outcome yet
 * settled  — the host recorded it (correctable for an hour, then final)
 */
export const RESULT_STATUSES = ["locked", "settled"] as const;
export type ResultStatus = (typeof RESULT_STATUSES)[number];

/** win — winningSide won; draw — nobody did; not_played — the game never happened. */
export const RESULT_OUTCOMES = ["win", "draw", "not_played"] as const;
export type ResultOutcome = (typeof RESULT_OUTCOMES)[number];

/**
 * One per game. Created the moment sides lock: by the host tapping start,
 * or automatically when check-in closes. The roster it locks lives in
 * ResultSeat, so later edits to game_participants never change who played.
 */
@Entity({ tableName: "game_results" })
@Unique({ properties: ["game"] })
export class GameResult {
  @PrimaryKey({ type: "uuid" })
  id: string = randomUUID();

  @ManyToOne(() => Game, { deleteRule: "cascade" })
  game!: Game;

  @Property({ type: "string", length: 16 })
  status: ResultStatus = "locked";

  @Property({ type: "timestamptz" })
  lockedAt!: Date;

  /** Null when the lock happened automatically at check-in close. */
  @ManyToOne(() => User, { nullable: true, deleteRule: "set null" })
  lockedBy?: User | null;

  @Property({ type: "string", length: 16, nullable: true })
  outcome?: ResultOutcome | null;

  /** 0 or 1 when outcome is "win"; null otherwise. */
  @Property({ type: "smallint", nullable: true })
  winningSide?: number | null;

  @Property({ type: "int", nullable: true })
  score0?: number | null;

  @Property({ type: "int", nullable: true })
  score1?: number | null;

  /** The host or co-host who last recorded the outcome. */
  @ManyToOne(() => User, { nullable: true, deleteRule: "set null" })
  recordedBy?: User | null;

  /** When the outcome was last recorded (a correction moves it). */
  @Property({ type: "timestamptz", nullable: true })
  recordedAt?: Date | null;

  /** When the outcome was first recorded; the correction window runs from it. */
  @Property({ type: "timestamptz", nullable: true })
  firstRecordedAt?: Date | null;

  @Property({ type: "timestamptz", onCreate: () => new Date() })
  createdAt: Date = new Date();

  @Property({ type: "timestamptz", onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date();
}

export function isResultOutcome(v: string): v is ResultOutcome {
  return (RESULT_OUTCOMES as readonly string[]).includes(v);
}
