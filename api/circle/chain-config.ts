/**
 * Shared chain + USDC addresses for Arc Testnet / Base Sepolia.
 */

const ARC_TESTNET_USDC = "0x3600000000000000000000000000000000000000" as const;

export const CHAIN_DEFAULTS: Record<
  string,
  { id: number; name: string; rpc: string; usdc: `0x${string}`; explorer: string }
> = {
  arcTestnet: {
    id: 5_042_002,
    name: "Arc Testnet",
    rpc: "https://rpc.testnet.arc.io",
    usdc: ARC_TESTNET_USDC,
    explorer: "https://explorer.testnet.arc.io",
  },
  baseSepolia: {
    id: 84_532,
    name: "Base Sepolia",
    rpc: "https://sepolia.base.org",
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    explorer: "https://sepolia.basescan.org",
  },
};

export function normalizeBuyerChainKey(raw: string | undefined): string {
  const s = (raw ?? "arcTestnet").trim().toLowerCase().replace(/_/g, "-");
  if (s === "basesepolia" || s === "base-sepolia") return "baseSepolia";
  if (s === "arctestnet" || s === "arc-testnet") return "arcTestnet";
  return "arcTestnet";
}
