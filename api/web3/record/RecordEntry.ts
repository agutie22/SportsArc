/**
 * One record on SportsArcRecord: a check-in or a missed game, written on its
 * own. Holds what the record commits to (its ABI values and the salt that
 * opens the participant commitment), and where its write stands.
 *
 *   pending    built, not sent (also the resting state with no chain configured)
 *   sending    the relayer broadcast it; txHash says which transaction
 *   confirmed  SportsArcRecord.writtenAt(hash) is set on chain
 *   failed     the transaction reverted; a later tick retries
 */

import { BigIntType, Entity, Index, ManyToOne, PrimaryKey, Property, Unique } from "@mikro-orm/core";
import { randomUUID } from "node:crypto";
import { Game } from "../../entities/Game.js";
import { GameParticipant } from "../../entities/GameParticipant.js";
import { User } from "../../entities/User.js";
import { Season } from "../../leagues/Season.js";

export const RECORD_STATUSES = ["pending", "sending", "confirmed", "failed"] as const;
export type RecordStatus = (typeof RECORD_STATUSES)[number];

@Entity({ tableName: "record_entries" })
@Index({ properties: ["status", "createdAt"] })
export class RecordEntry {
  @PrimaryKey({ type: "uuid" })
  id: string = randomUUID();

  /** A RecordKind from hashes.ts. */
  @Property({ type: "string", length: 32 })
  kind!: string;

  /**
   * What this record is the one record of, so each fact is written once:
   * "attendance:<seat id>" (checkin or noshow), "result:<seat id>",
   * "game:<game id>", "presence:<seat id>", "standing:<season>:<team>",
   * "member:<season>:<team>:<user>", "season:<season>".
   */
  @Unique()
  @Property({ type: "string", length: 120 })
  slot!: string;

  /** recordHash(kind, values): the record's ID on chain. */
  @Unique()
  @Property({ type: "string", length: 66 })
  hash!: string;

  /** ABI values in the kind's encoding, as strings. values[0] is the kind tag. */
  @Property({ type: "json" })
  values!: string[];

  /** Opens the participant commitment; shown only to the participant. Null on kinds with no person. */
  @Property({ type: "string", length: 66, nullable: true })
  salt?: string | null;

  /** The game this record is about. */
  @ManyToOne(() => Game, { nullable: true, deleteRule: "set null" })
  game?: Game | null;

  /**
   * The seat a seat record (attendance, result) is about. Cascade: deleting
   * the seat drops the salt, and the hash on chain can never be opened
   * again. Null for kinds with no seat (game).
   */
  @Index()
  @ManyToOne(() => GameParticipant, { deleteRule: "cascade", nullable: true })
  participant?: GameParticipant | null;

  /** The season a season record (standing, member, season) is about. */
  @ManyToOne(() => Season, { nullable: true, deleteRule: "set null" })
  season?: Season | null;

  /**
   * The player a member record is about (records with a seat use
   * `participant`). Cascade, like the seat: deleting the player drops the salt.
   */
  @Index()
  @ManyToOne(() => User, { nullable: true, deleteRule: "cascade" })
  user?: User | null;

  @Property({ type: "string", length: 16 })
  status: RecordStatus = "pending";

  /** Where it was written: set on the first send. */
  @Property({ type: "int", nullable: true })
  chainId?: number | null;

  @Property({ type: "string", length: 42, nullable: true })
  contract?: string | null;

  @Property({ type: "string", length: 66, nullable: true })
  txHash?: string | null;

  @Property({ type: new BigIntType("number"), nullable: true })
  blockNumber?: number | null;

  /** Block time of the write, read back from the contract (writtenAt). */
  @Property({ type: "timestamptz", nullable: true })
  writtenAt?: Date | null;

  @Property({ type: "int" })
  attempts: number = 0;

  @Property({ type: "string", length: 500, nullable: true })
  lastError?: string | null;

  @Property({ type: "timestamptz", onCreate: () => new Date() })
  createdAt: Date = new Date();

  @Property({ type: "timestamptz", onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date();
}
