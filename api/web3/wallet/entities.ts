/**
 * MikroORM entities owned by the `wallet` workstream. List them here; the
 * aggregate in ../entities.ts picks them up.
 */

import type { EntityClass } from "@mikro-orm/core";
import { UserEvmWallet } from "./UserEvmWallet.js";
import { UserEvmTx } from "./UserEvmTx.js";
import { UserSignature } from "./UserSignature.js";

export const entities: EntityClass<any>[] = [UserEvmWallet, UserEvmTx, UserSignature];
