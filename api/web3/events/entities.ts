/**
 * MikroORM entities owned by the `events` workstream. List them here; the
 * aggregate in ../entities.ts picks them up.
 */

import type { EntityClass } from "@mikro-orm/core";
import { EventTerms } from "./EventTerms.js";
import { EventEntry } from "./EventEntry.js";
import { EventPrize } from "./EventPrize.js";

export const entities: EntityClass<any>[] = [EventTerms, EventEntry, EventPrize];
