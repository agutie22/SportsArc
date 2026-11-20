import { Entity, ManyToOne, PrimaryKey, Property, Unique } from "@mikro-orm/core";
import { randomUUID } from "node:crypto";
import { GameParticipant } from "./GameParticipant.js";
import { GameResult } from "./GameResult.js";

/**
 * A seat in one game result: a participant who was checked in when the
 * sides locked, with the side the host put them on. Written once at lock
 * and never re-sided. The host records the result; every seat is told.
 */
@Entity({ tableName: "result_seats" })
@Unique({ properties: ["result", "participant"] })
export class ResultSeat {
  @PrimaryKey({ type: "uuid" })
  id: string = randomUUID();

  @ManyToOne(() => GameResult, { deleteRule: "cascade" })
  result!: GameResult;

  @ManyToOne(() => GameParticipant, { deleteRule: "cascade" })
  participant!: GameParticipant;

  /** 0 or 1, or null for someone checked in who sat out. */
  @Property({ type: "smallint", nullable: true })
  side?: number | null;
}
