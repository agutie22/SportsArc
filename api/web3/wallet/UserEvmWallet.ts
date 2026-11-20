/**
 * A user's Circle user-controlled wallet on EVM-TESTNET, Circle's
 * signing-only chain code: Circle signs, we build, broadcast and track the
 * transaction (Wallets). It sits in the same wallet set as the
 * user's ARC-TESTNET wallet and has the same address. One row per user.
 */

import { Entity, ManyToOne, PrimaryKey, Property, Unique } from "@mikro-orm/core";
import { randomUUID } from "node:crypto";
import { User } from "../../entities/User.js";

@Entity({ tableName: "user_evm_wallets" })
@Unique({ properties: ["user"] })
export class UserEvmWallet {
  @PrimaryKey({ type: "uuid" })
  id: string = randomUUID();

  @ManyToOne(() => User, { deleteRule: "cascade" })
  user!: User;

  /** Circle's wallet id, set once Circle lists the wallet. */
  @Property({ type: "string", length: 64, nullable: true })
  circleWalletId?: string | null;

  @Property({ type: "string", length: 42, nullable: true })
  address?: string | null;

  /** The CREATE_WALLET challenge the user still has to complete. */
  @Property({ type: "string", length: 64, nullable: true })
  challengeId?: string | null;

  @Property({ type: "timestamptz", onCreate: () => new Date() })
  createdAt: Date = new Date();

  @Property({ type: "timestamptz", onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date();
}
