/**
 * The slice of SportsArcRecord.sol's ABI the server uses. Hand-written because
 * contracts/out/ is a build artefact; check-e2e.ts compares every entry with
 * the compiled contract so the two cannot drift silently.
 */

import { parseAbi } from "viem";

export const recordAbi = parseAbi([
  "function write(bytes32 entry, bytes32 kind)",
  "function writtenAt(bytes32 entry) view returns (uint64)",
  "function isWritten(bytes32 entry) view returns (bool)",
  "function checkInWrittenAt(bytes32 game, bytes32 player, uint64 checkedInAt) view returns (uint64)",
  "function noShowWrittenAt(bytes32 game, bytes32 player, uint64 closedAt) view returns (uint64)",
  "function isWriter(address writer) view returns (bool)",
  "event Written(bytes32 indexed entry, bytes32 indexed kind, address indexed writer)",
  "error NotWriter(address caller)",
  "error ZeroEntry()",
  "error ZeroKind()",
  "error AlreadyWritten(bytes32 entry)",
]);
