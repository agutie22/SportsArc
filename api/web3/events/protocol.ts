/**
 * EventVault's wire format, with no database and no env: the EIP-712 domain
 * and every message the host (the vault's organizer), a player, a prize's
 * funder (the vault's sponsor; today always the host) or the server signs,
 * the ABI, the platform fee, team keys and prize splits. Everything here
 * must stay byte-for-byte in step with contracts/src/EventVault.sol;
 * check.ts and the Foundry test pin the two together with a shared vector.
 *
 * Who signs what is in the contract's header. In short: the organizer signs
 * the terms, the result and a cancel; a player signs a USDC authorization
 * whose nonce is the digest of their Entry (or the Entry itself when there
 * is no fee) and a Leave; a sponsor signs a USDC authorization whose nonce
 * is the digest of their Prize; the server signs an EntryPermit, a
 * PrizePermit, and the Result beside the organizer.
 */

import {
  encodeAbiParameters, hashTypedData, keccak256, parseAbi, type Address, type Hex, type LocalAccount,
} from "viem";
import type { TypedData } from "../wallet/signature.js";

// ── limits ────────────────────────────────────────────────────────────

/** An entry fee is free or at least this: under it the platform fee would take most of it. */
export const MIN_ENTRY_FEE = 100_000n; // $0.10
export const MAX_ENTRY_FEE = 500_000_000n; // $500
export const MIN_PRIZE = 100_000n; // $0.10
export const MAX_PRIZE = 10_000_000_000n; // $10,000

/** Mirrors EventVault.MAX_PLACES and MAX_LOCK. */
export const MAX_PLACES = 8;
export const MAX_LOCK_SECONDS = 365n * 86_400n;

/**
 * How long after the game ends the organizer has to post a result. From
 * then on every entry and prize is refundable by anyone, with no signature.
 */
export const RESULT_DEADLINE_SECONDS = 3n * 86_400n;

/** Unix seconds by which a result must be posted. */
export function resultDeadlineFor(startsAt: Date, durationMinutes: number): bigint {
  return BigInt(Math.floor(startsAt.getTime() / 1000)) + BigInt(durationMinutes) * 60n + RESULT_DEADLINE_SECONDS;
}

// ── status ────────────────────────────────────────────────────────────

/** EventVault.Status, by its on-chain value. */
export const CHAIN_STATUSES = ["none", "open", "cancelled", "void", "posted", "final", "expired"] as const;
export type ChainStatus = (typeof CHAIN_STATUSES)[number];

export function chainStatus(value: number): ChainStatus {
  return CHAIN_STATUSES[value] ?? "none";
}

/** Money can be claimed: the event ran (final) or everything goes back. */
export function isSettled(status: ChainStatus): boolean {
  return status === "final" || isRefundable(status);
}

export function isRefundable(status: ChainStatus): boolean {
  return status === "cancelled" || status === "void" || status === "expired";
}

/** EventVault.SeatState.Entered. */
export const SEAT_ENTERED = 1;

// ── fee, teams, splits ────────────────────────────────────────────────

/** Mirrors EventVault.feeOn: the platform fee on one entry. */
export function feeOn(entryFee: bigint, feeBps: number, gasFee: bigint): bigint {
  const fee = (entryFee * BigInt(feeBps)) / 10_000n + gasFee;
  return fee > entryFee ? entryFee : fee;
}

/** A solo player's team: keccak256 of their address, ABI-encoded. Today every team is one player. */
export function soloTeamKey(player: Address): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }], [player]));
}

/** Prize splits a host can pick, in basis points per place, first place first. */
export const SPLIT_PRESETS = {
  winner: [10_000],
  top2: [7_000, 3_000],
  top3: [6_000, 3_000, 1_000],
} as const satisfies Record<string, readonly number[]>;

/** Mirrors EventVault._checkSplit: 1 to MAX_PLACES non-zero shares summing to 10000. */
export function validSplit(split: unknown): split is number[] {
  return Array.isArray(split) && split.length >= 1 && split.length <= MAX_PLACES
    && split.every((s) => Number.isInteger(s) && s > 0 && s <= 10_000)
    && split.reduce((a: number, b: number) => a + b, 0) === 10_000;
}

/** Mirrors EventVault.prizeShareOf for a team of `members`. */
export function prizeShare(prizeTotal: bigint, split: readonly number[], place: number, members = 1): bigint {
  const bps = split[place - 1];
  if (!bps || members < 1) return 0n;
  return (prizeTotal * BigInt(bps)) / 10_000n / BigInt(members);
}

