/**
 * Deployed contract addresses, read from env so a deploy never edits code.
 * One entry per contract; null until deployed.
 */

import { isAddress, type Address } from "viem";

const ENV = {
  record: "RECORD_CONTRACT_ADDRESS",
  eventVault: "EVENT_VAULT_ADDRESS",
  usdc: "WEB3_USDC_ADDRESS",
} as const;

export type ContractName = keyof typeof ENV;

export function contractAddress(name: ContractName): Address | null {
  const value = process.env[ENV[name]]?.trim() ?? "";
  return isAddress(value) ? value : null;
}
