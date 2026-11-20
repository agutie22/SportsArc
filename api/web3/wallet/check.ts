/**
 * Runnable checks for the wallet workstream (the repo has no test runner):
 *
 *   node --env-file=.env --import=tsx api/web3/wallet/check.ts [--live]
 *
 * 1. Pure logic: eligibility, gas and fee math, wallet picking,
 *    signed-tx verification, allowed chains and per-chain RPC
 *    and USDC, the dropped-tx rule (with its lagging-node guard) on a
 *    scripted client, and typed data: the JSON sent to Circle, signature
 *    checks, and a USDC authorization's digest against Arc testnet's own
 *    constants. No network, no database.
 * 2. --live: read-only checks against Arc testnet through the wallet's
 *    client. Moves no funds. If HTTPS_PROXY is set, run it with
 *    NODE_USE_ENV_PROXY=1 so Node's fetch uses the proxy.
 */

import {
  TransactionReceiptNotFoundError,
  concat,
  encodeAbiParameters,
  erc20Abi,
  hashTypedData,
  keccak256,
  serializeTransaction,
  type Address,
  type Hex,
  type TransactionSerializableEIP1559,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { publicClient } from "../chains.js";
import { CHAIN_DEFAULTS } from "../../circle/chain-config.js";
import { EVM_TESTNET, pickEvmWallet, type CircleWallet } from "./circle.js";
import {
  buildTx,
  feeCap,
  fundsCheck,
  gasLimitFor,
  gasQuote,
  readBalances,
  receiptState,
  verifySignedTx,
  type Client,
} from "./tx.js";
import {
  allowedChainIds,
  defaultChainId,
  isAllowedChainId,
  rpcUrlFor,
  usdcAddress,
  usdcFor,
  walletClientFor,
} from "./networks.js";
import { mayTransact } from "./service.js";
import { authorizationArgs, authorizationOf, authorizationTypedData, newAuthorization } from "./authorization.js";
import { parseTypedDataJson, signedBy, typedDataJson, type TypedData } from "./signature.js";

let failures = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}`, detail === undefined ? "" : detail);
  }
}

function code(r: { ok: boolean; error?: { code: string } }): string {
  return r.ok ? "ok" : r.error?.code ?? "?";
}

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const apply = (v: Record<string, string | undefined>) => {
    for (const [k, value] of Object.entries(v)) {
      if (value === undefined) delete process.env[k];
      else process.env[k] = value;
    }
  };
  apply(vars);
  try {
    fn();
  } finally {
    apply(saved);
  }
}

// ── 1. pure logic ──

async function pure(): Promise<void> {
  console.log("pure logic");

  check("adult may transact", mayTransact({ audience: "adult" }));
  check("guardian may transact", mayTransact({ audience: "guardian" }));
  check("minor may not", !mayTransact({ audience: "minor" }));
  check("unset may not", !mayTransact({ audience: null }) && !mayTransact({}));
  check("unknown audience may not", !mayTransact({ audience: "Adult" }));

  check("fee cap is 2x base + tip", feeCap(100n, 7n) === 207n);
  check("transfer gas is exact", gasLimitFor(21_000n, false) === 21_000n);
  check("call gas gets 20% rounded up", gasLimitFor(50_001n, true) === 60_002n);
  const quote = gasQuote(21_000n, 100_000_000n, 0n);
  check("max cost is limit x cap", quote.maxCostWei === 21_000n * 200_000_000n);
  check("expected cost at base fee", quote.expectedCostWei === 21_000n * 100_000_000n);
  const short = fundsCheck(1_000n, 5n, quote);
  check("shortfall counts value and gas", short.shortfallWei === quote.maxCostWei + 5n - 1_000n && !short.sufficient);
  const flush = fundsCheck(quote.maxCostWei + 5n, 5n, quote);
  check("exact balance is sufficient", flush.sufficient && flush.shortfallWei === 0n);

  const addr = "0x1111111111111111111111111111111111111111";
  const other = "0x2222222222222222222222222222222222222222";
  const w = (id: string, blockchain: string, walletSetId: string, address = addr): CircleWallet =>
    ({ id, address, blockchain, walletSetId, state: "LIVE" });
  check("picks EVM-TESTNET in the Arc wallet set",
    pickEvmWallet([w("x", EVM_TESTNET, "s2", other), w("arc", "ARC-TESTNET", "s1"), w("e", EVM_TESTNET, "s1")], addr, "ARC-TESTNET")?.id === "e");
  check("falls back to the Arc address",
    pickEvmWallet([w("e", EVM_TESTNET, "s9")], addr.toUpperCase().replace("0X", "0x"), "ARC-TESTNET")?.id === "e");
  check("none when Circle lists no EVM-TESTNET wallet",
    pickEvmWallet([w("arc", "ARC-TESTNET", "s1")], addr, "ARC-TESTNET") === null);
  check("a stray wallet is returned so the caller can reject it",
    pickEvmWallet([w("x", EVM_TESTNET, "s2", other)], addr, "ARC-TESTNET")?.address === other);

  const ARC = CHAIN_DEFAULTS.arcTestnet.id;
  withEnv({ WEB3_CHAIN: undefined, WEB3_USDC_ADDRESS: undefined }, () =>
    check("USDC defaults to Arc's", usdcAddress() === CHAIN_DEFAULTS.arcTestnet.usdc));
  withEnv({ WEB3_CHAIN: "arcTestnet", WEB3_USDC_ADDRESS: other }, () =>
    check("WEB3_USDC_ADDRESS wins", usdcAddress() === other));
  withEnv({ WEB3_CHAIN: "arcTestnet", WEB3_USDC_ADDRESS: "0xnope" }, () =>
    check("an invalid WEB3_USDC_ADDRESS is not replaced by the default", usdcAddress() === null));

  // Chains: exactly WEB3_CHAINS (Arc testnet).
  check("the wallet serves Arc testnet", JSON.stringify(allowedChainIds()) === JSON.stringify([ARC]), allowedChainIds());
  check("mainnets and other testnets are not allowed",
    [1, 998, 999, 8453, 84_532, 5_042_001, 31_337].every((id) => !isAllowedChainId(id)));
  check("a chain id must be a number", !isAllowedChainId(String(ARC)) && !isAllowedChainId(ARC + 0.5) && !isAllowedChainId(null));
  check("client for a chain outside the list: CHAIN_NOT_ALLOWED", code(walletClientFor(1)) === "CHAIN_NOT_ALLOWED"
    && code(walletClientFor(998)) === "CHAIN_NOT_ALLOWED");

  withEnv({ WEB3_CHAIN: undefined, WEB3_RPC_URL: "http://shared", [`WALLET_RPC_URL_${ARC}`]: undefined }, () => {
    check("default chain is Arc testnet", defaultChainId() === ARC);
    check("WEB3_RPC_URL serves Arc", rpcUrlFor(ARC) === "http://shared");
    check("no RPC for a chain outside the list", rpcUrlFor(998) === null && rpcUrlFor(1) === null);
  });
  withEnv({ WEB3_CHAIN: "hyperevmTestnet", WEB3_RPC_URL: "http://shared", [`WALLET_RPC_URL_${ARC}`]: "http://arc" }, () => {
    check("an unknown WEB3_CHAIN is still Arc", defaultChainId() === ARC);
    check("WALLET_RPC_URL_<chainId> wins on Arc", rpcUrlFor(ARC) === "http://arc");
  });
  withEnv({ WEB3_CHAIN: "arcTestnet", WEB3_USDC_ADDRESS: other }, () =>
    check("USDC override applies on Arc and nowhere else",
      usdcFor(ARC) === other && usdcFor(998) === null && usdcFor(1) === null));
  withEnv({ WEB3_CHAIN: "arcTestnet", WEB3_USDC_ADDRESS: undefined }, () =>
    check("default USDC is Arc's", usdcAddress() === CHAIN_DEFAULTS.arcTestnet.usdc && usdcFor(998) === null));

  // Dropped: no receipt, and the sender's mined nonce is past the tx's.
  const hash = `0x${"ab".repeat(32)}` as Hex;
  const scripted = (receipts: (boolean | "down")[], minedNonce: number, servedChain = ARC) => {
    const calls = { receipt: 0, count: 0 };
    const client = {
      chain: { id: ARC },
      async getChainId() {
        return servedChain;
      },
      async getTransactionReceipt() {
        const r = receipts[Math.min(calls.receipt++, receipts.length - 1)];
        if (r === "down") throw new Error("socket hang up");
        if (!r) throw new TransactionReceiptNotFoundError({ hash });
        return { status: "success", blockNumber: 7n, gasUsed: 21_000n };
      },
      async getTransactionCount() {
        calls.count += 1;
        return minedNonce;
      },
    } as unknown as Client;
    return { client, calls };
  };
  const from = addr as Address;
  const pendingOne = scripted([false, false], 5);
  const pend = await receiptState(pendingOne.client, hash, { from, nonce: 5 });
  check("drop: nonce not yet used is pending", pend.ok && pend.receipt.state === "pending" && pendingOne.calls.receipt === 1);
  const dropOne = scripted([false, false], 6);
  const drop = await receiptState(dropOne.client, hash, { from, nonce: 5 });
  check("drop: nonce used and still no receipt is dropped, after a second read",
    drop.ok && drop.receipt.state === "dropped" && dropOne.calls.receipt === 2, drop);
  const lag = scripted([false, true], 6);
  const lagged = await receiptState(lag.client, hash, { from, nonce: 5 });
  check("drop: a receipt that shows up on the second read wins (lagging node)",
    lagged.ok && lagged.receipt.state === "confirmed");
  const noSender = scripted([false], 99);
  const bare = await receiptState(noSender.client, hash);
  check("drop: without the sender it is never inferred", bare.ok && bare.receipt.state === "pending" && noSender.calls.count === 0);
  check("drop: an RPC serving another chain is CHAIN_MISMATCH, not a drop",
    code(await receiptState(scripted([false, false], 6, 1).client, hash, { from, nonce: 5 })) === "CHAIN_MISMATCH");
  check("drop: an RPC failure is CHAIN_UNAVAILABLE, not a drop",
    code(await receiptState(scripted(["down"], 6).client, hash, { from, nonce: 5 })) === "CHAIN_UNAVAILABLE");

  const user = privateKeyToAccount(generatePrivateKey());
  const stranger = privateKeyToAccount(generatePrivateKey());
  const tx: TransactionSerializableEIP1559 = {
    type: "eip1559", chainId: ARC, nonce: 3, to: other, value: 1n, data: "0x",
    gas: 21_000n, maxFeePerGas: 200_000_000n, maxPriorityFeePerGas: 0n,
  };
  const unsigned = serializeTransaction(tx);
  const signed = await user.signTransaction(tx);
  const verified = await verifySignedTx(signed, unsigned, user.address);
  check("verify: accepts the prepared tx signed by the wallet", verified.ok);
  check("verify: wrong signer", code(await verifySignedTx(await stranger.signTransaction(tx), unsigned, user.address)) === "SIGNATURE_MISMATCH");
  check("verify: altered tx", code(await verifySignedTx(await user.signTransaction({ ...tx, value: 2n }), unsigned, user.address)) === "SIGNATURE_MISMATCH");
  check("verify: unsigned bytes", code(await verifySignedTx(unsigned, unsigned, user.address)) === "SIGNATURE_MISMATCH");
  check("verify: garbage", code(await verifySignedTx("0xdeadbeef", unsigned, user.address)) === "SIGNATURE_MISMATCH");
  const legacy = await user.signTransaction({ chainId: ARC, nonce: 3, to: other, value: 1n, gas: 21_000n, gasPrice: 1n });
  check("verify: legacy tx", code(await verifySignedTx(legacy, unsigned, user.address)) === "SIGNATURE_MISMATCH");

  console.log("typed data and USDC authorizations");
  // Arc testnet USDC's own constants, read from the token on 2026-11-13
  const ARC_DOMAIN_SEPARATOR = "0x361191522483d32a83e70ae7183b4b9629442c13a78bc9921d6f707911c8c6b0";
  const TRANSFER_TYPEHASH = "0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267";
  const RECEIVE_TYPEHASH = "0xd099cc98ef71107a616c4f0f941f04c322d8e254fe26b3c6668db87aae413de8";
  const arcUsdc = { name: "USDC", version: "2", chainId: 5_042_002, verifyingContract: CHAIN_DEFAULTS.arcTestnet.usdc };
  const auth = newAuthorization({ from: user.address, to: other, value: 12_345_678n });
  const digestWith = (typehash: Hex) => keccak256(concat(["0x1901", ARC_DOMAIN_SEPARATOR, keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }],
    [typehash, auth.from, auth.to, auth.value, auth.validAfter, auth.validBefore, auth.nonce],
  ))]));
  const transfer = authorizationTypedData("transfer", arcUsdc, auth);
  const receive = authorizationTypedData("receive", arcUsdc, auth);
  const digestOf = (d: TypedData) => hashTypedData(d as Parameters<typeof hashTypedData>[0]);
  check("transfer authorization digest is the token's", digestOf(transfer) === digestWith(TRANSFER_TYPEHASH));
  check("receive authorization digest is the token's", digestOf(receive) === digestWith(RECEIVE_TYPEHASH));
  check("an authorization is valid now and for an hour", auth.validAfter === 0n
    && auth.validBefore > BigInt(Math.floor(Date.now() / 1000)) && auth.nonce.length === 66);

  const json = typedDataJson(transfer);
  const forCircle = JSON.parse(json);
  check("the JSON for Circle has the domain type and decimal strings",
    Array.isArray(forCircle.types.EIP712Domain) && forCircle.message.value === "12345678" && forCircle.message.validAfter === "0");
  const back = parseTypedDataJson(json);
  check("it reads back to the same digest", digestOf(back) === digestOf(transfer) && authorizationOf(back).value === auth.value);
  const nested: TypedData = {
    domain: arcUsdc,
    types: { Outer: [{ name: "id", type: "bytes32" }, { name: "parts", type: "Part[]" }, { name: "bps", type: "uint16[]" }],
      Part: [{ name: "who", type: "address" }, { name: "amount", type: "uint256" }] },
    primaryType: "Outer",
    message: { id: auth.nonce, parts: [{ who: other, amount: 5n }, { who: user.address, amount: 2n ** 200n }], bps: [6000n, 3000n, 1000n] },
  };
  check("structs, arrays and big integers survive the JSON", digestOf(parseTypedDataJson(typedDataJson(nested))) === digestOf(nested));

  const sig = await user.signTypedData(transfer as Parameters<typeof user.signTypedData>[0]);
  check("signature: the signer's is accepted", await signedBy(user.address, back, sig));
  check("signature: another wallet's is refused", !(await signedBy(other, back, sig)));
  check("signature: for other data is refused", !(await signedBy(user.address, receive, sig)));
  check("signature: garbage is refused", !(await signedBy(user.address, back, "0x1234")));
  const args = authorizationArgs(auth, sig);
  check("call arguments carry v, r, s", args.length === 9 && (args[6] === 27 || args[6] === 28)
    && args[7] === sig.slice(0, 66) && args[8] === `0x${sig.slice(66, 130)}`);
}

// ── 2. live, read-only ──

async function live(): Promise<void> {
  console.log("live Arc testnet (read-only)");
  for (const k of ["WEB3_RPC_URL", "WEB3_USDC_ADDRESS", "WALLET_RPC_URL_5042002"]) delete process.env[k];
  delete process.env.WEB3_CHAIN;
  const ARC = CHAIN_DEFAULTS.arcTestnet.id;
  const client = publicClient();
  check("RPC is Arc testnet", (await client.getChainId()) === ARC);

  const token = usdcAddress();
  check("default USDC is Arc's", token === CHAIN_DEFAULTS.arcTestnet.usdc);
  if (token) {
    const [symbol, decimals] = await Promise.all([
      client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }),
      client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
    ]);
    check("default USDC is an ERC-20 USDC with 6 decimals", symbol === "USDC" && decimals === 6, { symbol, decimals });
  }

  const fresh = privateKeyToAccount(generatePrivateKey()).address;
  const read = await readBalances(client, fresh, token);
  check("balances read for a fresh address", read.ok && read.balances.usdc?.raw === "0", read);

  const built = await buildTx(client, {
    from: fresh, to: privateKeyToAccount(generatePrivateKey()).address, value: 0n, data: "0x",
  });
  check("a tx builds against live Arc, with the gas shortfall surfaced",
    built.ok && built.built.tx.chainId === ARC && built.built.tx.gas === 21_000n && !built.built.funds.sufficient,
    built);

  const arc = walletClientFor(ARC);
  check("Arc testnet client from the wallet's chain list", arc.ok && (await arc.client.getChainId()) === ARC);
  if (arc.ok) {
    const arcRead = await readBalances(arc.client, fresh, usdcFor(ARC));
    check("Arc balances: native USDC and the ERC-20 view, 6 dp", arcRead.ok && arcRead.balances.native.symbol === "USDC"
      && arcRead.balances.usdc?.decimals === 6 && arcRead.balances.usdc.raw === "0", arcRead);
  }
}

await pure();
if (process.argv.includes("--live")) await live();

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
