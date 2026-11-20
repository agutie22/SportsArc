/**
 * One user's USDC withdrawal from Arc testnet over CCTP v2. Amounts are
 * USDC base units (6 dp) as decimal strings. The burn is a tx from the
 * user's own wallet (wallet workstream's prepareUserTx); `stepTxId` is the
 * UserEvmTx behind the current step.
 *
 *   burn_approval  Arc USDC allowance for TokenMessengerV2 (skipped if enough)
 *   burn           depositForBurnWithHook on Arc; its MessageSent is kept
 *   attestation    polling Iris for the signed message
 *   receive        waiting for Circle to mint on the destination
 *   completed | failed
 *
 * The burn carries the Forwarding Service hook, to any chain in config.ts
 * CCTP_TESTNETS and to any address (`recipientAddress`, null meaning the
 * user's own wallet). Circle submits the mint, so the receive step only
 * waits; nothing is signed after the burn.
 *
 * `failed` is only for a confirmed burn tx that emitted no matching CCTP
 * message (the automation stops; nothing more is signed). Everything else,
 * including an attestation that does not match the burn, is recorded in
 * lastError and retried on the next advance.
 */

import { Entity, Index, ManyToOne, PrimaryKey, Property, Unique } from "@mikro-orm/core";
import { randomUUID } from "node:crypto";
import { User } from "../../entities/User.js";

export const CCTP_STATES = [
  "burn_approval", "burn", "attestation", "receive", "completed", "failed",
] as const;
export type CctpState = (typeof CCTP_STATES)[number];

@Entity({ tableName: "cctp_transfers" })
@Index({ properties: ["user", "createdAt"] })
@Index({ properties: ["state", "nextCheckAt"] })
@Unique({ properties: ["burnTxHash"] })
export class CctpTransfer {
  @PrimaryKey({ type: "uuid" })
  id: string = randomUUID();

  @ManyToOne(() => User, { deleteRule: "cascade" })
  user!: User;

  @Property({ type: "string", length: 16 })
  state: CctpState = "burn_approval";

  @Property({ type: "int" })
  sourceChainId!: number;

  @Property({ type: "int" })
  sourceDomain!: number;

  @Property({ type: "int" })
  destinationChainId!: number;

  @Property({ type: "int" })
  destinationDomain!: number;

  /** The user's wallet: burns on Arc. Circle mints to recipientAddress, or here. */
  @Property({ type: "string", length: 42 })
  walletAddress!: string;

  /** Where the USDC is minted; null means walletAddress. */
  @Property({ type: "string", length: 42, nullable: true })
  recipientAddress?: string | null;

  /** Burned with the Forwarding Service hook: Circle submits the mint. */
  @Property({ type: "boolean", default: true })
  forward: boolean = true;

  @Property({ type: "string", length: 78 })
  amount!: string;

  /** Set when the burn is prepared: Circle's forwarding quote plus the protocol fee. */
  @Property({ type: "string", length: 78, nullable: true })
  maxFee?: string | null;

  @Property({ type: "int" })
  minFinalityThreshold!: number;

  /** The wallet workstream's UserEvmTx for the step in progress. */
  @Property({ type: "uuid", nullable: true })
  stepTxId?: string | null;

  @Property({ type: "string", length: 66, nullable: true })
  burnApprovalTxHash?: string | null;

  @Property({ type: "string", length: 66, nullable: true })
  burnTxHash?: string | null;

  /** MessageSent from the burn, attester fields zeroed. */
  @Property({ type: "text", nullable: true })
  sourceMessage?: string | null;

  @Property({ type: "text", nullable: true })
  attestedMessage?: string | null;

  @Property({ type: "text", nullable: true })
  attestation?: string | null;

  @Property({ type: "string", length: 66, nullable: true })
  nonce?: string | null;

  @Property({ type: "int" })
  irisPolls: number = 0;

  /** Circle's mint, once Iris or the destination reports it. */
  @Property({ type: "string", length: 66, nullable: true })
  receiveTxHash?: string | null;

  @Property({ type: "string", length: 78, nullable: true })
  mintedAmount?: string | null;

  /** Earliest next Iris poll; null means now. */
  @Property({ type: "timestamptz", nullable: true })
  nextCheckAt?: Date | null;

  @Property({ type: "string", length: 40, nullable: true })
  lastErrorCode?: string | null;

  @Property({ type: "text", nullable: true })
  lastError?: string | null;

  @Property({ type: "timestamptz", nullable: true })
  completedAt?: Date | null;

  @Property({ type: "timestamptz", onCreate: () => new Date() })
  createdAt: Date = new Date();

  @Property({ type: "timestamptz", onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date();
}
