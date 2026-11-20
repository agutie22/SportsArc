/**
 * The tryout entities, spread into mikro-orm.config.ts.
 */

import type { EntityClass } from "@mikro-orm/core";
import { Tryout } from "./Tryout.js";
import { TryoutMark } from "./TryoutMark.js";

export const TRYOUT_ENTITIES: EntityClass<any>[] = [Tryout, TryoutMark];
