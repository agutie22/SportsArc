/**
 * EVM transaction plumbing for user wallets, with viem: build an EIP-1559
 * tx (nonce, gas and fees from the node), check a signed tx against what
 * was built, broadcast it, read its receipt or find it dropped, read
 * balances. Every function takes the client for the tx's chain (see
 * networks.ts). No database and no Circle here.
 *
 * Gas is paid by the sending wallet, in the chain's native token (USDC on
 * Arc). Whether a relayer should fund it instead is open; quotes report
 * what the tx needs so that decision can be made later.
 */

import {
  BaseError,
  HttpRequestError,
  TimeoutError,
  TransactionReceiptNotFoundError,
  erc20Abi,
  formatUnits,
  isAddressEqual,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  serializeTransaction,
  type Address,
  type Hex,
  type TransactionSerializableEIP1559,
  type TransactionSerializedEIP1559,
} from "viem";
import { publicClient } from "../chains.js";

export type Client = ReturnType<typeof publicClient>;

export interface Failure {
  ok: false;
  error: { code: string; message: string };
}

export function failure(code: string, message: string): Failure {
  return { ok: false, error: { code, message } };
}

// ── pure math ──

/** Fee cap that survives the base fee doubling while the user enters a PIN. */
export function feeCap(baseFee: bigint, priorityFee: bigint): bigint {
  return baseFee * 2n + priorityFee;
}

/** Plain transfers are exact; contract calls get 20% headroom. */
export function gasLimitFor(estimate: bigint, hasData: boolean): bigint {
  return hasData ? (estimate * 12n + 9n) / 10n : estimate;
}

export interface GasQuote {
  gasLimit: bigint;
  baseFeePerGas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  /** Worst case the sender can be charged for gas: gasLimit x maxFeePerGas. */
  maxCostWei: bigint;
  /** At the current base fee, if the whole limit were used. */
  expectedCostWei: bigint;
}

export function gasQuote(gasLimit: bigint, baseFee: bigint, priorityFee: bigint): GasQuote {
  const maxFeePerGas = feeCap(baseFee, priorityFee);
  return {
    gasLimit,
    baseFeePerGas: baseFee,
    maxFeePerGas,
    maxPriorityFeePerGas: priorityFee,
    maxCostWei: gasLimit * maxFeePerGas,
    expectedCostWei: gasLimit * (baseFee + priorityFee),
  };
}

export interface Funds {
  balanceWei: bigint;
  /** value + maxCostWei: what the sender must hold for the node to accept it. */
  requiredWei: bigint;
  sufficient: boolean;
  shortfallWei: bigint;
}

export function fundsCheck(balanceWei: bigint, valueWei: bigint, quote: GasQuote): Funds {
  const requiredWei = valueWei + quote.maxCostWei;
  const shortfallWei = requiredWei > balanceWei ? requiredWei - balanceWei : 0n;
  return { balanceWei, requiredWei, sufficient: shortfallWei === 0n, shortfallWei };
}

// ── node calls ──

function isTransportError(err: unknown): boolean {
  if (err instanceof BaseError) {
    return Boolean(err.walk((e) => e instanceof HttpRequestError || e instanceof TimeoutError));
  }
  return false;
}

function messageOf(err: unknown): string {
  if (err instanceof BaseError) return err.shortMessage;
  return err instanceof Error ? err.message : String(err);
}

function chainFailure(err: unknown): Failure {
  return failure("CHAIN_UNAVAILABLE", `Chain RPC failed: ${messageOf(err)}`);
}

export interface TxRequest {
  from: Address;
  to: Address;
  value: bigint;
  data: Hex;
}

export interface BuiltTx {
  tx: TransactionSerializableEIP1559 & { chainId: number; nonce: number; gas: bigint };
  /** Unsigned EIP-1559 serialization: what the wallet signs. */
  unsigned: Hex;
  quote: GasQuote;
  funds: Funds;
}

