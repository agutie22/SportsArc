/**
 * One player's entry into one event: the on-chain Entry they signed for and
 * what became of it. One row per player and event; leaving and entering
 * again reuses it with the next `attempt`, as the vault counts them.
 *
 *   signing   asked to sign; nothing sent, no seat held
 *   pending   the register call is sent; the seat is held
 *   entered   registered on chain; the player has a seat in the game
 *   leaving   the leave call is sent
 *   left      left before registration closed; the fee went back in that call
 *   failed    the register call was refused or reverted; no seat
 *
 * Where the seat's money goes back: the player's own wallet, or, when
 * `routed`, the chain and address they chose (gateway/ forwards it). The
 * choice is part of what the player signed, so it is fixed once entered.
 */

import { Entity, Index, ManyToOne, PrimaryKey, Property, Unique } from "@mikro-orm/core";
import { randomUUID } from "node:crypto";
import { User } from "../../entities/User.js";
import { EventTerms } from "./EventTerms.js";

export const ENTRY_STATES = ["signing", "pending", "entered", "leaving", "left", "failed"] as const;
export type EntryState = (typeof ENTRY_STATES)[number];

/** Why money came back to a player: a refund of their fee, or a share of the prize. */
export type EntryPayoutKind = "refund" | "prize";

@Entity({ tableName: "event_entries" })
@Unique({ properties: ["terms", "user"] })
@Index({ properties: ["terms", "playerAddress"] })
@Index({ properties: ["state"] })
export class EventEntry {
  @PrimaryKey({ type: "uuid" })
  id: string = randomUUID();

  @ManyToOne(() => EventTerms, { deleteRule: "cascade" })
  terms!: EventTerms;

  @ManyToOne(() => User, { deleteRule: "cascade" })
  user!: User;

  /** Checksummed wallet the entry is for: the vault's `player`. */
  @Property({ type: "string", length: 42 })
  playerAddress!: string;

  /** The team this entry plays for; a solo player's is a hash of their address. */
  @Property({ type: "string", length: 66 })
  teamKey!: string;

  @Property({ type: "boolean", default: false })
  routed: boolean = false;

  /** gateway/config.ts chain key and address for a routed seat. */
  @Property({ type: "string", length: 24, nullable: true })
  payoutChainKey?: string | null;

  @Property({ type: "string", length: 42, nullable: true })
  payoutAddress?: string | null;

  /** The vault's attempt counter for this player when this entry was built. */
  @Property({ type: "int" })
  attempt: number = 0;

  @Property({ type: "string", length: 16 })
  state: EntryState = "signing";

  /** The UserSignature that pays for (or, with no fee, is) the entry. */
  @Property({ type: "uuid", nullable: true })
  signatureId?: string | null;

  @Property({ type: "string", length: 66, nullable: true })
  txHash?: string | null;

  @Property({ type: "uuid", nullable: true })
  leaveSignatureId?: string | null;

  @Property({ type: "string", length: 66, nullable: true })
  leaveTxHash?: string | null;

  @Property({ type: "timestamptz", nullable: true })
  enteredAt?: Date | null;

  @Property({ type: "timestamptz", nullable: true })
  leftAt?: Date | null;

  // ── what the event paid this player ──

  /** Base units paid back or won; "0" when the event ran and they were not placed. */
  @Property({ type: "string", length: 78, nullable: true })
  payout?: string | null;

  @Property({ type: "string", length: 8, nullable: true })
  payoutKind?: EntryPayoutKind | null;

  @Property({ type: "string", length: 66, nullable: true })
  payoutTxHash?: string | null;

  /** This entry is owed nothing more. */
  @Property({ type: "timestamptz", nullable: true })
  settledAt?: Date | null;

  @Property({ type: "timestamptz", onCreate: () => new Date() })
  createdAt: Date = new Date();

  @Property({ type: "timestamptz", onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date();
}
