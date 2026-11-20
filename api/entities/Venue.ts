import { Entity, Index, ManyToOne, PrimaryKey, Property } from "@mikro-orm/core";
import { randomUUID } from "node:crypto";
import { User } from "./User.js";

export const VENUE_KINDS = ["park", "gym", "field", "court", "other"] as const;
export type VenueKind = (typeof VENUE_KINDS)[number];

@Entity({ tableName: "venues" })
@Index({ properties: ["lat", "lng"] })
export class Venue {
  @PrimaryKey({ type: "uuid" })
  id: string = randomUUID();

  @Property({ type: "string", length: 160 })
  name!: string;

  @Property({ type: "string", length: 255, nullable: true })
  address?: string | null;

  @Property({ type: "double" })
  lat!: number;

  @Property({ type: "double" })
  lng!: number;

  @Property({ type: "string", length: 16 })
  kind: VenueKind = "park";

  @Property({ type: "boolean" })
  indoor: boolean = false;

  @ManyToOne(() => User, { nullable: true, deleteRule: "set null" })
  createdBy?: User | null;

  @Property({ type: "timestamptz", onCreate: () => new Date() })
  createdAt: Date = new Date();
}

export function isVenueKind(value: string): value is VenueKind {
  return (VENUE_KINDS as readonly string[]).includes(value);
}
