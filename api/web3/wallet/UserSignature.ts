/**
 * Typed data (EIP-712) a user was asked to sign with their PIN, and the
 * signature once the browser posts it back. The server builds the data and
 * keeps it here, so what gets verified and relayed is what the server asked
 * for, never something the browser supplies.
 *
 *   awaiting_signature -> signed
 *
 * A request nobody signs just stays behind: it authorizes nothing.
 */

import { Entity, Index, ManyToOne, PrimaryKey, Property } from "@mikro-orm/core";
import { randomUUID } from "node:crypto";
import { User } from "../../entities/User.js";

export const SIGNATURE_STATUSES = ["awaiting_signature", "signed"] as const;
export type SignatureStatus = (typeof SIGNATURE_STATUSES)[number];

@Entity({ tableName: "user_signatures" })
@Index({ properties: ["user", "createdAt"] })
export class UserSignature {
  @PrimaryKey({ type: "uuid" })
  id: string = randomUUID();

  @ManyToOne(() => User, { deleteRule: "cascade" })
  user!: User;

  /** What it authorizes, set by the caller: "payment", "event_entry", ... */
  @Property({ type: "string", length: 32 })
  kind!: string;

  @Property({ type: "string", length: 24 })
  status: SignatureStatus = "awaiting_signature";

  /** The wallet that must have signed. */
  @Property({ type: "string", length: 42 })
  signerAddress!: string;

  /** The typed data as sent to Circle: JSON, numbers as decimal strings. */
  @Property({ type: "text" })
  typedData!: string;

  @Property({ type: "string", length: 64 })
  challengeId!: string;

  @Property({ type: "string", length: 132, nullable: true })
  signature?: string | null;

  @Property({ type: "timestamptz", onCreate: () => new Date() })
  createdAt: Date = new Date();

  @Property({ type: "timestamptz", nullable: true })
  signedAt?: Date | null;
}
