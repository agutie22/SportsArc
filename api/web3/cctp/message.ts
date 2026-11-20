/**
 * CCTP v2 messages as bytes: decode the fields this workstream checks,
 * pull MessageSent out of a burn receipt, and compare the message Iris
 * attests with the one the burn emitted. Pure; no network.
 *
 * Layout (evm-cctp-contracts src/messages/v2/MessageV2.sol, BurnMessageV2.sol):
 *
 *   header  version u32 @0, sourceDomain u32 @4, destinationDomain u32 @8,
 *           nonce b32 @12, sender b32 @44, recipient b32 @76,
 *           destinationCaller b32 @108, minFinalityThreshold u32 @140,
 *           finalityThresholdExecuted u32 @144, body @148
 *   body    version u32 @0, burnToken b32 @4, mintRecipient b32 @36,
 *           amount u256 @68, messageSender b32 @100, maxFee u256 @132,
 *           feeExecuted u256 @164, expirationBlock u256 @196, hookData @228
 *
 * The source chain emits the message with nonce, finalityThresholdExecuted,
 * feeExecuted and expirationBlock zeroed; the attester fills them in. Every
 * other byte must survive unchanged, which is what matchesBurn checks.
 */

import {
  concat,
  decodeEventLog,
  getAddress,
  hexToBigInt,
  hexToNumber,
  isAddressEqual,
  isHex,
  keccak256,
  pad,
  recoverAddress,
  size,
  slice,
  type Address,
  type Hex,
} from "viem";
import { messageTransmitterV2Abi } from "./abi.js";

const HEADER = 148;
const BODY_FIXED = 228;

export interface BurnMessage {
  version: number;
  sourceDomain: number;
  destinationDomain: number;
  nonce: Hex;
  sender: Hex;
  recipient: Hex;
  destinationCaller: Hex;
  minFinalityThreshold: number;
  finalityThresholdExecuted: number;
  body: {
    version: number;
    burnToken: Address;
    mintRecipient: Address;
    amount: bigint;
    messageSender: Address;
    maxFee: bigint;
    feeExecuted: bigint;
    expirationBlock: bigint;
    hookData: Hex;
  };
}

/** bytes32 holding a left-padded address, as CCTP encodes addresses. */
export function addressToBytes32(address: Address): Hex {
  return pad(address, { size: 32 }).toLowerCase() as Hex;
}

function bytes32ToAddress(word: Hex): Address {
  return getAddress(`0x${word.slice(26)}`);
}

/** Null when the bytes are not a v2 burn message. */
export function decodeBurnMessage(message: Hex): BurnMessage | null {
  if (!isHex(message) || size(message) < HEADER + BODY_FIXED) return null;
  const at = (start: number, end: number) => slice(message, start, end);
  const body = slice(message, HEADER);
  const b = (start: number, end: number) => slice(body, start, end);
  return {
    version: hexToNumber(at(0, 4)),
    sourceDomain: hexToNumber(at(4, 8)),
    destinationDomain: hexToNumber(at(8, 12)),
    nonce: at(12, 44),
    sender: at(44, 76),
    recipient: at(76, 108),
    destinationCaller: at(108, 140),
    minFinalityThreshold: hexToNumber(at(140, 144)),
    finalityThresholdExecuted: hexToNumber(at(144, 148)),
    body: {
      version: hexToNumber(b(0, 4)),
      burnToken: bytes32ToAddress(b(4, 36)),
      mintRecipient: bytes32ToAddress(b(36, 68)),
      amount: hexToBigInt(b(68, 100)),
      messageSender: bytes32ToAddress(b(100, 132)),
      maxFee: hexToBigInt(b(132, 164)),
      feeExecuted: hexToBigInt(b(164, 196)),
      expirationBlock: hexToBigInt(b(196, 228)),
      hookData: size(body) > BODY_FIXED ? slice(body, BODY_FIXED) : "0x",
    },
  };
}

