/**
 * An invitation to join an organization's staff. In-app: the person is
 * picked from SportsArc and gets a notification (user set). By email: it
 * waits for whoever signs in with that email (GET /api/my/org-invites); an
 * email that already has an account is turned into an in-app invite. The
 * email is shown only to the org's owners and admins, and never logged.
 */

import { Entity, ManyToOne, PrimaryKey, Property, Unique } from "@mikro-orm/core";
import { randomUUID } from "node:crypto";
import { User } from "../entities/User.js";
import { Organization } from "./Organization.js";
import type { OrgRole } from "./OrgMember.js";

@Entity({ tableName: "org_invites" })
@Unique({ properties: ["org", "email"] })
@Unique({ properties: ["org", "user"] })
export class OrgInvite {
  @PrimaryKey({ type: "uuid" })
  id: string = randomUUID();

  @ManyToOne(() => Organization, { deleteRule: "cascade" })
  org!: Organization;

  /** Who it is for, when they already have an account. */
  @ManyToOne(() => User, { nullable: true, deleteRule: "cascade" })
  user?: User | null;

  /** For someone not on SportsArc yet. Lowercased, trimmed (normalizeEmail in auth/otp.ts). */
  @Property({ type: "string", length: 254, nullable: true })
  email?: string | null;

  /** admin or staff; ownership is never handed out by invite. */
  @Property({ type: "string", length: 16 })
  role!: OrgRole;

  @ManyToOne(() => User, { nullable: true, deleteRule: "set null" })
  invitedBy?: User | null;

  @Property({ type: "timestamptz", onCreate: () => new Date() })
  createdAt: Date = new Date();
}
