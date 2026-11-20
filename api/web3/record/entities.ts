/**
 * MikroORM entities owned by the verified record (web3/record). List them here; the
 * aggregate in ../entities.ts picks them up.
 */

import type { EntityClass } from "@mikro-orm/core";
import { RecordEntry } from "./RecordEntry.js";
import { RecordShare } from "./RecordShare.js";

export const entities: EntityClass<any>[] = [RecordEntry, RecordShare];