export async function buildTx(
  client: Client,
  req: TxRequest,
): Promise<{ ok: true; built: BuiltTx } | Failure> {
  let chainId: number;
  let nonce: number;
  let baseFee: bigint | null;
  let blockGasLimit: bigint;
  let balanceWei: bigint;
  try {
    const [id, count, block, balance] = await Promise.all([
      client.getChainId(),
      client.getTransactionCount({ address: req.from, blockTag: "pending" }),
      client.getBlock({ blockTag: "latest" }),
      client.getBalance({ address: req.from }),
    ]);
    chainId = id;
    nonce = count;
    baseFee = block.baseFeePerGas;
    blockGasLimit = block.gasLimit;
    balanceWei = balance;
  } catch (err) {
    return chainFailure(err);
  }
  if (chainId !== client.chain.id) {
    return failure("CHAIN_MISMATCH", `The RPC serves chain ${chainId}, expected ${client.chain.id}.`);
  }
  if (baseFee === null) {
    return failure("CHAIN_UNSUPPORTED", "The chain has no EIP-1559 base fee.");
  }

  const priorityFee = await client.estimateMaxPriorityFeePerGas().catch(() => 0n);
  let estimate: bigint;
  try {
    estimate = await client.estimateGas({
      account: req.from, to: req.to, value: req.value, data: req.data,
    });
  } catch (err) {
    if (isTransportError(err)) return chainFailure(err);
    return failure("ESTIMATE_FAILED", `Gas estimate failed: ${messageOf(err)}`);
  }

  const gas = gasLimitFor(estimate, req.data !== "0x");
  if (gas > blockGasLimit) {
    return failure(
      "GAS_OVER_BLOCK_LIMIT",
      `Needs ${gas} gas; blocks on this chain hold ${blockGasLimit}.`,
    );
  }

  const quote = gasQuote(gas, baseFee, priorityFee);
  const tx = {
    type: "eip1559" as const,
    chainId,
    nonce,
    to: req.to,
    value: req.value,
    data: req.data,
    gas,
    maxFeePerGas: quote.maxFeePerGas,
    maxPriorityFeePerGas: quote.maxPriorityFeePerGas,
  };
  return {
    ok: true,
    built: { tx, unsigned: serializeTransaction(tx), quote, funds: fundsCheck(balanceWei, req.value, quote) },
  };
}

/**
 * A signed tx is accepted only if it is exactly the tx we built, signed by
 * the expected wallet. Returns the tx hash.
 */
export async function verifySignedTx(
  signed: Hex,
  expectedUnsigned: Hex,
  expectedFrom: Address,
): Promise<{ ok: true; hash: Hex } | Failure> {
  let parsed: ReturnType<typeof parseTransaction>;
  try {
    parsed = parseTransaction(signed);
  } catch {
    return failure("SIGNATURE_MISMATCH", "Not a serialized transaction.");
  }
  if (parsed.type !== "eip1559" || parsed.r === undefined || parsed.s === undefined) {
    return failure("SIGNATURE_MISMATCH", "Expected a signed EIP-1559 transaction.");
  }
  const { r: _r, s: _s, v: _v, yParity: _y, ...fields } = parsed;
  if (serializeTransaction(fields).toLowerCase() !== expectedUnsigned.toLowerCase()) {
    return failure("SIGNATURE_MISMATCH", "The signed transaction differs from the one prepared.");
  }
  let signer: Address;
  try {
    signer = await recoverTransactionAddress({ serializedTransaction: signed as TransactionSerializedEIP1559 });
  } catch {
    return failure("SIGNATURE_MISMATCH", "The signature does not recover.");
  }
  if (!isAddressEqual(signer, expectedFrom)) {
    return failure("SIGNATURE_MISMATCH", `Signed by ${signer}, expected ${expectedFrom}.`);
  }
  return { ok: true, hash: keccak256(signed) };
}

export type BroadcastResult =
  | { ok: true; hash: Hex }
  | { ok: false; transient: boolean; message: string };

