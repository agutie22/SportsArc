/**
 * An organization account: a league, club, venue, sponsor or school. One
 * account type for all of them (docs: Leagues, Organizations & Onboarding).
 * Anyone adult may create one and becomes its owner; it is unverified until
 * a SportsArc admin sets verifiedAt, and an unverified org takes no money,
 * sponsors nothing and sees no insights (roles.ts verifiedGate).
 */

import { Entity, ManyToOne, PrimaryKey, Property, Unique } from "@mikro-orm/core";
import { randomUUID } from "node:crypto";
import { User } from "../entities/User.js";

export const ORG_KINDS = ["league", "club", "venue", "sponsor", "school"] as const;
export type OrgKind = (typeof ORG_KINDS)[number];

export function isOrgKind(value: unknown): value is OrgKind {
  return typeof value === "string" && (ORG_KINDS as readonly string[]).includes(value);
}

@Entity({ tableName: "organizations" })
export class Organization {
  @PrimaryKey({ type: "uuid" })
  id: string = randomUUID();

  /** The address: #/org/<slug>. Lowercase letters, digits and dashes. */
  @Unique()
  @Property({ type: "string", length: 60 })
  slug!: string;

  @Property({ type: "string", length: 120 })
  name!: string;

  @Property({ type: "string", length: 16 })
  kind!: OrgKind;

  @Property({ type: "string", length: 120, nullable: true })
  city?: string | null;

  @Property({ type: "string", length: 255, nullable: true })
  website?: string | null;

  @Property({ type: "string", length: 500, nullable: true })
  bio?: string | null;

  /** Set by an admin. Null = unverified. */
  @Property({ type: "timestamptz", nullable: true })
  verifiedAt?: Date | null;

  /**
   * The member whose SportsArc wallet signs for the org (v0: the org has no
   * wallet of its own). Its address is where org money goes.
   */
  @ManyToOne(() => User, { nullable: true, deleteRule: "set null" })
  signer?: User | null;

  @ManyToOne(() => User, { nullable: true, deleteRule: "set null" })
  createdBy?: User | null;

  @Property({ type: "timestamptz", onCreate: () => new Date() })
  createdAt: Date = new Date();

  @Property({ type: "timestamptz", onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date();
}
