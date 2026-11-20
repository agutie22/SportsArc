/**
 * Turns money arriving at the payout wallet into payouts. EventVault emits
 * RoutedPayout(gameId, player, amount) each time it pays a routed entry's
 * money to the payout wallet (an entry fee returned, a prize, whoever
 * submitted the transaction). This reads those events and writes one
 * GatewayPayout per event, addressed to the chain and address the player
 * chose when they entered (EventEntry).
 *
 * The chain is the record: a payout exists only for an event that happened,
 * for exactly its amount, and `sourceKey` (chain, tx, log index) makes each
 * event pay once however often it is read. A cursor per contract
 * (GatewayScan) remembers how far the scan has got; the first run starts at
 * GATEWAY_SCAN_FROM_BLOCK, or a little behind the head.
 *
 * An event whose seat this database does not know (it should not happen:
 * routed entries are only built by events.ts) is logged and left: the money
 * stays in the payout wallet until someone looks.
 */

import type { EntityManager } from "@mikro-orm/postgresql";
import { UniqueConstraintViolationException } from "@mikro-orm/core";
import { getAddress, parseAbiItem, type Address, type Hex } from "viem";
import type { Game } from "../../entities/Game.js";
import type { User } from "../../entities/User.js";
import { log } from "../../ops/log.js";
import { publicClient, web3ChainKey, WEB3_CHAINS } from "../chains.js";
import { contractAddress } from "../contracts.js";
import { EventEntry } from "../events/EventEntry.js";
import { EventTerms } from "../events/EventTerms.js";
import { payoutChainByKey } from "./config.js";
import { GatewayPayout } from "./GatewayPayout.js";
import { GatewayScan } from "./GatewayScan.js";

export const routedPayoutEvent = parseAbiItem(
  "event RoutedPayout(bytes32 indexed gameId, address indexed player, uint256 amount)",
);

const CHUNK = 2_000n;
const MAX_CHUNKS = 25;
const FIRST_RUN_LOOKBACK = 2_000n;

export interface RoutedEvent {
  chainId: number;
  /** The contract that emitted it. */
  source: string;
  gameKey: Hex;
  player: string;
  amount: bigint;
  txHash: Hex;
  logIndex: number;
}

interface RoutedSeat {
  user: User;
  game: Game;
  account: string;
  payoutChainKey?: string | null;
  payoutAddress?: string | null;
}

/** Whose money an event carries: the entry of the player it names. */
async function seatFor(em: EntityManager, ev: RoutedEvent): Promise<RoutedSeat | null> {
  const account = getAddress(ev.player);
  const terms = await em.findOne(
    EventTerms, { chainId: ev.chainId, vaultAddress: getAddress(ev.source), eventKey: ev.gameKey }, { populate: ["game"] },
  );
  if (!terms) return null;
  const entry = await em.findOne(EventEntry, { terms, playerAddress: account }, { populate: ["user"] });
  return entry
    ? { user: entry.user, game: terms.game, account, payoutChainKey: entry.payoutChainKey, payoutAddress: entry.payoutAddress }
    : null;
}

/** Write the payout for one event. False when it was already there or cannot be matched. */
export async function recordRoutedEvent(em: EntityManager, ev: RoutedEvent): Promise<boolean> {
  const sourceKey = `${ev.chainId}:${ev.txHash.toLowerCase()}:${ev.logIndex}`;
  if (await em.count(GatewayPayout, { sourceKey })) return false;
  const seat = await seatFor(em, ev);
  if (!seat) {
    log.error("routed payout has no matching entry; money stays in the payout wallet", { sourceKey });
    return false;
  }
  const row = new GatewayPayout();
  row.user = seat.user;
  row.game = seat.game;
  row.sourceKey = sourceKey;
  row.amount = ev.amount.toString();
  if (seat.payoutChainKey && seat.payoutAddress && payoutChainByKey(seat.payoutChainKey)) {
    row.destChainKey = seat.payoutChainKey;
    row.destAddress = getAddress(seat.payoutAddress);
  } else {
    // Routed on chain but no usable choice on file: pay the SportsArc wallet.
    row.destChainKey = seat.payoutChainKey ?? "unknown";
    row.destAddress = getAddress(seat.payoutAddress ?? seat.account);
    row.state = "fallback_pending";
    row.fallbackReason = "That network is no longer available.";
  }
  try {
    await em.insert(row);
  } catch (err) {
    if (err instanceof UniqueConstraintViolationException) return false;
    throw err;
  }
  log.info("payout queued", { payoutId: row.id, userId: seat.user.id, chain: row.destChainKey });
  return true;
}

/** Read new RoutedPayout events from the EventVault. Returns how many payouts it queued. */
export async function scanRoutedPayouts(em: EntityManager): Promise<number> {
  const raw = contractAddress("eventVault");
  return raw ? scanContract(em, getAddress(raw)) : 0;
}

async function scanContract(em: EntityManager, source: Address): Promise<number> {
  const chainId = WEB3_CHAINS[web3ChainKey()].id;
  const client = publicClient();
  const head = await client.getBlockNumber();

  const scanKey = `${chainId}:${source}`;
  let cursor = await em.findOne(GatewayScan, { scanKey });
  let from: bigint;
  if (cursor) {
    from = BigInt(cursor.blockNumber) + 1n;
  } else {
    const env = process.env.GATEWAY_SCAN_FROM_BLOCK?.trim() ?? "";
    from = /^\d{1,18}$/.test(env) ? BigInt(env) : head > FIRST_RUN_LOOKBACK ? head - FIRST_RUN_LOOKBACK : 0n;
    cursor = new GatewayScan();
    cursor.scanKey = scanKey;
    cursor.blockNumber = (from > 0n ? from - 1n : 0n).toString();
    em.persist(cursor);
  }

  let queued = 0;
  for (let i = 0; i < MAX_CHUNKS && from <= head; i++) {
    const to = from + CHUNK - 1n > head ? head : from + CHUNK - 1n;
    const logs = await client.getLogs({ address: source, event: routedPayoutEvent, fromBlock: from, toBlock: to });
    for (const l of logs) {
      if (l.transactionHash === null || l.logIndex === null) continue;
      const { gameId, player, amount } = l.args;
      if (!gameId || !player || amount === undefined) continue;
      const fresh = await recordRoutedEvent(em, {
        chainId, source, gameKey: gameId, player, amount, txHash: l.transactionHash, logIndex: l.logIndex,
      });
      if (fresh) queued++;
    }
    cursor.blockNumber = to.toString();
    await em.flush();
    from = to + 1n;
  }
  return queued;
}
