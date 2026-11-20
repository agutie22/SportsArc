/**
 * An address on another chain a player has chosen to be paid at before, kept
 * so the next choice is one tap. Saved the first time it is used.
 */

import { Entity, ManyToOne, PrimaryKey, Property, Unique } from "@mikro-orm/core";
import { randomUUID } from "node:crypto";
import { User } from "../../entities/User.js";

@Entity({ tableName: "payout_destinations" })
@Unique({ properties: ["user", "chainKey", "address"] })
export class PayoutDestination {
  @PrimaryKey({ type: "uuid" })
  id: string = randomUUID();

  @ManyToOne(() => User, { deleteRule: "cascade" })
  user!: User;

  /** config.ts chain key, e.g. "baseSepolia". */
  @Property({ type: "string", length: 24 })
  chainKey!: string;

  /** Checksummed. */
  @Property({ type: "string", length: 42 })
  address!: string;

  @Property({ type: "timestamptz", onCreate: () => new Date() })
  createdAt: Date = new Date();

  @Property({ type: "timestamptz", onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date();
}
