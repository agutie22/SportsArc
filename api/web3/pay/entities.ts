/**
 * MikroORM entities owned by the `pay` area. The aggregate in
 * ../entities.ts picks them up.
 */

import type { EntityClass } from "@mikro-orm/core";
import { Payment } from "./Payment.js";

export const entities: EntityClass<any>[] = [Payment];
