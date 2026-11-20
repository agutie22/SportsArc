/**
 * One event's money terms at one EventVault deployment, and where the event
 * stands. The host signs the terms with their wallet (the vault's
 * `organizer`) and the vault
 * fixes them at createEvent, so nothing here changes once `status` leaves
 * "draft". A redeploy (new chain or address) starts a fresh row.
 *
 *   draft      terms chosen, not on chain yet (the host has not signed,
 *              or the create is still in flight)
 *   open       created on chain; players enter, the host funds the prize
 *   posted     a result is posted and can still be corrected
 *   final      the result stands: fees to the host, prize to the placed
 *   void       too few registered at the start, or too few checked in
 *   cancelled  the host cancelled
 *   expired    no result by the deadline
 *
 * From `open` on, `status` mirrors EventVault.status(); the vault is the
 * record and timer.ts keeps this copy in step. `action` is the one thing the
 * host has been asked to sign and that has not finished: creating the
 * event, posting a result, or cancelling.
 */

import { Entity, Index, ManyToOne, PrimaryKey, Property, Unique } from "@mikro-orm/core";
import { randomUUID } from "node:crypto";
import { Game } from "../../entities/Game.js";
import { User } from "../../entities/User.js";

export const EVENT_STATUSES = ["draft", "open", "posted", "final", "void", "cancelled", "expired"] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

export const EVENT_ACTIONS = ["create", "result", "cancel"] as const;
export type EventAction = (typeof EVENT_ACTIONS)[number];

/** What a "result" action will post, kept until its transaction is mined. */
export interface ResultPayload {
  /** Placed players' user ids, first place first. */
  userIds: string[];
  attendees: number;
}

@Entity({ tableName: "event_terms" })
@Unique({ properties: ["game", "chainId", "vaultAddress"] })
@Index({ properties: ["status", "settledAt"] })
export class EventTerms {
  @PrimaryKey({ type: "uuid" })
  id: string = randomUUID();

  @ManyToOne(() => Game, { deleteRule: "cascade" })
  game!: Game;

  @Property({ type: "int" })
  chainId!: number;

  /** Checksummed EventVault address every signature is for. */
  @Property({ type: "string", length: 42 })
  vaultAddress!: string;

  /** gameKey(game.id) from ../ids.ts; the only event identifier on chain. */
  @Property({ type: "string", length: 66 })
  eventKey!: string;

  /** Who signed the terms and is paid the entry fees. */
  @ManyToOne(() => User, { deleteRule: "cascade" })
  organizer!: User;

  /** The host's wallet when they signed: the vault's `organizer`. */
  @Property({ type: "string", length: 42 })
  organizerAddress!: string;

  /** USDC base units (6 decimals); 0 for an event that is free to enter. */
  @Property({ type: "bigint" })
  entryFee!: bigint;

  /** Fewer registered than this at the start and the event is void. */
  @Property({ type: "int" })
  minEntrants!: number;

  /** Fewer checked in than this and the event is void. */
  @Property({ type: "int" })
  minAttendees!: number;

  @Property({ type: "timestamptz" })
  startsAt!: Date;

  @Property({ type: "timestamptz" })
  registrationClosesAt!: Date;

  @Property({ type: "timestamptz" })
  resultDeadline!: Date;

  /**
   * Basis points per place, first place first, for an event that takes a
   * prize; null for a ticketed event, which takes none. The server only
   * signs a prize permit carrying this split.
   */
  @Property({ type: "json", nullable: true })
  split?: number[] | null;

  @Property({ type: "string", length: 16 })
  status: EventStatus = "draft";

  // ── the organizer's action in flight ──

  @Property({ type: "string", length: 16, nullable: true })
  action?: EventAction | null;

  /** The UserSignature the organizer was asked for. */
  @Property({ type: "uuid", nullable: true })
  actionSignatureId?: string | null;

  /** Set once the relayer has sent it. */
  @Property({ type: "string", length: 66, nullable: true })
  actionTxHash?: string | null;

  @Property({ type: "json", nullable: true })
  actionPayload?: ResultPayload | null;

  // ── on chain ──

  @Property({ type: "string", length: 66, nullable: true })
  createTxHash?: string | null;

  /** The result as last posted: placed players' user ids, first place first. */
  @Property({ type: "json", nullable: true })
  placements?: string[] | null;

  /** Players who checked in, as posted. */
  @Property({ type: "int", nullable: true })
  attendees?: number | null;

  @Property({ type: "string", length: 66, nullable: true })
  resultTxHash?: string | null;

  /** When the posted result stops being correctable (first post + the vault's window). */
  @Property({ type: "timestamptz", nullable: true })
  finalAt?: Date | null;

  @Property({ type: "string", length: 66, nullable: true })
  cancelTxHash?: string | null;

  // ── settlement ──

  /** Entry fees paid to the organizer, after the platform fee; base units. */
  @Property({ type: "string", length: 78, nullable: true })
  organizerPayout?: string | null;

  /** The platform fee taken from this event's entry fees; base units. */
  @Property({ type: "string", length: 78, nullable: true })
  feeTaken?: string | null;

  @Property({ type: "string", length: 66, nullable: true })
  organizerTxHash?: string | null;

  /** Everything this event owes anyone has been paid. */
  @Property({ type: "timestamptz", nullable: true })
  settledAt?: Date | null;

  @Property({ type: "timestamptz", onCreate: () => new Date() })
  createdAt: Date = new Date();

  @Property({ type: "timestamptz", onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date();
}