export async function broadcast(client: Client, signed: Hex): Promise<BroadcastResult> {
  const hash = keccak256(signed);
  try {
    await client.sendRawTransaction({ serializedTransaction: signed });
    return { ok: true, hash };
  } catch (err) {
    // A timeout can hide an accepted tx, and a retry of one is rejected as
    // already known: if the node has it, it was broadcast.
    const known = await client.getTransaction({ hash }).then(() => true, () => false);
    if (known) return { ok: true, hash };
    return { ok: false, transient: isTransportError(err), message: messageOf(err) };
  }
}

export type ReceiptState =
  | { state: "pending" }
  | { state: "dropped"; nonceNow: number }
  | { state: "confirmed" | "reverted"; blockNumber: bigint; gasUsed: bigint };

async function readReceipt(client: Client, hash: Hex): Promise<ReceiptState | null> {
  try {
    const r = await client.getTransactionReceipt({ hash });
    return {
      state: r.status === "success" ? "confirmed" : "reverted",
      blockNumber: r.blockNumber,
      gasUsed: r.gasUsed,
    };
  } catch (err) {
    if (err instanceof TransactionReceiptNotFoundError) return null;
    throw err;
  }
}

/**
 * Where a broadcast tx stands. With `sender` it can also be "dropped": no
 * receipt, yet the sender's mined nonce has moved past this tx's, so
 * another tx took its slot and it can never mine. The receipt is read a
 * second time after the nonce, so a node that indexed the nonce before the
 * receipt (or a load balancer mixing a lagging node in) cannot fake a drop,
 * and the RPC's chain id is checked so another chain's nonce cannot either.
 */
export async function receiptState(
  client: Client,
  hash: Hex,
  sender?: { from: Address; nonce: number },
): Promise<{ ok: true; receipt: ReceiptState } | Failure> {
  try {
    const first = await readReceipt(client, hash);
    if (first) return { ok: true, receipt: first };
    if (!sender) return { ok: true, receipt: { state: "pending" } };
    const [mined, served] = await Promise.all([
      client.getTransactionCount({ address: sender.from, blockTag: "latest" }),
      client.getChainId(),
    ]);
    // Another chain's nonce would fake a drop: a misconfigured RPC is an error.
    if (served !== client.chain.id) {
      return failure("CHAIN_MISMATCH", `The RPC serves chain ${served}, expected ${client.chain.id}.`);
    }
    if (mined <= sender.nonce) return { ok: true, receipt: { state: "pending" } };
    const second = await readReceipt(client, hash);
    return { ok: true, receipt: second ?? { state: "dropped", nonceNow: mined } };
  } catch (err) {
    return chainFailure(err);
  }
}

export interface Balances {
  chainId: number;
  address: Address;
  native: { symbol: string; wei: string; formatted: string };
  usdc: { address: Address; raw: string; decimals: number; formatted: string } | null;
  /** Why usdc is null when a token address is configured. */
  usdcError?: string;
}

export async function readBalances(
  client: Client,
  address: Address,
  usdc: Address | null,
): Promise<{ ok: true; balances: Balances } | Failure> {
  let wei: bigint;
  try {
    wei = await client.getBalance({ address });
  } catch (err) {
    return chainFailure(err);
  }
  const balances: Balances = {
    chainId: client.chain.id,
    address,
    native: {
      symbol: client.chain.nativeCurrency.symbol,
      wei: wei.toString(),
      formatted: formatUnits(wei, client.chain.nativeCurrency.decimals),
    },
    usdc: null,
  };
  if (usdc) {
    try {
      const [raw, decimals] = await Promise.all([
        client.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
        client.readContract({ address: usdc, abi: erc20Abi, functionName: "decimals" }),
      ]);
      balances.usdc = { address: usdc, raw: raw.toString(), decimals, formatted: formatUnits(raw, decimals) };
    } catch (err) {
      balances.usdcError = messageOf(err);
    }
  }
  return { ok: true, balances };
}
