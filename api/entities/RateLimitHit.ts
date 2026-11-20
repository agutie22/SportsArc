/**
 * One counted attempt against a rate limit (otp.ts), shared by every API
 * instance. Rows older than the limit's window are pruned as the limit is
 * checked; nothing else reads them.
 */

import { Entity, Index, PrimaryKey, Property } from "@mikro-orm/core";
import { randomUUID } from "node:crypto";

@Entity({ tableName: "rate_limit_hits" })
@Index({ properties: ["bucket", "key", "hitAt"] })
@Index({ properties: ["hitAt"] })
export class RateLimitHit {
  @PrimaryKey({ type: "uuid" })
  id: string = randomUUID();

  /** Which limit: "otp_start", "otp_verify". */
  @Property({ type: "string", length: 32 })
  bucket!: string;

  /** What is limited, e.g. "email:you@example.com". */
  @Property({ type: "string", length: 300 })
  key!: string;

  @Property({ type: "timestamptz" })
  hitAt: Date = new Date();
}
