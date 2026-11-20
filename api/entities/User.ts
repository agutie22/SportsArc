import { Collection, Entity, Index, OneToMany, PrimaryKey, Property, Cascade, Unique } from "@mikro-orm/core";
import { randomUUID } from "node:crypto";
import { UserIdentifier } from "./UserIdentifier.js";

export const USER_ROLES = ["scout", "coach", "player"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_AUDIENCES = ["adult", "minor", "guardian"] as const;
export type UserAudience = (typeof USER_AUDIENCES)[number];

/** Public name. "Alex" and "alex" are one identity (users_name_lower_unique). */
@Entity({ tableName: "users" })
@Index({
  name: "users_name_lower_unique",
  expression: "create unique index \"users_name_lower_unique\" on \"users\" (lower(\"name\")) where \"name\" is not null",
})
export class User {
  @PrimaryKey({ type: "uuid" })
  id: string = randomUUID();

  @Property({ type: "string", length: 255, nullable: true })
  name?: string | null;

  @Property({ type: "string", length: 32, nullable: true })
  role?: string | null;

  @Property({ type: "string", length: 255, nullable: true })
  headline?: string | null;

  @Property({ type: "string", length: 32, nullable: true })
  audience?: string | null;

  // ── profile (the professional, LinkedIn-shaped half of the product) ──

  @Property({ type: "text", nullable: true })
  bio?: string | null;

  /** Free-text area, e.g. "San Gabriel Valley, CA". */
  @Property({ type: "string", length: 120, nullable: true })
  location?: string | null;

  @Property({ type: "string", length: 24, nullable: true })
  primarySport?: string | null;

  @Property({ type: "string", length: 32, nullable: true })
  position?: string | null;

  /** Graduating class, e.g. "2027". Kept as text — formats vary by sport. */
  @Property({ type: "string", length: 16, nullable: true })
  classYear?: string | null;

  @Property({ type: "string", length: 160, nullable: true })
  school?: string | null;

  /** The team whose colors the app wears for this person, e.g. "cfb:251" (api/teams/catalog.ts). */
  @Property({ type: "string", length: 32, nullable: true })
  teamKey?: string | null;

  @Property({ type: "int", nullable: true })
  heightInches?: number | null;

  @Property({ type: "int", nullable: true })
  weightLbs?: number | null;

  /** Uploaded images, as /uploads/... URLs served by this API. */
  @Property({ type: "string", length: 80, nullable: true })
  avatarUrl?: string | null;

  @Property({ type: "string", length: 80, nullable: true })
  coverUrl?: string | null;

  /**
   * The verified record's games (venues and times) are visible from the
   * profile. True hides that list; the show-up count stays, and a share
   * link the player creates still opens the games.
   */
  @Property({ type: "boolean", default: false })
  recordPrivate: boolean = false;

  /** A pinned highlight video (YouTube, Vimeo or Hudl link). */
  @Property({ type: "string", length: 300, nullable: true })
  highlightUrl?: string | null;

  /** Highlight reels and profiles elsewhere: [{ label, url }]. */
  @Property({ type: "json", nullable: true })
  links?: { label: string; url: string }[] | null;

  @Unique()
  @Property({ type: "string", length: 64, nullable: true })
  circleUserId?: string | null;

  @Property({ type: "string", length: 42, nullable: true })
  walletAddress?: string | null;

  @Property({ type: "timestamptz", onCreate: () => new Date() })
  createdAt: Date = new Date();

  @Property({ type: "timestamptz", onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date();

  @OneToMany(() => UserIdentifier, (ident) => ident.user, {
    cascade: [Cascade.PERSIST, Cascade.REMOVE],
  })
  identifiers = new Collection<UserIdentifier>(this);
}

export function isUserRole(value: string): value is UserRole {
  return (USER_ROLES as readonly string[]).includes(value);
}

export function isUserAudience(value: string): value is UserAudience {
  return (USER_AUDIENCES as readonly string[]).includes(value);
}

export function profileComplete(user: User): boolean {
  return Boolean(user.name?.trim() && isUserRole(user.role ?? "") && isUserAudience(user.audience ?? ""));
}

/** Circle userIds must be alphanumeric (no hyphens). */
export function circleUserIdFor(user: User): string {
  return user.circleUserId || user.id.replace(/-/g, "");
}
