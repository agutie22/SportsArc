/**
 * One point of a market's odds history: a contract's chance (0–100, the
 * number a card shows) at a minute. Written by history.ts only when the
 * chance changed since the last point, so a quiet market costs a row an
 * hour or so, not one every 20 seconds.
 *
 * `at` is the minute, not the instant: every API instance warms its own
 * catalog, and the unique (symbol, at) lets two of them record the same
 * change without writing it twice.
 */

import { Entity, PrimaryKey, Property, Unique } from "@mikro-orm/core";
import { randomUUID } from "node:crypto";

@Entity({ tableName: "market_ticks" })
@Unique({ properties: ["symbol", "at"] })
export class MarketTick {
  @PrimaryKey({ type: "uuid" })
  id: string = randomUUID();

  /** Gemini's instrument symbol, GEMI-<event ticker>-<contract ticker>. */
  @Property({ type: "string", length: 120 })
  symbol!: string;

  /** The yes side's chance, 0–100. */
  @Property({ type: "smallint" })
  chance!: number;

  /** The minute this chance was seen, truncated. */
  @Property({ type: "timestamptz" })
  at!: Date;

  @Property({ type: "timestamptz" })
  createdAt: Date = new Date();
}
