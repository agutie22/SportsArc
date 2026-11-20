/**
 * Non-reversible on-chain keys for people. The verified record is the only TypeScript
 * caller on this branch. Solidity mirror: RecordHash.playerCode in
 * contracts/src/record/RecordHash.sol; change both together
 * (api/web3/record/check.ts and test/SportsArcRecord.t.sol pin vectors).
 *
 *   participant = keccak256(abi.encode(userKey(userId), salt))
 *   salt        = 32 random bytes per record, kept off chain
 *
 * Why salted: user ids are public (profile URLs), so a bare hash of one can
 * be reversed by hashing every known id, and would link one person across
 * every game. With a secret salt the key is unlinkable and unguessable, yet
 * the participant can prove "this is me" by revealing (userKey, salt) to
 * whoever they choose. Deleting the salt makes the key permanently
 * unopenable. userKey alone must never be published: it is only an input.
 */

import { randomBytes } from "node:crypto";
import { encodeAbiParameters, keccak256, stringToBytes, toHex, type Hex } from "viem";

/** keccak256 of the lowercase user UUID, the same rule as gameKey() in ../ids.ts. */
export function userKey(userId: string): Hex {
  return keccak256(stringToBytes(userId.toLowerCase()));
}

/** A fresh salt. Store it with the record; it is what opens the key. */
export function newSalt(): Hex {
  return toHex(randomBytes(32));
}

/** The salted commitment that goes into a leaf in place of the person. */
export function playerCode(userKeyHex: Hex, salt: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [userKeyHex, salt]));
}
