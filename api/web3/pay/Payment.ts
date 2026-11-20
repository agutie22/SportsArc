/**
 * A USDC payment between two players, or a request for one. One row covers
 * both: a request starts "requested" and becomes a payment when the payer
 * pays it; a direct send starts "pending". The money itself moves on chain,
 * from the payer's own wallet (a PIN-signed USDC authorization on
 * WEB3_CHAIN, submitted by the relayer); this row is the social record
 * around it: who, how much, what for.
 *
 *   requested  the payee asked; waiting on the payer
 *   pending    the payer is signing (signatureId), or the transfer is in
 *              flight (txHash)
 *   paid       the transfer confirmed on chain (txHash)
 *   declined   the payer said no to a request
 *   cancelled  the payee withdrew a request, or a direct send never went out
 */

import { Entity, Index, ManyToOne, PrimaryKey, Property } from "@mikro-orm/core";
import { randomUUID } from "node:crypto";
import { Game } from "../../entities/Game.js";
import { User } from "../../entities/User.js";

export const PAYMENT_STATUSES = ["requested", "pending", "paid", "declined", "cancelled"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

@Entity({ tableName: "payments" })
@Index({ properties: ["payer", "status"] })
@Index({ properties: ["payee", "createdAt"] })
export class Payment {
  @PrimaryKey({ type: "uuid" })
  id: string = randomUUID();

  @ManyToOne(() => User, { deleteRule: "cascade" })
  payer!: User;

  @ManyToOne(() => User, { deleteRule: "cascade" })
  payee!: User;

  /** USDC base units (6 decimals). */
  @Property({ type: "bigint" })
  amount!: bigint;

  @Property({ type: "string", length: 80, nullable: true })
  note?: string | null;

  /** Set when the payment splits a cost of this game. */
  @ManyToOne(() => Game, { nullable: true, deleteRule: "set null" })
  game?: Game | null;

  @Property({ type: "string", length: 10 })
  status: PaymentStatus = "pending";

  /** Started as a request: a failed payment goes back to "requested", not "cancelled". */
  @Property({ type: "boolean", default: false })
  wasRequest: boolean = false;

  /** The UserSignature the payer signs (wallet/signature.ts). */
  @Property({ type: "uuid", nullable: true })
  signatureId?: string | null;

  @Property({ type: "int", nullable: true })
  chainId?: number | null;

  @Property({ type: "string", length: 66, nullable: true })
  txHash?: string | null;

  @Property({ type: "timestamptz", onCreate: () => new Date() })
  createdAt: Date = new Date();

  @Property({ type: "timestamptz", nullable: true })
  paidAt?: Date | null;
}