// ── EIP-712 ───────────────────────────────────────────────────────────

export const EIP712_NAME = "SportsArc EventVault";
export const EIP712_VERSION = "1";

export interface Deployment {
  chainId: number;
  vault: Address;
}

export function vaultDomain(d: Deployment) {
  return { name: EIP712_NAME, version: EIP712_VERSION, chainId: d.chainId, verifyingContract: d.vault } as const;
}

const ENTRY_FIELDS = [
  { name: "eventId", type: "bytes32" },
  { name: "player", type: "address" },
  { name: "teamKey", type: "bytes32" },
  { name: "routed", type: "bool" },
  { name: "attempt", type: "uint32" },
] as const;

const PRIZE_FIELDS = [
  { name: "eventId", type: "bytes32" },
  { name: "sponsor", type: "address" },
  { name: "amount", type: "uint256" },
  { name: "split", type: "uint16[]" },
  { name: "salt", type: "bytes32" },
] as const;

export const EVENT_TERMS_TYPES = {
  EventTerms: [
    { name: "eventId", type: "bytes32" },
    { name: "organizer", type: "address" },
    { name: "entryFee", type: "uint256" },
    { name: "minEntrants", type: "uint32" },
    { name: "minAttendees", type: "uint32" },
    { name: "startsAt", type: "uint64" },
    { name: "registrationClosesAt", type: "uint64" },
    { name: "resultDeadline", type: "uint64" },
  ],
} as const;
export const ENTRY_TYPES = { Entry: ENTRY_FIELDS } as const;
export const ENTRY_PERMIT_TYPES = { EntryPermit: ENTRY_FIELDS } as const;
export const LEAVE_TYPES = {
  Leave: [
    { name: "eventId", type: "bytes32" },
    { name: "player", type: "address" },
    { name: "attempt", type: "uint32" },
  ],
} as const;
export const PRIZE_TYPES = { Prize: PRIZE_FIELDS } as const;
export const PRIZE_PERMIT_TYPES = { PrizePermit: PRIZE_FIELDS } as const;
export const RESULT_TYPES = {
  Result: [
    { name: "eventId", type: "bytes32" },
    { name: "placements", type: "bytes32[]" },
    { name: "attendees", type: "uint32" },
    { name: "revision", type: "uint32" },
  ],
} as const;
export const CANCEL_TYPES = { Cancel: [{ name: "eventId", type: "bytes32" }] } as const;

export interface EventTermsMessage {
  eventId: Hex;
  organizer: Address;
  entryFee: bigint;
  minEntrants: number;
  minAttendees: number;
  startsAt: bigint;
  registrationClosesAt: bigint;
  resultDeadline: bigint;
}

export interface EntryMessage {
  eventId: Hex;
  player: Address;
  teamKey: Hex;
  /** Pay this seat through the payout router (another chain). */
  routed: boolean;
  /** How many times this player has left this event before. */
  attempt: number;
}

export interface LeaveMessage {
  eventId: Hex;
  player: Address;
  attempt: number;
}

export interface PrizeMessage {
  eventId: Hex;
  sponsor: Address;
  amount: bigint;
  split: number[];
  /** Chosen per contribution, so one sponsor can fund twice. */
  salt: Hex;
}

export interface ResultMessage {
  eventId: Hex;
  /** Team keys, first place first. */
  placements: Hex[];
  /** Players who checked in: the server's count. */
  attendees: number;
  /** The vault's revision counter when this was signed, so an older result cannot be replayed. */
  revision: number;
}

// What a wallet signs with its PIN, in wallet/signature.ts's form.

export function termsTypedData(d: Deployment, terms: EventTermsMessage): TypedData {
  return { domain: vaultDomain(d), types: EVENT_TERMS_TYPES, primaryType: "EventTerms", message: { ...terms } };
}

/** Signed by the player only when the entry fee is zero; otherwise its digest is their USDC authorization's nonce. */
export function entryTypedData(d: Deployment, entry: EntryMessage): TypedData {
  return { domain: vaultDomain(d), types: ENTRY_TYPES, primaryType: "Entry", message: { ...entry } };
}

export function leaveTypedData(d: Deployment, leave: LeaveMessage): TypedData {
  return { domain: vaultDomain(d), types: LEAVE_TYPES, primaryType: "Leave", message: { ...leave } };
}

