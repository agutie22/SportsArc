/**
 * What a user's Pro markets account was worth at an hour: money available
 * plus what open positions would sell for. The Portfolio card's line over
 * 1D / 1W / 1M / All is drawn from these (portfolio.ts).
 *
 * Written when the account is read (GET /api/markets/me), at most once an
 * hour: the unique (user, at) with `at` truncated to the hour makes a second
 * write in the same hour a no-op, across API instances too.
 */

import { Entity, ManyToOne, PrimaryKey, Property, Unique } from "@mikro-orm/core";
import { randomUUID } from "node:crypto";
import { User } from "../entities/User.js";

@Entity({ tableName: "portfolio_snapshots" })
@Unique({ properties: ["user", "at"] })
export class PortfolioSnapshot {
  @PrimaryKey({ type: "uuid" })
  id: string = randomUUID();

  @ManyToOne(() => User, { deleteRule: "cascade" })
  user!: User;

  @Property({ type: "int" })
  valueCents!: number;

  /** The hour, truncated. */
  @Property({ type: "timestamptz" })
  at!: Date;

  @Property({ type: "timestamptz" })
  createdAt: Date = new Date();
}
