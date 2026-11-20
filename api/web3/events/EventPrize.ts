/**
 * One contribution to an event's prize: the on-chain Prize its host signed
 * for. Only the host funds a prize until sponsor accounts exist; EventVault
 * calls whoever funds it the `sponsor`. A host may add more than once; each
 * contribution has its own salt.
 *
 *   signing   asked to sign; nothing sent
 *   pending   the fundPrize call is sent
 *   funded    in the vault
 *   failed    the call was refused or reverted; nothing moved
 *
 * The vault pays a funder back per wallet, not per contribution: all of it
 * when the event does not run, and otherwise whatever the result left
 * unused. `returned` is this contribution's part of that.
 */

import { Entity, Index, ManyToOne, PrimaryKey, Property } from "@mikro-orm/core";
import { Organization } from "../../orgs/Organization.js";
import { randomUUID } from "node:crypto";
import { User } from "../../entities/User.js";
import { EventTerms } from "./EventTerms.js";

export const PRIZE_STATES = ["signing", "pending", "funded", "failed"] as const;
export type PrizeState = (typeof PRIZE_STATES)[number];

@Entity({ tableName: "event_prizes" })
@Index({ properties: ["terms", "state"] })
@Index({ properties: ["funder", "createdAt"] })
export class EventPrize {
  @PrimaryKey({ type: "uuid" })
  id: string = randomUUID();

  @ManyToOne(() => EventTerms, { deleteRule: "cascade" })
  terms!: EventTerms;

  @ManyToOne(() => User, { deleteRule: "cascade" })
  funder!: User;

  /** Checksummed wallet the money comes from: the vault's `sponsor`. */
  @Property({ type: "string", length: 42 })
  funderAddress!: string;

  /**
   * Set when the funder put the money up for a sponsor organization (its
   * signer's wallet): the event shows the prize as that org's.
   */
  @ManyToOne(() => Organization, { nullable: true, deleteRule: "set null" })
  sponsorOrg?: Organization | null;

  /** USDC base units. */
  @Property({ type: "bigint" })
  amount!: bigint;

  @Property({ type: "string", length: 66 })
  salt!: string;

  @Property({ type: "string", length: 16 })
  state: PrizeState = "signing";

  @Property({ type: "uuid", nullable: true })
  signatureId?: string | null;

  @Property({ type: "string", length: 66, nullable: true })
  txHash?: string | null;

  @Property({ type: "timestamptz", nullable: true })
  fundedAt?: Date | null;

  /** Base units that came back to the funder for this contribution; "0" when all of it was won. */
  @Property({ type: "string", length: 78, nullable: true })
  returned?: string | null;

  @Property({ type: "string", length: 66, nullable: true })
  returnTxHash?: string | null;

  /** This contribution is owed nothing more. */
  @Property({ type: "timestamptz", nullable: true })
  settledAt?: Date | null;

  @Property({ type: "timestamptz", onCreate: () => new Date() })
  createdAt: Date = new Date();

  @Property({ type: "timestamptz", onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date();
}
