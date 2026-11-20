/**
 * A transaction from a user's EVM-TESTNET wallet: built here, signed by the
 * user through a Circle challenge, broadcast and tracked here. Wei amounts
 * and gas are decimal strings because they overflow a JS number.
 *
 *   awaiting_signature -> submitted -> confirmed | reverted
 *   awaiting_signature -> superseded   (a newer tx was prepared first)
 *   awaiting_signature -> failed       (the node rejected the signed tx)
 *   submitted -> dropped               (never mined; its nonce was used by another tx)
 *
 * chainId is any chain the wallet serves (networks.ts); the same address
 * has an independent nonce on each.
 */

import { Entity, Index, ManyToOne, PrimaryKey, Property } from "@mikro-orm/core";
import { randomUUID } from "node:crypto";
import { User } from "../../entities/User.js";

export const EVM_TX_STATUSES = [
  "awaiting_signature", "superseded", "submitted", "confirmed", "reverted", "failed", "dropped",
] as const;
export type EvmTxStatus = (typeof EVM_TX_STATUSES)[number];

@Entity({ tableName: "user_evm_txs" })
@Index({ properties: ["user", "createdAt"] })
export class UserEvmTx {
  @PrimaryKey({ type: "uuid" })
  id: string = randomUUID();

  @ManyToOne(() => User, { deleteRule: "cascade" })
  user!: User;

  /** What the tx is for, set by the caller ("call" from the public route). */
  @Property({ type: "string", length: 32 })
  kind: string = "call";

  @Property({ type: "string", length: 24 })
  status: EvmTxStatus = "awaiting_signature";

  @Property({ type: "int" })
  chainId!: number;

  @Property({ type: "string", length: 42 })
  fromAddress!: string;

  @Property({ type: "string", length: 42 })
  toAddress!: string;

  @Property({ type: "string", length: 78 })
  value: string = "0";

  @Property({ type: "text" })
  data: string = "0x";

  @Property({ type: "int" })
  nonce!: number;

  @Property({ type: "string", length: 78 })
  gasLimit!: string;

  @Property({ type: "string", length: 78 })
  maxFeePerGas!: string;

  @Property({ type: "string", length: 78 })
  maxPriorityFeePerGas!: string;

  /** The unsigned EIP-1559 serialization sent to Circle to sign. */
  @Property({ type: "text" })
  unsignedTx!: string;

  /** Shown to the user in Circle's confirmation screen. */
  @Property({ type: "string", length: 120, nullable: true })
  memo?: string | null;

  @Property({ type: "string", length: 64, nullable: true })
  challengeId?: string | null;

  @Property({ type: "string", length: 66, nullable: true })
  txHash?: string | null;

  @Property({ type: "string", length: 32, nullable: true })
  blockNumber?: string | null;

  @Property({ type: "string", length: 78, nullable: true })
  gasUsed?: string | null;

  @Property({ type: "text", nullable: true })
  error?: string | null;

  @Property({ type: "timestamptz", nullable: true })
  submittedAt?: Date | null;

  @Property({ type: "timestamptz", onCreate: () => new Date() })
  createdAt: Date = new Date();

  @Property({ type: "timestamptz", onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date();
}
