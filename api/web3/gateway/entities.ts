/**
 * MikroORM entities owned by the `gateway` workstream. List them here; the
 * aggregate in ../entities.ts picks them up.
 */

import type { EntityClass } from "@mikro-orm/core";
import { GatewayPayout } from "./GatewayPayout.js";
import { GatewayScan } from "./GatewayScan.js";
import { PayoutDestination } from "./PayoutDestination.js";

export const entities: EntityClass<any>[] = [GatewayPayout, PayoutDestination, GatewayScan];
