/**
 * The slices of Circle's contracts this workstream calls, transcribed from
 * github.com/circlefin/evm-cctp-contracts (src/v2/TokenMessengerV2.sol,
 * MessageTransmitterV2.sol, BaseMessageTransmitter.sol, TokenMinter.sol,
 * roles/Attestable.sol).
 */

import { parseAbi } from "viem";

export const tokenMessengerV2Abi = parseAbi([
  "function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData)",
  "function localMessageTransmitter() view returns (address)",
  "function localMinter() view returns (address)",
  "function messageBodyVersion() view returns (uint32)",
  "function remoteTokenMessengers(uint32 domain) view returns (bytes32)",
  "function minFee() view returns (uint256)",
]);

export const messageTransmitterV2Abi = parseAbi([
  "function receiveMessage(bytes message, bytes attestation) returns (bool success)",
  "function localDomain() view returns (uint32)",
  "function version() view returns (uint32)",
  "function usedNonces(bytes32 nonce) view returns (uint256)",
  "function signatureThreshold() view returns (uint256)",
  "function isEnabledAttester(address attester) view returns (bool)",
  "function paused() view returns (bool)",
  "event MessageSent(bytes message)",
]);

export const tokenMinterAbi = parseAbi([
  "function getLocalToken(uint32 remoteDomain, bytes32 remoteToken) view returns (address)",
  "function burnLimitsPerMessage(address token) view returns (uint256)",
]);

export const usdcAbi = parseAbi([
  "function approve(address spender, uint256 value) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);
