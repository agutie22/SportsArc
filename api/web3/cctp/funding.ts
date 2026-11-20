/**
 * Adding money from an outside wallet: USDC on another chain, sent straight
 * into the player's SportsArc wallet on Arc over CCTP.
 *
 * The outside wallet (MetaMask or similar, connected in the browser) signs
 * and pays for everything on its own chain: an approval if needed, then one
 * burn carrying the Forwarding Service hook, so Circle mints on Arc and the
 * player needs nothing there. The server never signs and never holds the
 * money. It does two things:
 *
 *   fundingSteps    builds the calls for that wallet to send (the recipient
 *                   is always the caller's own SportsArc wallet) and quotes
 *                   the fee: a fast transfer where Circle offers one, so it
 *                   lands in seconds rather than after the chain finalizes
 *   recordFunding   takes the burn's tx hash and follows it through Iris to
 *                   its arrival, so the app can say "your money is here"
 *
 * A reported tx is only ever believed for what Circle attests: a burn whose
 * mint recipient is this player's wallet on Arc. Anything else is marked
 * failed. Adults and guardians only, like every money path.
 */

import type { EntityManager } from "@mikro-orm/postgresql";
import { encodeFunctionData, formatUnits, getAddress, isAddress, isAddressEqual, zeroHash, type Address, type Hex } from "viem";
import type { User } from "../../entities/User.js";
import { log } from "../../ops/log.js";
import { notify } from "../../social/notifications.js";
import { usd } from "../usd.js";
import { mayTransact } from "../wallet/service.js";
import { tokenMessengerV2Abi, usdcAbi } from "./abi.js";
import { CctpFunding } from "./CctpFunding.js";
import {
  CCTP_TESTNETS, FINALITY_FAST, FINALITY_STANDARD, FORWARD_HOOK_DATA, WITHDRAW_SOURCE,
  cctpChainById, cctpChainByKey, clientFor, explorerFor, walletChainParams, type CctpChain,
} from "./config.js";
import { addressToBytes32, decodeBurnMessage, mintedAmount } from "./message.js";
import { failure } from "./signer.js";
import { cctpDeps, irisDelayMs, parseUsdcAmount } from "./transfer.js";

/** Money arrives on the chain withdrawals leave from. */
const HOME = WITHDRAW_SOURCE;
const GIVE_UP_MS = 24 * 3_600_000;

function walletOf(user: User): Address | null {
  const raw = user.walletAddress?.trim() ?? "";
  return isAddress(raw) ? getAddress(raw) : null;
}

function sourceChain(key: unknown): CctpChain | null {
  const chain = cctpChainByKey(key);
  return chain && chain.chainId !== HOME.chainId ? chain : null;
}

/** The chains money can be added from, with what a browser wallet needs for each. */
export function fundingSources() {
  return {
    ok: true as const,
    home: { key: HOME.key, name: HOME.name },
    sources: CCTP_TESTNETS.filter((c) => c.chainId !== HOME.chainId).map((c) => ({
      key: c.key, name: c.name, chainId: c.chainId, explorer: explorerFor(c), wallet: walletChainParams(c),
    })),
  };
}

export interface FundingStep {
  step: "approve" | "send";
  chainId: number;
  to: Address;
  data: Hex;
}

