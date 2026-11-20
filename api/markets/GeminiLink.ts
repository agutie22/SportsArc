/**
 * A user's connected Gemini account: the OAuth tokens SportsArc uses to
 * trade for them. One per user.
 *
 * Both tokens are sealed (seal.ts) with GEMINI_TOKEN_KEY and never leave the
 * server. Gemini's refresh token works once: every refresh returns a new
 * one, and both are saved together under a row lock (oauth.ts), or a second
 * request racing the first would spend the old one and disconnect the user.
 */

import { Entity, ManyToOne, PrimaryKey, Property, Unique } from "@mikro-orm/core";
import { randomUUID } from "node:crypto";
import { User } from "../entities/User.js";

@Entity({ tableName: "gemini_links" })
@Unique({ properties: ["user"] })
export class GeminiLink {
  @PrimaryKey({ type: "uuid" })
  id: string = randomUUID();

  @ManyToOne(() => User, { deleteRule: "cascade" })
  user!: User;

  /** "sandbox" or "production": which Gemini the tokens belong to. */
  @Property({ type: "string", length: 16 })
  env!: string;

  @Property({ type: "text" })
  accessToken!: string;

  @Property({ type: "text" })
  refreshToken!: string;

  @Property({ type: "timestamptz" })
  accessExpiresAt!: Date;

  @Property({ type: "string", length: 255 })
  scopes!: string;

  /** The version of Gemini's prediction market terms the user accepted. */
  @Property({ type: "string", length: 64, nullable: true })
  termsVersion?: string | null;

  /** Settled positions up to here have been turned into notifications. */
  @Property({ type: "timestamptz", nullable: true })
  settledSeenAt?: Date | null;

  @Property({ type: "timestamptz", onCreate: () => new Date() })
  createdAt: Date = new Date();

  @Property({ type: "timestamptz", onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date();
}