export function resultTypedData(d: Deployment, result: ResultMessage): TypedData {
  return { domain: vaultDomain(d), types: RESULT_TYPES, primaryType: "Result", message: { ...result } };
}

export function cancelTypedData(d: Deployment, eventId: Hex): TypedData {
  return { domain: vaultDomain(d), types: CANCEL_TYPES, primaryType: "Cancel", message: { eventId } };
}

// Digests, as the contract's hash* views compute them.

export function termsDigest(d: Deployment, terms: EventTermsMessage): Hex {
  return hashTypedData({ domain: vaultDomain(d), types: EVENT_TERMS_TYPES, primaryType: "EventTerms", message: terms });
}

/** The nonce of the USDC authorization that pays for this entry. */
export function entryDigest(d: Deployment, entry: EntryMessage): Hex {
  return hashTypedData({ domain: vaultDomain(d), types: ENTRY_TYPES, primaryType: "Entry", message: entry });
}

export function entryPermitDigest(d: Deployment, entry: EntryMessage): Hex {
  return hashTypedData({ domain: vaultDomain(d), types: ENTRY_PERMIT_TYPES, primaryType: "EntryPermit", message: entry });
}

export function leaveDigest(d: Deployment, leave: LeaveMessage): Hex {
  return hashTypedData({ domain: vaultDomain(d), types: LEAVE_TYPES, primaryType: "Leave", message: leave });
}

/** The nonce of the USDC authorization that funds this prize. */
export function prizeDigest(d: Deployment, prize: PrizeMessage): Hex {
  return hashTypedData({ domain: vaultDomain(d), types: PRIZE_TYPES, primaryType: "Prize", message: prize });
}

export function prizePermitDigest(d: Deployment, prize: PrizeMessage): Hex {
  return hashTypedData({ domain: vaultDomain(d), types: PRIZE_PERMIT_TYPES, primaryType: "PrizePermit", message: prize });
}

export function resultDigest(d: Deployment, result: ResultMessage): Hex {
  return hashTypedData({ domain: vaultDomain(d), types: RESULT_TYPES, primaryType: "Result", message: result });
}

export function cancelDigest(d: Deployment, eventId: Hex): Hex {
  return hashTypedData({ domain: vaultDomain(d), types: CANCEL_TYPES, primaryType: "Cancel", message: { eventId } });
}

// What the server signs. Signatures are local; the account never touches an RPC.

export function signEntryPermit(signer: LocalAccount, d: Deployment, entry: EntryMessage): Promise<Hex> {
  return signer.signTypedData({ domain: vaultDomain(d), types: ENTRY_PERMIT_TYPES, primaryType: "EntryPermit", message: entry });
}

export function signPrizePermit(signer: LocalAccount, d: Deployment, prize: PrizeMessage): Promise<Hex> {
  return signer.signTypedData({ domain: vaultDomain(d), types: PRIZE_PERMIT_TYPES, primaryType: "PrizePermit", message: prize });
}

export function signResult(signer: LocalAccount, d: Deployment, result: ResultMessage): Promise<Hex> {
  return signer.signTypedData({ domain: vaultDomain(d), types: RESULT_TYPES, primaryType: "Result", message: result });
}

// ── ABI ───────────────────────────────────────────────────────────────

