import { Entity, Index, ManyToOne, PrimaryKey, Property, Unique } from "@mikro-orm/core";
import { randomUUID } from "node:crypto";
import { User } from "./User.js";

/** username: sign-in with a Circle PIN instead of a code (auth/pin-login.ts). */
export const IDENTIFIER_KINDS = ["email", "phone", "username"] as const;
export type IdentifierKind = (typeof IDENTIFIER_KINDS)[number];

/** Login id. Capitals do not make a second account (kind + lower(value)). */
@Entity({ tableName: "user_identifiers" })
@Unique({ properties: ["kind", "value"] })
@Index({
  name: "user_identifiers_kind_lower_value_unique",
  expression: "create unique index \"user_identifiers_kind_lower_value_unique\" on \"user_identifiers\" (\"kind\", lower(\"value\"))",
})
export class UserIdentifier {
  @PrimaryKey({ type: "uuid" })
  id: string = randomUUID();

  @ManyToOne(() => User, { deleteRule: "cascade" })
  user!: User;

  @Property({ type: "string", length: 16 })
  kind!: IdentifierKind;

  @Property({ type: "string", length: 255 })
  value!: string;

  @Property({ type: "timestamptz", onCreate: () => new Date() })
  createdAt: Date = new Date();
}