/** The calls an outside wallet sends to add `amount` from `source`. */
export async function fundingSteps(user: User, input: { source: unknown; amount: unknown; from: unknown }) {
  if (!mayTransact(user)) return failure("INELIGIBLE", "Only adult and guardian accounts can add money.");
  const wallet = walletOf(user);
  if (!wallet) return failure("WALLET_NOT_READY", "Set up your SportsArc wallet first.");
  const source = sourceChain(input.source);
  if (!source) return failure("VALIDATION_ERROR", "source is a network other than the one SportsArc runs on.");
  const amount = parseUsdcAmount(input.amount);
  if (amount === null) return failure("VALIDATION_ERROR", "amount is a dollar amount above 0 with at most 6 decimals.");
  const fromText = typeof input.from === "string" ? input.from.trim() : "";
  if (!isAddress(fromText, { strict: false })) return failure("VALIDATION_ERROR", "from is the outside wallet's address.");
  const from = getAddress(fromText);

  const quoted = await cctpDeps().iris.fees(source.domain, HOME.domain, true);
  if (!quoted.ok) return failure(quoted.error.code, quoted.error.message);
  const row = quoted.fees.find((f) => f.finalityThreshold === FINALITY_FAST && f.forwardFee !== null)
    ?? quoted.fees.find((f) => f.finalityThreshold === FINALITY_STANDARD && f.forwardFee !== null);
  if (!row || row.forwardFee === null) {
    return failure("FORWARDING_UNAVAILABLE", `Circle quotes no delivery from ${source.name} right now.`);
  }
  const protocol = (amount * BigInt(Math.ceil(row.minimumFeeBps * 100)) + 999_999n) / 1_000_000n;
  const maxFee = row.forwardFee + protocol;
  if (maxFee >= amount) {
    return failure("AMOUNT_TOO_SMALL", `The network fee is ${usd(maxFee)}; add more than that.`);
  }

  // Balance and allowance are read when the chain answers; the wallet checks again anyway.
  let needsApproval = true;
  try {
    const client = clientFor(source);
    const [balance, allowance] = await Promise.all([
      client.readContract({ address: source.usdc, abi: usdcAbi, functionName: "balanceOf", args: [from] }),
      client.readContract({ address: source.usdc, abi: usdcAbi, functionName: "allowance", args: [from, source.tokenMessenger] }),
    ]);
    if (balance < amount) {
      return failure("INSUFFICIENT_USDC", `That wallet holds ${usd(balance)} on ${source.name}.`);
    }
    needsApproval = allowance < amount;
  } catch {
    // RPC down: include the approval and let the wallet simulate.
  }

  const steps: FundingStep[] = [];
  if (needsApproval) {
    steps.push({
      step: "approve", chainId: source.chainId, to: source.usdc,
      data: encodeFunctionData({ abi: usdcAbi, functionName: "approve", args: [source.tokenMessenger, amount] }),
    });
  }
  steps.push({
    step: "send", chainId: source.chainId, to: source.tokenMessenger,
    data: encodeFunctionData({
      abi: tokenMessengerV2Abi, functionName: "depositForBurnWithHook",
      args: [amount, HOME.domain, addressToBytes32(wallet), source.usdc, zeroHash, maxFee, row.finalityThreshold, FORWARD_HOOK_DATA],
    }),
  });
  return {
    ok: true as const,
    source: { key: source.key, name: source.name, chainId: source.chainId, wallet: walletChainParams(source) },
    recipient: wallet,
    amountUsdc: formatUnits(amount, 6),
    feeUsdc: formatUnits(maxFee, 6),
    receiveUsdc: formatUnits(amount - maxFee, 6),
    fast: row.finalityThreshold === FINALITY_FAST,
    steps,
  };
}

export function fundingView(f: CctpFunding) {
  const source = cctpChainById(f.sourceChainId);
  const tx = (chain: CctpChain | null, hash?: string | null) =>
    chain && hash && explorerFor(chain) ? `${explorerFor(chain)!.replace(/\/+$/, "")}/tx/${hash}` : null;
  return {
    id: f.id,
    state: f.state,
    sourceName: source?.name ?? `chain ${f.sourceChainId}`,
    amountUsdc: f.amount ? formatUnits(BigInt(f.amount), 6) : null,
    receivedUsdc: f.receivedAmount ? formatUnits(BigInt(f.receivedAmount), 6) : null,
    receipt: f.state === "arrived" ? tx(HOME, f.mintTxHash) ?? tx(source, f.burnTxHash) : tx(source, f.burnTxHash),
    error: f.state === "failed" ? f.lastError ?? null : null,
    createdAt: f.createdAt,
    completedAt: f.completedAt ?? null,
  };
}

/** Start following a burn the browser just sent. Idempotent per tx. */
export async function recordFunding(em: EntityManager, user: User, input: { source: unknown; txHash: unknown }) {
  if (!mayTransact(user)) return failure("INELIGIBLE", "Only adult and guardian accounts can add money.");
  const wallet = walletOf(user);
  if (!wallet) return failure("WALLET_NOT_READY", "Set up your SportsArc wallet first.");
  const source = sourceChain(input.source);
  if (!source) return failure("VALIDATION_ERROR", "source is a network other than the one SportsArc runs on.");
  const hash = typeof input.txHash === "string" ? input.txHash.trim().toLowerCase() : "";
  if (!/^0x[0-9a-f]{64}$/.test(hash)) return failure("VALIDATION_ERROR", "txHash is a transaction hash.");

  const existing = await em.findOne(CctpFunding, { sourceChainId: source.chainId, burnTxHash: hash });
  if (existing) {
    if (existing.user.id !== user.id) return failure("FUNDING_NOT_FOUND", "That transaction is not yours.");
    return { ok: true as const, funding: fundingView(existing) };
  }
  const row = new CctpFunding();
  row.user = user;
  row.sourceChainId = source.chainId;
  row.sourceDomain = source.domain;
  row.walletAddress = wallet;
  row.burnTxHash = hash;
  em.persist(row);
  await em.flush();
  return { ok: true as const, funding: fundingView(row) };
}