export const eventVaultAbi = parseAbi([
  "struct EventTerms { bytes32 eventId; address organizer; uint256 entryFee; uint32 minEntrants; uint32 minAttendees; uint64 startsAt; uint64 registrationClosesAt; uint64 resultDeadline; }",
  "struct Entry { bytes32 eventId; address player; bytes32 teamKey; bool routed; uint32 attempt; }",
  "struct Prize { bytes32 eventId; address sponsor; uint256 amount; uint16[] split; bytes32 salt; }",
  "struct EventState { address organizer; uint64 startsAt; uint32 minEntrants; uint256 entryFee; uint64 registrationClosesAt; uint64 resultDeadline; uint64 firstPostedAt; uint32 minAttendees; uint32 entrants; uint32 attendees; uint32 revision; bool cancelled; bool organizerPaid; uint256 prizeTotal; uint16[] split; bytes32[] placements; }",

  "function createEvent(EventTerms terms, bytes organizerSig)",
  "function cancel(bytes32 eventId, bytes organizerSig)",
  "function postResult(bytes32 eventId, bytes32[] placements, uint32 attendees, bytes serverSig, bytes organizerSig)",
  "function register(Entry entry, bytes serverPermit, bytes playerSig, uint256 validAfter, uint256 validBefore)",
  "function leave(bytes32 eventId, address player, bytes playerSig)",
  "function fundPrize(Prize prize, bytes serverPermit, bytes sponsorSig, uint256 validAfter, uint256 validBefore)",
  "function claim(bytes32 eventId, address account) returns (uint256 paid)",
  "function payTreasury()",
  "function proposeSigner(address next)",
  "function cancelSignerChange()",
  "function applySignerChange()",

  "function status(bytes32 eventId) view returns (uint8)",
  "function eventOf(bytes32 eventId) view returns (EventState)",
  "function placementsOf(bytes32 eventId) view returns (bytes32[] teamKeys, bool isFinal)",
  "function finalAt(bytes32 eventId) view returns (uint64)",
  "function feeOn(uint256 entryFee) view returns (uint256 fee)",
  "function prizeShareOf(bytes32 eventId, bytes32 teamKey) view returns (uint256)",
  "function unusedPrize(bytes32 eventId) view returns (uint256 unused)",
  "function claimable(bytes32 eventId, address account) view returns (uint256 owed)",
  "function feesPending(bytes32 eventId) view returns (bool)",
  "function seats(bytes32 eventId, address player) view returns (uint8 state, bool routed, bool paid, uint32 attempt, bytes32 teamKey)",
  "function teams(bytes32 eventId, bytes32 teamKey) view returns (uint32 members, uint8 place)",
  "function sponsors(bytes32 eventId, address sponsor) view returns (uint256 amount, bool paid)",
  "function treasuryOwed() view returns (uint256)",
  "function usdc() view returns (address)",
  "function signer() view returns (address)",
  "function treasury() view returns (address)",
  "function payoutRouter() view returns (address)",
  "function owner() view returns (address)",
  "function pendingSigner() view returns (address)",
  "function signerChangeAt() view returns (uint64)",
  "function SIGNER_DELAY() view returns (uint64)",
  "function FEE_BPS() view returns (uint16)",
  "function GAS_FEE() view returns (uint256)",
  "function CORRECTION_WINDOW() view returns (uint64)",
  "function domainSeparator() view returns (bytes32)",

  "event EventCreated(bytes32 indexed eventId, address indexed organizer, uint256 entryFee, uint32 minEntrants, uint32 minAttendees, uint64 startsAt, uint64 registrationClosesAt, uint64 resultDeadline)",
  "event Registered(bytes32 indexed eventId, address indexed player, bytes32 indexed teamKey, uint256 entryFee, bool routed)",
  "event Left(bytes32 indexed eventId, address indexed player, uint256 refund)",
  "event PrizeFunded(bytes32 indexed eventId, address indexed sponsor, uint256 amount, uint256 prizeTotal)",
  "event ResultPosted(bytes32 indexed eventId, uint32 revision, uint32 attendees, bytes32[] placements)",
  "event EventCancelled(bytes32 indexed eventId)",
  "event Claimed(bytes32 indexed eventId, address indexed account, uint256 amount)",
  "event FeeTaken(bytes32 indexed eventId, uint256 amount)",
  "event TreasuryPaid(uint256 amount)",
  "event RoutedPayout(bytes32 indexed gameId, address indexed player, uint256 amount)",
  "event SignerProposed(address indexed signer, uint64 applicableAt)",
  "event SignerChangeCancelled(address indexed signer)",
  "event SignerChanged(address indexed previous, address indexed signer)",

  // Named so a refused relay says why (relayer/submit.ts).
  "error ZeroAddress()",
  "error FeeTooHigh()",
  "error BadWindow()",
  "error BadTerms()",
  "error EventExists()",
  "error NotOpen()",
  "error RegistrationClosed()",
  "error BadSignature()",
  "error BadEntry()",
  "error AlreadyEntered()",
  "error NotEntered()",
  "error RoutingDisabled()",
  "error PaymentNotReceived()",
  "error ZeroAmount()",
  "error BadSplit()",
  "error SplitMismatch()",
  "error TooEarly()",
  "error BadAttendees()",
  "error BadPlacements()",
  "error NotSettled()",
  "error NothingOwed()",
  "error NoSignerChange()",
  "error SignerChangeNotReady()",
  "error OwnableInvalidOwner(address owner)",
  "error OwnableUnauthorizedAccount(address account)",
]);
