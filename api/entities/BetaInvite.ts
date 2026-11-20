/**
 * Private-beta allowlist (BETA_INVITE_ONLY=true). An email here may create
 * an account; existing accounts never need one. The row stays after sign-up
 * with acceptedAt set, so the admin sheet can show who has joined.
 */

import { Entity, ManyToOne, PrimaryKey, Property, Unique } from "@mikro-orm/core";
import { randomUUID } from "node:crypto";
import { User } from "./User.js";

@Entity({ tableName: "beta_invites" })
export class BetaInvite {
  @PrimaryKey({ type: "uuid" })
  id: string = randomUUID();

  /** Lowercased, trimmed; see normalizeEmail in otp.ts. */
  @Unique()
  @Property({ type: "string", length: 254 })
  email!: string;

  /** The admin who added it; null when added from the CLI. */
  @ManyToOne(() => User, { nullable: true, deleteRule: "set null" })
  invitedBy?: User | null;

  @Property({ type: "string", length: 200, nullable: true })
  note?: string | null;

  @Property({ type: "timestamptz", onCreate: () => new Date() })
  createdAt: Date = new Date();

  @Property({ type: "timestamptz", nullable: true })
  acceptedAt?: Date | null;
}
