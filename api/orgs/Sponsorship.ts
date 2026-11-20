/**
 * A sponsor organization backing a court or a league season (sponsors.ts).
 *
 *   venue   a partner court. A venue holds no account, so the sponsor
 *           names it and it is active at once; insights compare activity
 *           there before and after `startsAt`.
 *   season  backing a league season. The sponsor proposes, the league's
 *           staff accept; an active season sponsor may fund the prize of
 *           the season's finals event (web3/events startPrize).
 *
 * Only a verified sponsor org sponsors (roles.ts verifiedGate).
 */

import { Entity, ManyToOne, PrimaryKey, Property, Unique } from "@mikro-orm/core";
import { randomUUID } from "node:crypto";
import { User } from "../entities/User.js";
import { Venue } from "../entities/Venue.js";
import { Season } from "../leagues/Season.js";
import { Organization } from "./Organization.js";

export type SponsorshipKind = "venue" | "season";
export type SponsorshipStatus = "proposed" | "active" | "ended";

@Entity({ tableName: "sponsorships" })
@Unique({ properties: ["sponsor", "venue"] })
@Unique({ properties: ["sponsor", "season"] })
export class Sponsorship {
  @PrimaryKey({ type: "uuid" })
  id: string = randomUUID();

  @ManyToOne(() => Organization, { deleteRule: "cascade" })
  sponsor!: Organization;

  @Property({ type: "string", length: 16 })
  kind!: SponsorshipKind;

  @ManyToOne(() => Venue, { nullable: true, deleteRule: "cascade" })
  venue?: Venue | null;

  @ManyToOne(() => Season, { nullable: true, deleteRule: "cascade" })
  season?: Season | null;

  @Property({ type: "string", length: 16 })
  status: SponsorshipStatus = "proposed";

  /** What the sponsor offers, in a line ("Finals prize", "Free water on league night"). */
  @Property({ type: "string", length: 140, nullable: true })
  offer?: string | null;

  /** When it became active: insights split a partner court's activity here. */
  @Property({ type: "timestamptz", nullable: true })
  startsAt?: Date | null;

  @Property({ type: "timestamptz", nullable: true })
  endedAt?: Date | null;

  @ManyToOne(() => User, { nullable: true, deleteRule: "set null" })
  createdBy?: User | null;

  @Property({ type: "timestamptz", onCreate: () => new Date() })
  createdAt: Date = new Date();
}
