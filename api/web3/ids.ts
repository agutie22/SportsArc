/**
 * On-chain keys for off-chain records. Contracts never see a UUID or any
 * personal data: a game is keccak256 of its lowercase UUID string. The
 * contracts take that key as `gameId` and never see the UUID.
 */

import { keccak256, stringToBytes, type Hex } from "viem";

export function gameKey(gameId: string): Hex {
  return keccak256(stringToBytes(gameId.toLowerCase()));
}
