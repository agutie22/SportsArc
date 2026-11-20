/**
 * How far inbox.ts has read one contract's RoutedPayout events. One row per
 * contract; `scanKey` is "<chainId>:<address>".
 */

import { Entity, PrimaryKey, Property, Unique } from "@mikro-orm/core";
import { randomUUID } from "node:crypto";

@Entity({ tableName: "gateway_scans" })
@Unique({ properties: ["scanKey"] })
export class GatewayScan {
  @PrimaryKey({ type: "uuid" })
  id: string = randomUUID();

  @Property({ type: "string", length: 80 })
  scanKey!: string;

  /** The last block fully read, as a decimal string. */
  @Property({ type: "string", length: 30 })
  blockNumber!: string;

  @Property({ type: "timestamptz", onCreate: () => new Date() })
  createdAt: Date = new Date();

  @Property({ type: "timestamptz", onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date();
}
