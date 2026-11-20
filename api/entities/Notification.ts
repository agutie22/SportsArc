import { Entity, Index, ManyToOne, PrimaryKey, Property } from "@mikro-orm/core";
import { randomUUID } from "node:crypto";
import { Game } from "./Game.js";
import { Post } from "./Post.js";
import { User } from "./User.js";

/**
 * like   — actor liked recipient's post (post)
 * reply  — actor replied to recipient's post (post = the reply)
 * follow — actor followed recipient
 * join   — actor joined a game recipient hosts (game)
 * left   — actor left a seat in a game recipient hosts (game)
 * recap  — a game recipient checked in to has a recap (post, game)
 * view   — an adult coach or scout viewed recipient's profile (see discovery.ts)
 * result_settled — the host recorded the result of a game recipient played in (game)
 * game_changed   — a host changed the time, place or size of a game recipient
 *                  joined (actor, game)
 * game_removed   — a host removed recipient from a game (actor, game)
 * cohost_named   — the host named recipient a co-host (actor, game)
 * payout_sent    — money owed to recipient was sent to the chain they chose
 *                  (game; detail: the amount and the chain)
 * payout_wallet  — a payout to another chain could not go out and went to
 *                  recipient's SportsArc wallet instead (game; detail: amount)
 * funds_added    — money recipient sent from an outside wallet on another
 *                  chain reached their SportsArc wallet (detail: amount, chain)
 * paid           — actor sent recipient USDC (detail: amount and note)
 * pay_request    — actor asked recipient for USDC (detail: amount and note)
 * event_result   — a result was posted for an event recipient entered; it can
 *                  be corrected for a while before it pays out (game)
 * event_off      — an event recipient entered or hosts will not pay out:
 *                  cancelled, too few players, or no result (game; detail: why)
 * event_refund   — recipient's entry fee, or prize money they put up, came
 *                  back (game; detail: the amount and why)
 * event_prize    — recipient placed in an event and was paid their share of
 *                  the prize (game; detail: the amount and the place)
 * event_payout   — an event recipient hosts paid them its entry fees
 *                  (game; detail: the amount, the entries and the fee)
 * verified       — recipient's check-in became a verified record (game)
 * market_settled — a Pro market position recipient held settled (detail:
 *                  the label and what it paid)
 * org_invite     — actor invited recipient to an organization's staff
 *                  (detail: "<org name> · <role>"; answered at #/orgs/invites)
 * tryout_invite  — a club invited recipient to register for its tryout
 *                  (actor, game = the tryout's event; detail: "<org> · <tryout>")
 * camp_invite    — a club invited recipient to camp after its tryout
 *                  (actor, game; detail: "<org> · <tryout>")
 * team_added     — actor put recipient on a league team (detail: "<team> ·
 *                  <season>"; opens #/orgs, which lists your teams)
 */
export const NOTIFICATION_KINDS = [
  "like",
  "reply",
  "follow",
  "join",
  "left",
  "recap",
  "view",
  "result_settled",
  "game_changed",
  "game_removed",
  "cohost_named",
  "payout_sent",
  "payout_wallet",
  "funds_added",
  "paid",
  "pay_request",
  "event_result",
  "event_off",
  "event_refund",
  "event_prize",
  "event_payout",
  "verified",
  "market_settled",
  "org_invite",
  "team_added",
  "tryout_invite",
  "camp_invite",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

@Entity({ tableName: "notifications" })
@Index({ properties: ["recipient", "createdAt"] })
export class Notification {
  @PrimaryKey({ type: "uuid" })
  id: string = randomUUID();

  @ManyToOne(() => User, { deleteRule: "cascade" })
  recipient!: User;

  /** Null for platform-generated notifications such as recaps. */
  @ManyToOne(() => User, { nullable: true, deleteRule: "cascade" })
  actor?: User | null;

  @Property({ type: "string", length: 16 })
  kind!: NotificationKind;

  @ManyToOne(() => Post, { nullable: true, deleteRule: "cascade" })
  post?: Post | null;

  @ManyToOne(() => Game, { nullable: true, deleteRule: "cascade" })
  game?: Game | null;

  /** One short line the kind carries, e.g. "$5.00 + $1.25" (money kinds only). */
  @Property({ type: "string", length: 120, nullable: true })
  detail?: string | null;

  @Property({ type: "timestamptz", nullable: true })
  readAt?: Date | null;

  @Property({ type: "timestamptz", onCreate: () => new Date() })
  createdAt: Date = new Date();
}
