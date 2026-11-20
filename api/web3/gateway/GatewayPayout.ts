/**
 * One payment to a player on another chain. A row is written when money a
 * player is owed reaches the payout wallet (inbox.ts) and then driven by the
 * payout job (payouts.ts). Amounts are USDC base units as decimal strings.
 *
 *   queued            waiting to be funded: the fee is quoted, then `amount`
 *                     is deposited into the payout wallet's Gateway balance
 *   funded            deposit confirmed; waiting for Gateway to credit it
 *   sending           a signed burn intent is with Circle, whose forwarder
 *                     mints `sentAmount` on the destination chain
 *   completed         minted there (destTxHash)
 *   fallback_pending  the payout could not go out; `amount` is being sent to
 *                     the player's SportsArc wallet instead
 *   fallback          paid to the SportsArc wallet (fallbackTxHash)
 *
 * The fee comes out of the payout: sentAmount = amount - fee. `sourceKey`
 * names the on-chain event that funded the row, so one event pays once.
 */

import { Entity, Index, ManyToOne, PrimaryKey, Property, Unique } from "@mikro-orm/core";
import { randomUUID } from "node:crypto";
import { Game } from "../../entities/Game.js";
import { User } from "../../entities/User.js";

export const PAYOUT_STATES = ["queued", "funded", "sending", "completed", "fallback_pending", "fallback"] as const;
export type PayoutState = (typeof PAYOUT_STATES)[number];

@Entity({ tableName: "gateway_payouts" })
@Index({ properties: ["user", "createdAt"] })
@Index({ properties: ["state", "nextAttemptAt"] })
@Unique({ properties: ["sourceKey"] })
export class GatewayPayout {
  @PrimaryKey({ type: "uuid" })
  id: string = randomUUID();

  @ManyToOne(() => User, { deleteRule: "cascade" })
  user!: User;

  /** The game the money came out of, if any. */
  @ManyToOne(() => Game, { nullable: true, deleteRule: "set null" })
  game?: Game | null;

  /** "<chainId>:<txHash>:<logIndex>" of the event that funded this payout. */
  @Property({ type: "string", length: 120 })
  sourceKey!: string;

  @Property({ type: "string", length: 20 })
  state: PayoutState = "queued";

  @Property({ type: "string", length: 78 })
  amount!: string;

  /** config.ts chain key of the destination, e.g. "baseSepolia". */
  @Property({ type: "string", length: 24 })
  destChainKey!: string;

  @Property({ type: "string", length: 42 })
  destAddress!: string;

  @Property({ type: "string", length: 78, nullable: true })
  fee?: string | null;

  @Property({ type: "string", length: 78, nullable: true })
  sentAmount?: string | null;

  @Property({ type: "string", length: 66, nullable: true })
  depositTxHash?: string | null;

  /** Bumped only when Circle refused an attempt, so each attempt has its own salt. */
  @Property({ type: "int" })
  attempt: number = 0;

  @Property({ type: "string", length: 36, nullable: true })
  transferId?: string | null;

  @Property({ type: "string", length: 66, nullable: true })
  destTxHash?: string | null;

  @Property({ type: "string", length: 66, nullable: true })
  fallbackTxHash?: string | null;

  /** Why the payout went to the SportsArc wallet instead, in plain words. */
  @Property({ type: "string", length: 200, nullable: true })
  fallbackReason?: string | null;

  /** Failed passes since the last progress. */
  @Property({ type: "int" })
  errors: number = 0;

  @Property({ type: "string", length: 40, nullable: true })
  lastErrorCode?: string | null;

  @Property({ type: "text", nullable: true })
  lastError?: string | null;

  /** Earliest next pass; null means now. */
  @Property({ type: "timestamptz", nullable: true })
  nextAttemptAt?: Date | null;

  @Property({ type: "timestamptz", nullable: true })
  completedAt?: Date | null;

  @Property({ type: "timestamptz", onCreate: () => new Date() })
  createdAt: Date = new Date();

  @Property({ type: "timestamptz", onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date();
}
