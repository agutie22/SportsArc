import { Entity, Index, PrimaryKey, Property } from "@mikro-orm/core";
import { randomUUID } from "node:crypto";
import type { IdentifierKind } from "./UserIdentifier.js";

@Entity({ tableName: "otp_challenges" })
@Index({ properties: ["kind", "value"] })
export class OtpChallenge {
  @PrimaryKey({ type: "uuid" })
  id: string = randomUUID();

  @Property({ type: "string", length: 16 })
  kind!: IdentifierKind;

  @Property({ type: "string", length: 255 })
  value!: string;

  @Property({ type: "string", length: 64 })
  codeHash!: string;

  @Property({ type: "timestamptz" })
  expiresAt!: Date;

  @Property({ type: "int" })
  attempts: number = 0;

  @Property({ type: "timestamptz", onCreate: () => new Date() })
  createdAt: Date = new Date();
}
