/**
 * One practice trade: contracts a user bought, or sold back, at the live
 * Gemini price in practice mode, with no Gemini account and no money.
 *
 * A practice account is the sum of its fills: it starts at
 * GEMINI_PRACTICE_START dollars and each fill takes its `costCents` (a sale
 * has a negative cost: the money it brought in). Each settled buy pays $1 a
 * contract when the contract resolved the way it was bought; a settled sale
 * pays minus that, for the contracts it gave up. A position sold down to
 * nothing is closed at once: its fills are settled with no payout.
 * Settlement reads Gemini's own result for the event (practice.ts), so
 * practice positions settle exactly as real ones would.
 *
 * Money is kept in cents and quantities as decimal strings, never floats.
 */

import { Entity, Index, ManyToOne, PrimaryKey, Property, Unique } from "@mikro-orm/core";
import { randomUUID } from "node:crypto";
import { User } from "../entities/User.js";

@Entity({ tableName: "practice_fills" })
@Index({ properties: ["user", "settledAt"] })
@Unique({ properties: ["user", "clientOrderId"] })
export class PracticeFill {
  @PrimaryKey({ type: "uuid" })
  id: string = randomUUID();

  @ManyToOne(() => User, { deleteRule: "cascade" })
  user!: User;

  /** The browser's id for the order, so a double tap fills once. */
  @Property({ type: "string", length: 64 })
  clientOrderId!: string;

  @Property({ type: "string", length: 120 })
  symbol!: string;

  @Property({ type: "string", length: 100 })
  eventTicker!: string;

  /** What the position list shows, kept from the moment of the trade. */
  @Property({ type: "string", length: 160 })
  title!: string;

  @Property({ type: "string", length: 120 })
  label!: string;

  @Property({ type: "string", length: 24 })
  sport!: string;

  @Property({ type: "string", length: 3 })
  outcome!: "yes" | "no";

  /** A buy, or a sale of contracts bought before. `qty` is always positive. */
  @Property({ type: "string", length: 4, default: "buy" })
  side: "buy" | "sell" = "buy";

  @Property({ type: "string", length: 24 })
  qty!: string;

  /** Price per contract, 0–1, as Gemini quoted it. */
  @Property({ type: "string", length: 12 })
  price!: string;

  @Property({ type: "int" })
  costCents!: number;

  @Property({ type: "timestamptz", nullable: true })
  settledAt?: Date | null;

  /** What the fill paid out at settlement: qty × $1 on a win, else 0. */
  @Property({ type: "int", nullable: true })
  payoutCents?: number | null;

  @Property({ type: "timestamptz", onCreate: () => new Date() })
  createdAt: Date = new Date();
}
