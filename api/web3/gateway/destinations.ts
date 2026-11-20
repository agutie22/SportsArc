/**
 * Where a player may be paid: their SportsArc wallet (the default, and what
 * "no choice" means), or an address on another chain. A choice made once is
 * saved as a PayoutDestination so the next one is a tap.
 *
 * Handlers return result objects; routes.ts maps codes.
 */

import type { EntityManager } from "@mikro-orm/postgresql";
import { getAddress, isAddress, isAddressEqual, zeroAddress, type Address } from "viem";
import type { User } from "../../entities/User.js";
import { fail, type Failure } from "../../failure.js";
import { explorerFor } from "../cctp/config.js";
import { isUuid } from "../../validate.js";
import { payoutChainByKey, payoutChains, payoutSource } from "./config.js";
import { PayoutDestination } from "./PayoutDestination.js";

const MAX_SAVED = 10;

/** A resolved choice of another chain; null everywhere means the SportsArc wallet. */
export interface PayoutChoice {
  chainKey: string;
  address: Address;
}

export function destinationView(d: PayoutDestination) {
  const chain = payoutChainByKey(d.chainKey);
  return { id: d.id, chain: d.chainKey, chainName: chain?.name ?? d.chainKey, address: d.address };
}

/** The chains a payout can go to, and the player's saved addresses. */
export async function payoutOptions(em: EntityManager, user: User) {
  const source = payoutSource();
  const saved = await em.find(PayoutDestination, { user }, { orderBy: { updatedAt: "DESC" } });
  return {
    ok: true as const,
    available: source !== null,
    home: source ? { chain: source.key, chainName: source.name } : null,
    chains: payoutChains().map((c) => ({ key: c.key, name: c.name, chainId: c.chainId, explorer: explorerFor(c) })),
    saved: saved.filter((d) => payoutChainByKey(d.chainKey)).map(destinationView),
  };
}

/**
 * Turn what the browser sent into a choice. Absent, null or "wallet" is the
 * SportsArc wallet (null). Otherwise { destinationId } names a saved address,
 * or { chain, address } a new one, which is saved.
 */
export async function resolveChoice(
  em: EntityManager,
  user: User,
  raw: unknown,
): Promise<{ ok: true; choice: PayoutChoice | null } | Failure> {
  if (raw === undefined || raw === null || raw === "wallet") return { ok: true, choice: null };
  if (typeof raw !== "object") return fail("VALIDATION_ERROR", "payout is \"wallet\", { destinationId } or { chain, address }.");
  const body = raw as { destinationId?: unknown; chain?: unknown; address?: unknown };

  if (body.destinationId !== undefined) {
    const id = typeof body.destinationId === "string" ? body.destinationId : "";
    const row = isUuid(id) ? await em.findOne(PayoutDestination, { id, user }) : null;
    if (!row || !payoutChainByKey(row.chainKey)) return fail("DESTINATION_NOT_FOUND", "That payout address is not saved.");
    row.updatedAt = new Date(); // most recently used first
    await em.flush();
    return { ok: true, choice: { chainKey: row.chainKey, address: getAddress(row.address) } };
  }

  const chain = payoutChainByKey(body.chain);
  if (!chain) {
    return fail("VALIDATION_ERROR", `chain is one of ${payoutChains().map((c) => c.key).join(", ")}.`);
  }
  const text = typeof body.address === "string" ? body.address.trim() : "";
  if (!isAddress(text, { strict: false })) {
    return fail("VALIDATION_ERROR", "address is an EVM address (0x followed by 40 hex characters).");
  }
  const address = getAddress(text);
  if (isAddressEqual(address, zeroAddress)) return fail("VALIDATION_ERROR", "address cannot be the zero address.");

  const existing = await em.findOne(PayoutDestination, { user, chainKey: chain.key, address });
  if (existing) {
    existing.updatedAt = new Date();
  } else {
    if ((await em.count(PayoutDestination, { user })) >= MAX_SAVED) {
      return fail("TOO_MANY_DESTINATIONS", `You can save up to ${MAX_SAVED} payout addresses. Remove one first.`);
    }
    const row = new PayoutDestination();
    row.user = user;
    row.chainKey = chain.key;
    row.address = address;
    em.persist(row);
  }
  await em.flush();
  return { ok: true, choice: { chainKey: chain.key, address } };
}

export async function removeDestination(em: EntityManager, user: User, id: string) {
  const row = isUuid(id) ? await em.findOne(PayoutDestination, { id, user }) : null;
  if (!row) return fail("DESTINATION_NOT_FOUND", "That payout address is not saved.");
  await em.removeAndFlush(row);
  return { ok: true as const };
}
