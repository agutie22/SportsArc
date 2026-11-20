/**
 * MikroORM entities owned by the `cctp` workstream. List them here; the
 * aggregate in ../entities.ts picks them up.
 */

import type { EntityClass } from "@mikro-orm/core";
import { CctpFunding } from "./CctpFunding.js";
import { CctpTransfer } from "./CctpTransfer.js";

export const entities: EntityClass<any>[] = [CctpTransfer, CctpFunding];
