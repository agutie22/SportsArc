/**
 * The Pro markets entities, spread into mikro-orm.config.ts.
 */

import type { EntityClass } from "@mikro-orm/core";
import { GeminiLink } from "./GeminiLink.js";
import { MarketTick } from "./MarketTick.js";
import { PicksSeen } from "./PicksSeen.js";
import { PortfolioSnapshot } from "./PortfolioSnapshot.js";
import { PracticeFill } from "./PracticeFill.js";

export const MARKETS_ENTITIES: EntityClass<any>[] = [GeminiLink, MarketTick, PicksSeen, PortfolioSnapshot, PracticeFill];
