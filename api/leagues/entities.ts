/**
 * The league entities, spread into mikro-orm.config.ts.
 */

import type { EntityClass } from "@mikro-orm/core";
import { League } from "./League.js";
import { Registration } from "./Registration.js";
import { Season } from "./Season.js";
import { Team } from "./Team.js";
import { TeamMember } from "./TeamMember.js";

export const LEAGUE_ENTITIES: EntityClass<any>[] = [League, Season, Team, TeamMember, Registration];
