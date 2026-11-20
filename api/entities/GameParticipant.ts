import { Entity, ManyToOne, PrimaryKey, Property, Unique } from "@mikro-orm/core";
import { randomUUID } from "node:crypto";
import { Game } from "./Game.js";
import { User } from "./User.js";

export const PARTICIPANT_STATUSES = ["joined", "waitlist", "cancelled", "no_show"] as const;
export type ParticipantStatus = (typeof PARTICIPANT_STATUSES)[number];

@Entity({ tableName: "game_participants" })
@Unique({ properties: ["game", "user"] })
export class GameParticipant {
  @PrimaryKey({ type: "uuid" })
  id: string = randomUUID();

  @ManyToOne(() => Game, { deleteRule: "cascade" })
  game!: Game;

  @ManyToOne(() => User, { deleteRule: "cascade" })
  user!: User;

  @Property({ type: "string", length: 16 })
  status: ParticipantStatus = "joined";

  /** Set at check-in: the player was at the venue. */
  @Property({ type: "timestamptz", nullable: true })
  checkedInAt?: Date | null;

  /**
   * 0 or 1 while sides are being picked (see results.ts). Editable until the
   * sides lock; the locked copy lives in ResultSeat.
   */
  @Property({ type: "smallint", nullable: true })
  side?: number | null;

  /**
   * The host's word on whether this player was there, once the host has
   * confirmed the roster after check-in closed (games/roster.ts). Null
   * until then. A second source beside the phone's check-in.
   */
  @Property({ type: "boolean", nullable: true })
  hostPresent?: boolean | null;

  /**
   * Named co-host by the host. Only a joined seat holds it; it is
   * cleared when the seat leaves, is removed, or becomes the host.
   */
  @Property({ type: "boolean", default: false })
  cohost: boolean = false;

  /**
   * Set when a host or co-host removed this seat (status "cancelled"). A
   * removed player cannot rejoin the same game.
   */
  @Property({ type: "timestamptz", nullable: true })
  removedAt?: Date | null;

  @Property({ type: "timestamptz", onCreate: () => new Date() })
  joinedAt: Date = new Date();
}