export async function listFundings(em: EntityManager, user: User, limit = 20) {
  const rows = await em.find(CctpFunding, { user }, { orderBy: { createdAt: "DESC" }, limit });
  return { ok: true as const, fundings: rows.map(fundingView) };
}

/** Follow one funding as far as Circle has got. */
async function advanceFunding(em: EntityManager, f: CctpFunding): Promise<void> {
  const deps = cctpDeps();
  const now = deps.now();
  const later = (rateLimited = false) => {
    f.polls += 1;
    f.nextCheckAt = new Date(now.getTime() + irisDelayMs(f.polls, rateLimited));
  };
  const failed = (why: string) => {
    f.state = "failed";
    f.lastError = why;
    f.completedAt = now;
  };

  const r = await deps.iris.messagesForTx(f.sourceDomain, f.burnTxHash as Hex);
  if (!r.ok) {
    f.lastError = r.error.message;
    return later(r.error.code === "IRIS_RATE_LIMITED");
  }
  const wallet = getAddress(f.walletAddress);
  const decoded = r.found
    ? r.messages.map((m) => ({ m, d: m.message ? decodeBurnMessage(m.message) : null }))
    : [];
  const mine = decoded.find(({ d }) => d && d.destinationDomain === HOME.domain && isAddressEqual(d.body.mintRecipient, wallet));
  if (!mine || !mine.d) {
    // Readable messages, none for this wallet: not a payment to this player.
    if (decoded.length > 0 && decoded.every(({ d }) => d !== null)) {
      return failed("That transaction does not send money to your SportsArc wallet.");
    }
    if (now.getTime() - f.createdAt.getTime() > GIVE_UP_MS) return failed("Circle never saw that transaction.");
    return later();
  }
  f.amount = mine.d.body.amount.toString();
  f.lastError = null;

  let arrived = mine.m.forwardTxHash !== null && /complete/i.test(mine.m.forwardState ?? "");
  if (!arrived && mine.m.complete && mine.d.nonce !== zeroHash) {
    try {
      const used = await deps.client(HOME).readContract({
        address: HOME.messageTransmitter,
        abi: [{ type: "function", name: "usedNonces", stateMutability: "view", inputs: [{ name: "nonce", type: "bytes32" }], outputs: [{ name: "", type: "uint256" }] }] as const,
        functionName: "usedNonces", args: [mine.d.nonce],
      });
      arrived = used !== 0n;
    } catch {
      // Home RPC unreachable: Iris alone decides this pass.
    }
  }
  if (!arrived) {
    if (/fail/i.test(mine.m.forwardState ?? "")) f.lastError = `Circle's forwarder reports ${mine.m.forwardState}.`;
    return later();
  }
  f.state = "arrived";
  f.mintTxHash = mine.m.forwardTxHash;
  f.receivedAmount = (mine.m.complete ? mintedAmount(mine.d) : mine.d.body.amount).toString();
  f.completedAt = now;
  f.nextCheckAt = null;
  const source = cctpChainById(f.sourceChainId);
  await notify(em, {
    recipient: f.user, kind: "funds_added",
    detail: `${usd(BigInt(f.receivedAmount))} from ${source?.name ?? "another network"}`,
  });
  log.info("funding arrived", { fundingId: f.id, userId: f.user.id, sourceChainId: f.sourceChainId });
}

/** Follow every funding still on its way. */
export async function advanceFundings(em: EntityManager, limit = 50): Promise<number> {
  const now = cctpDeps().now();
  const rows = await em.find(
    CctpFunding,
    { state: "sent", $or: [{ nextCheckAt: null }, { nextCheckAt: { $lte: now } }] },
    { orderBy: { updatedAt: "ASC" }, limit },
  );
  for (const f of rows) {
    try {
      await advanceFunding(em, f);
    } catch (err) {
      f.lastError = err instanceof Error ? err.message.slice(0, 300) : String(err);
      f.polls += 1;
      f.nextCheckAt = new Date(now.getTime() + irisDelayMs(f.polls));
    }
    await em.flush();
  }
  return rows.length;
}
