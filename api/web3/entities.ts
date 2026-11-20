/**
 * MikroORM entities owned by web3 workstreams, gathered for
 * mikro-orm.config.ts. Workstreams edit their own entities.ts, not this.
 */

import { entities as wallet } from "./wallet/entities.js";
import { entities as record } from "./record/entities.js";
import { entities as cctp } from "./cctp/entities.js";
import { entities as pay } from "./pay/entities.js";
import { entities as gateway } from "./gateway/entities.js";
import { entities as events } from "./events/entities.js";

export const WEB3_ENTITIES = [
  ...wallet, ...record, ...cctp, ...pay, ...gateway, ...events,
];
