/**
 * The relayer's nonce mark, shared by every API instance (nonce.ts): one
 * past the last nonce any instance broadcast for this address and chain.
 * Read and written only under the lane's Postgres advisory lock.
 *
 * `genesis` is the chain's block-0 hash when the mark was written, so a
 * mark left by an earlier chain with the same id (a testnet that was reset)
 * is never trusted on a new one.
 */

import { Entity, PrimaryKey, Property } from "@mikro-orm/core";

@Entity({ tableName: "relayer_nonces" })
export class RelayerNonce {
  /** Lower-case 0x address. */
  @PrimaryKey({ type: "string", length: 42 })
  address!: string;

  @PrimaryKey({ type: "int" })
  chainId!: number;

  @Property({ type: "string", length: 66 })
  genesis!: string;

  @Property({ type: "bigint" })
  nextNonce!: string;

  @Property({ type: "timestamptz" })
  updatedAt: Date = new Date();
}
