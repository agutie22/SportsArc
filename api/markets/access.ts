/**
 * Who may see and trade Pro markets: adults only.
 *
 * A minor gets no market data from any endpoint, and posts lose their
 * market card for them. Guardians are adults. A profile with no audience set
 * yet is treated as not allowed until the user says who they are.
 *
 * Gemini decides everything else about eligibility (it serves US accounts
 * only and refuses others with ACCOUNT_GROUP_BLOCKED); this is SportsArc's
 * own rule, on top of that. Keep any new market surface behind it.
 */

import type { User } from "../entities/User.js";
import { fail, type Failure } from "../failure.js";
import { config } from "./config.js";

export function canTradeMarkets(user: Pick<User, "audience"> | null | undefined): boolean {
  return user?.audience === "adult" || user?.audience === "guardian";
}

/** Null when `user` may use Pro markets, else why not. */
export function marketsGate(user: Pick<User, "audience"> | null | undefined, enabled = config().enabled): Failure | null {
  if (!enabled) return fail("MARKETS_NOT_ALLOWED", "Pro markets are not switched on.");
  if (!canTradeMarkets(user)) return fail("MARKETS_NOT_ALLOWED", "Pro markets are for adults only.");
  return null;
}
