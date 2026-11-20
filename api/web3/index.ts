/**
 * Web3 route modules. Each web3 area owns one directory
 * here and registers its routes at import time, so parallel sessions never
 * edit server.ts or this file. Add a line only when a workstream is created.
 *
 * Background jobs start from startWeb3Timers(), which server.ts calls once
 * the database is up. Importing a module never starts a timer, so scripts
 * and checks can import freely.
 */

import type { EntityManager } from "@mikro-orm/postgresql";
import { startRecordTimer } from "./record/timer.js";
import { startCctpTimer } from "./cctp/timer.js";
import { startEventTimer } from "./events/timer.js";
import { startGatewayPayouts } from "./gateway/timer.js";

import "./wallet/routes.js";
import "./record/routes.js";
import "./cctp/routes.js";
import "./pay/routes.js";
import "./gateway/routes.js";
import "./events/routes.js";

export function startWeb3Timers(fork: () => EntityManager): void {
  // Batches closed check-ins and posts their roots; idle until configured.
  startRecordTimer(fork);
  // Advances CCTP transfers in flight; never signs, so it cannot move money.
  startCctpTimer(fork());
  // Forwards routed event payments to the chain each player chose (Circle
  // Gateway); idle until PAYOUT_PRIVATE_KEY is set and WEB3_CHAIN is one it serves.
  startGatewayPayouts(fork);
  // Records event calls in flight, follows each event's status on chain and
  // pays everyone out once it settles; idle until EVENT_VAULT_ADDRESS is set.
  startEventTimer(fork);
}