/** What the burn must say: checked against both the emitted and attested message. */
export interface BurnExpectation {
  sourceDomain: number;
  destinationDomain: number;
  tokenMessenger: Address;
  burnToken: Address;
  mintRecipient: Address;
  messageSender: Address;
  amount: bigint;
  maxFee: bigint;
  minFinalityThreshold: number;
  /** "0x" for a plain burn; the Forwarding Service hook for a withdrawal. */
  hookData?: Hex;
}

/** Null when the message is the burn we expect, else the first mismatch. */
export function burnMismatch(m: BurnMessage, want: BurnExpectation): string | null {
  const tm = addressToBytes32(want.tokenMessenger);
  if (m.version !== 1 || m.body.version !== 1) return "unexpected message version";
  if (m.sourceDomain !== want.sourceDomain) return `source domain ${m.sourceDomain}`;
  if (m.destinationDomain !== want.destinationDomain) return `destination domain ${m.destinationDomain}`;
  if (m.sender.toLowerCase() !== tm) return "sender is not the TokenMessenger";
  if (m.recipient.toLowerCase() !== tm) return "recipient is not the TokenMessenger";
  if (hexToBigInt(m.destinationCaller) !== 0n) return "destination caller is restricted";
  if (m.minFinalityThreshold !== want.minFinalityThreshold) return `finality ${m.minFinalityThreshold}`;
  if (!isAddressEqual(m.body.burnToken, want.burnToken)) return "burn token";
  if (!isAddressEqual(m.body.mintRecipient, want.mintRecipient)) return "mint recipient";
  if (!isAddressEqual(m.body.messageSender, want.messageSender)) return "message sender";
  if (m.body.amount !== want.amount) return `amount ${m.body.amount}`;
  if (m.body.maxFee !== want.maxFee) return `max fee ${m.body.maxFee}`;
  if (m.body.hookData.toLowerCase() !== (want.hookData ?? "0x").toLowerCase()) return "unexpected hook data";
  return null;
}

/**
 * The attested message is the emitted one with only the attester's fields
 * filled in (nonce, finality executed, fee executed, expiration block).
 */
export function sameBurn(emitted: Hex, attested: Hex): boolean {
  if (size(emitted) !== size(attested) || size(emitted) < HEADER + BODY_FIXED) return false;
  const keep = (m: Hex) =>
    concat([
      slice(m, 0, 12), // version, domains
      slice(m, 44, 144), // sender, recipient, caller, min finality
      slice(m, HEADER, HEADER + 164), // body up to maxFee
      size(m) > HEADER + BODY_FIXED ? slice(m, HEADER + BODY_FIXED) : "0x", // hook data
    ]).toLowerCase();
  return keep(emitted) === keep(attested);
}

export interface RawLog {
  address: Address;
  data: Hex;
  topics: readonly Hex[];
}

/** MessageSent payloads emitted by `transmitter` in a receipt's logs. */
export function messagesSent(logs: readonly RawLog[], transmitter: Address): Hex[] {
  const out: Hex[] = [];
  for (const log of logs) {
    if (!isAddressEqual(log.address, transmitter)) continue;
    try {
      const ev = decodeEventLog({ abi: messageTransmitterV2Abi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
      if (ev.eventName === "MessageSent") out.push(ev.args.message);
    } catch {
      // another event from the transmitter
    }
  }
  return out;
}

/** Signers of a CCTP attestation: 65-byte signatures over keccak256(message). */
export async function attestationSigners(message: Hex, attestation: Hex): Promise<Address[] | null> {
  if (!isHex(attestation) || size(attestation) === 0 || size(attestation) % 65 !== 0) return null;
  const digest = keccak256(message);
  const out: Address[] = [];
  try {
    for (let i = 0; i < size(attestation) / 65; i++) {
      out.push(await recoverAddress({ hash: digest, signature: slice(attestation, i * 65, (i + 1) * 65) }));
    }
  } catch {
    return null;
  }
  return out;
}

/** What the attested message mints: amount less the fee the attester executed. */
export function mintedAmount(m: BurnMessage): bigint {
  return m.body.amount - m.body.feeExecuted;
}
