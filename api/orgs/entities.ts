/**
 * The organization entities, spread into mikro-orm.config.ts.
 */

import type { EntityClass } from "@mikro-orm/core";
import { OrgInvite } from "./OrgInvite.js";
import { OrgMember } from "./OrgMember.js";
import { Organization } from "./Organization.js";
import { Sponsorship } from "./Sponsorship.js";

export const ORG_ENTITIES: EntityClass<any>[] = [Organization, OrgMember, OrgInvite, Sponsorship];
