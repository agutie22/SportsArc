/**
 * A person on an organization's staff, with a role (roles.ts says what each
 * role may do). Members are adults: the accept and create paths check it.
 */

import { Entity, ManyToOne, PrimaryKey, Property, Unique } from "@mikro-orm/core";
import { randomUUID } from "node:crypto";
import { User } from "../entities/User.js";
import { Organization } from "./Organization.js";

export const ORG_ROLES = ["owner", "admin", "staff"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export function isOrgRole(value: unknown): value is OrgRole {
  return typeof value === "string" && (ORG_ROLES as readonly string[]).includes(value);
}

@Entity({ tableName: "org_members" })
@Unique({ properties: ["org", "user"] })
export class OrgMember {
  @PrimaryKey({ type: "uuid" })
  id: string = randomUUID();

  @ManyToOne(() => Organization, { deleteRule: "cascade" })
  org!: Organization;

  @ManyToOne(() => User, { deleteRule: "cascade" })
  user!: User;

  @Property({ type: "string", length: 16 })
  role!: OrgRole;

  @ManyToOne(() => User, { nullable: true, deleteRule: "set null" })
  addedBy?: User | null;

  @Property({ type: "timestamptz", onCreate: () => new Date() })
  createdAt: Date = new Date();
}
