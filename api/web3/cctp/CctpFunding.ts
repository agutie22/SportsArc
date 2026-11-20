/**
 * Money a player sent into their SportsArc wallet from an outside wallet on
 * another chain: a CCTP burn there, signed by that outside wallet in the
 * browser, minted on Arc by Circle's Forwarding Service. The server signs
 * nothing; this row only follows the burn to its arrival (funding.ts).
 *
 *   sent     the browser reported the burn tx; waiting for Circle
 *   arrived  minted to the player's wallet (mintTxHash when Circle reports it)
 *   failed   the tx is not a burn to this player's wallet, or never showed up
 */

import { Entity, Index, ManyToOne, PrimaryKey, Property, Unique } from "@mikro-orm/core";
import { randomUUID } from "node:crypto";
import { User } from "../../entities/User.js";

export const FUNDING_STATES = ["sent", "arrived", "failed"] as const;
export type FundingState = (typeof FUNDING_STATES)[number];

@Entity({ tableName: "cctp_fundings" })
@Index({ properties: ["user", "createdAt"] })
@Index({ properties: ["state", "nextCheckAt"] })
@Unique({ properties: ["sourceChainId", "burnTxHash"] })
export class CctpFunding {
  @PrimaryKey({ type: "uuid" })
  id: string = randomUUID();

  @ManyToOne(() => User, { deleteRule: "cascade" })
  user!: User;

  @Property({ type: "string", length: 8 })
  state: FundingState = "sent";

  @Property({ type: "int" })
  sourceChainId!: number;

  @Property({ type: "int" })
  sourceDomain!: number;

  /** The player's SportsArc wallet the burn must mint to. */
  @Property({ type: "string", length: 42 })
  walletAddress!: string;

  @Property({ type: "string", length: 66 })
  burnTxHash!: string;

  /** USDC base units burned, once Circle has seen the burn. */
  @Property({ type: "string", length: 78, nullable: true })
  amount?: string | null;

  /** What reached the wallet: amount less Circle's fee. */
  @Property({ type: "string", length: 78, nullable: true })
  receivedAmount?: string | null;

  @Property({ type: "string", length: 66, nullable: true })
  mintTxHash?: string | null;

  @Property({ type: "int" })
  polls: number = 0;

  @Property({ type: "timestamptz", nullable: true })
  nextCheckAt?: Date | null;

  @Property({ type: "text", nullable: true })
  lastError?: string | null;

  @Property({ type: "timestamptz", nullable: true })
  completedAt?: Date | null;

  @Property({ type: "timestamptz", onCreate: () => new Date() })
  createdAt: Date = new Date();

  @Property({ type: "timestamptz", onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date();
}
