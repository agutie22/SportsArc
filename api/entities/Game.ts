import { Entity, Index, ManyToOne, PrimaryKey, Property } from "@mikro-orm/core";
import { randomUUID } from "node:crypto";
import { User } from "./User.js";
import { Venue } from "./Venue.js";
import { Season } from "../leagues/Season.js";
import { Team } from "../leagues/Team.js";

export const SPORTS = [
  "basketball", "soccer", "football", "volleyball",
  "baseball", "softball", "tennis", "pickleball", "hockey", "other",
] as const;
export type Sport = (typeof SPORTS)[number];

export const SKILL_LEVELS = ["any", "beginner", "intermediate", "advanced"] as const;
export type SkillLevel = (typeof SKILL_LEVELS)[number];

export const GAME_STATUSES = ["open", "full", "cancelled", "played"] as const;
export type GameStatus = (typeof GAME_STATUSES)[number];

/**
 * pickup: free, anyone joins. event: people pay the host to enter, play for
 * a prize the host put up, or both; its money terms live in web3/events
 * (EventTerms) and its seats are taken by entering there, not by joining.
 * league: a fixture in a league season between two teams (api/leagues). It
 * is made by the schedule, never by hand; its seats are the two rosters,
 * home on side 0 and away on side 1, so nobody joins it.
 */
export const GAME_KINDS = ["pickup", "event", "league"] as const;
export type GameKind = (typeof GAME_KINDS)[number];

export const GAME_VISIBILITIES = ["public", "invite"] as const;
export type GameVisibility = (typeof GAME_VISIBILITIES)[number];

@Entity({ tableName: "games" })
@Index({ properties: ["startsAt"] })
@Index({ properties: ["sport", "startsAt"] })
export class Game {
  @PrimaryKey({ type: "uuid" })
  id: string = randomUUID();

  /**
   * The host: whoever created the game, for its whole life. They run it,
   * name co-hosts, record the result, and are paid for a charged game. The
   * role never passes to anyone else.
   */
  @ManyToOne(() => User, { deleteRule: "cascade" })
  host!: User;

  /**
   * "I'm playing" at creation. False: the host took no seat and no slot;
   * they can still join later like anyone else.
   */
  @Property({ type: "boolean", default: true })
  hostPlays: boolean = true;

  @ManyToOne(() => Venue, { deleteRule: "restrict" })
  venue!: Venue;

  @Property({ type: "string", length: 24 })
  sport!: Sport;

  @Property({ type: "string", length: 16, default: "pickup" })
  kind: GameKind = "pickup";

  @Property({ type: "timestamptz" })
  startsAt!: Date;

  @Property({ type: "int" })
  durationMinutes: number = 90;

  /** Total player slots; the host takes one only if they play. */
  @Property({ type: "int" })
  capacity: number = 10;

  @Property({ type: "string", length: 16 })
  skillLevel: SkillLevel = "any";

  @Property({ type: "string", length: 16 })
  visibility: GameVisibility = "public";

  @Property({ type: "string", length: 16 })
  status: GameStatus = "open";

  @Property({ type: "string", length: 500, nullable: true })
  notes?: string | null;

  /** A league fixture's season and teams (kind "league"); null otherwise. */
  @ManyToOne(() => Season, { nullable: true, deleteRule: "set null" })
  season?: Season | null;

  /** Plays as side 0. */
  @ManyToOne(() => Team, { nullable: true, deleteRule: "set null" })
  homeTeam?: Team | null;

  /** Plays as side 1. */
  @ManyToOne(() => Team, { nullable: true, deleteRule: "set null" })
  awayTeam?: Team | null;

  @Property({ type: "timestamptz", onCreate: () => new Date() })
  createdAt: Date = new Date();

  @Property({ type: "timestamptz", onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date();
}

export function isSport(v: string): v is Sport {
  return (SPORTS as readonly string[]).includes(v);
}
export function isSkillLevel(v: string): v is SkillLevel {
  return (SKILL_LEVELS as readonly string[]).includes(v);
}
export function isGameKind(v: string): v is GameKind {
  return (GAME_KINDS as readonly string[]).includes(v);
}
export function isGameVisibility(v: string): v is GameVisibility {
  return (GAME_VISIBILITIES as readonly string[]).includes(v);
}
