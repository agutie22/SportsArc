/**
 * Runnable checks for the cctp workstream (the repo has no test runner):
 *
 *   node --env-file=.env --import=tsx api/web3/cctp/check.ts [--live]
 *
 * 1. Pure logic, no network and no database: the v2 message codec and the
 *    burn/attestation match against a real recorded Arc -> HyperEVM burn
 *    (fixtures/arc-to-hyperevm.json; HyperEVM is a withdrawal destination),
 *    the Iris client against recorded response envelopes, calldata, testnet
 *    guards, amounts, backoff, and the minor refusal happening before
 *    anything else.
 * 2. With DATABASE_URL: starting withdrawals (M4 fails closed, validation,
 *    one in flight per user), the GET routes (a user sees only their own
 *    transfers), and advancing with nothing configured (errors recorded on
 *    the row, nothing thrown). Deletes what it creates.
 * 3. --live, read-only: every address and domain re-verified on Arc and on
 *    HyperEVM as a withdrawal destination, the recorded pair re-fetched and
 *    its attesters checked against the live attester set, and Iris sandbox
 *    reachability. For every withdrawal destination, Iris's forwarding
 *    quote and depositForBurnWithHook simulated on Arc; and for three
 *    source chains, the burn that adds money to a SportsArc wallet,
 *    simulated there. Moves no funds. If HTTPS_PROXY is set, run it with
 *    NODE_USE_ENV_PROXY=1 so Node's fetch uses the proxy.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  concat,
  createPublicClient,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  numberToHex,
  pad,
  slice,
  toFunctionSelector,
  toHex,
  zeroHash,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { arcTestnet, hyperliquidEvmTestnet } from "viem/chains";
import {
  messageTransmitterV2Abi,
  tokenMessengerV2Abi,
  tokenMinterAbi,
  usdcAbi,
} from "./abi.js";
import {
  ARC_TESTNET,
  CCTP_V2_TESTNET,
  HYPEREVM_TESTNET,
  IRIS_SANDBOX_URL,
  isTestnetChainId,
  refuseRoute,
  refuseUrl,
} from "./config.js";
import { irisClient, parseFeesResponse, parseMessagesResponse, type FetchFn, type IrisClient } from "./iris.js";
import { CCTP_TESTNETS, FORWARD_HOOK_DATA, clientFor } from "./config.js";
import {
  addressToBytes32,
  attestationSigners,
  burnMismatch,
  decodeBurnMessage,
  messagesSent,
  mintedAmount,
  sameBurn,
  type BurnExpectation,
} from "./message.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(HERE, "fixtures", "arc-to-hyperevm.json"), "utf8")) as {
  arc: { chainId: number; burnTx: Hex; blockNumber: string; from: Address; to: Address; logs: { address: Address; topics: Hex[]; data: Hex }[] };
  hyperevm: { chainId: number; receiveTx: Hex; message: Hex; attestation: Hex; nonce: Hex; attesters: Address[] };
  iris: Record<"complete" | "pending" | "notFound" | "rateLimited", { status: number; body: unknown }>;
};

let failures = 0;
let passed = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}`, detail === undefined ? "" : detail);
  }
}

function code(r: { ok: boolean; error?: { code: string } }): string {
  return r.ok ? "ok" : r.error?.code ?? "?";
}

/** Replace bytes [start, start+len) of a message. */
function patch(m: Hex, start: number, bytes: Hex): Hex {
  const len = (bytes.length - 2) / 2;
  return concat([slice(m, 0, start), bytes, slice(m, start + len)]);
}

// ── 1. pure ──

async function pure(): Promise<void> {
  console.log("messages (recorded Arc -> HyperEVM pair)");
  const sent = messagesSent(fixture.arc.logs, CCTP_V2_TESTNET.messageTransmitter);
  check("one MessageSent from the transmitter among the receipt's logs", sent.length === 1, sent.length);
  check("logs from other contracts are ignored", messagesSent(fixture.arc.logs, ARC_TESTNET.usdc).length === 0);
  const source = sent[0];
  const m = decodeBurnMessage(source);
  check("decodes", m !== null);
  if (!m) return;
  check("Arc -> HyperEVM domains", m.sourceDomain === 26 && m.destinationDomain === 19);
  check("emitted nonce and finality executed are zero", m.nonce === zeroHash && m.finalityThresholdExecuted === 0);
  check("burn token is Arc USDC", getAddress(m.body.burnToken) === getAddress(ARC_TESTNET.usdc));
  check("22 USDC", m.body.amount === 22_000_000n);

  const want: BurnExpectation = {
    sourceDomain: 26,
    destinationDomain: 19,
    tokenMessenger: CCTP_V2_TESTNET.tokenMessenger,
    burnToken: ARC_TESTNET.usdc,
    mintRecipient: m.body.mintRecipient,
    messageSender: fixture.arc.to, // this burn went through a router contract
    amount: 22_000_000n,
    maxFee: 0n,
    minFinalityThreshold: 1000,
  };
  check("matches its expectation", burnMismatch(m, want) === null, burnMismatch(m, want));
  check("a withdrawal expects the forwarding hook, so a plain burn does not match",
    burnMismatch(m, { ...want, hookData: FORWARD_HOOK_DATA }) === "unexpected hook data");

  console.log("withdrawals: chains and fees");
  check("forwarding hook is \"cctp-forward\", version 0, no Circle data (32 bytes)",
    FORWARD_HOOK_DATA.length === 66 && FORWARD_HOOK_DATA.startsWith("0x636374702d666f7277617264"));
  check("12 testnets, unique domains and chain ids, all testnet-guarded",
    CCTP_TESTNETS.length === 12
      && new Set(CCTP_TESTNETS.map((c) => c.domain)).size === 12
      && new Set(CCTP_TESTNETS.map((c) => c.chainId)).size === 12
      && CCTP_TESTNETS.every((c) => isTestnetChainId(c.chainId)));
  // Recorded from the Iris sandbox, 2026-11-04 (Arc -> Base Sepolia).
  const live = parseFeesResponse(200, JSON.stringify([
    { finalityThreshold: 1000, minimumFee: 0, forwardFee: { low: 54124, med: 54368, high: 54368 } },
    { finalityThreshold: 2000, minimumFee: 0, forwardFee: { low: 54124, med: 54368, high: 54368 } },
  ]));
  check("fees: recorded sandbox response parses at \"med\"", live.ok && live.fees.length === 2
    && live.fees[1].finalityThreshold === 2000 && live.fees[1].forwardFee === 54368n, live);
  const alt = parseFeesResponse(200, JSON.stringify([{ finalityThreshold: 2000, minimumFee: 1.3, forwardFee: { medium: 7 } }]));
  check("fees: the API reference's \"medium\" spelling parses too", alt.ok && alt.fees[0].forwardFee === 7n
    && alt.fees[0].minimumFeeBps === 1.3, alt);
  const noForward = parseFeesResponse(200, JSON.stringify([{ finalityThreshold: 2000, minimumFee: 0 }]));
  check("fees: no forwardFee is null, not 0", noForward.ok && noForward.fees[0].forwardFee === null);
  check("fees: 429 and junk are results", code(parseFeesResponse(429, "")) === "IRIS_RATE_LIMITED"
    && code(parseFeesResponse(200, "{}")) === "IRIS_BAD_RESPONSE");
  for (const [field, alt] of [
    ["amount", { amount: 21_000_000n }],
    ["mintRecipient", { mintRecipient: "0x1111111111111111111111111111111111111111" as Address }],
    ["messageSender", { messageSender: "0x1111111111111111111111111111111111111111" as Address }],
    ["destinationDomain", { destinationDomain: 3 }],
    ["maxFee", { maxFee: 1n }],
    ["tokenMessenger", { tokenMessenger: "0x1111111111111111111111111111111111111111" as Address }],
    ["minFinalityThreshold", { minFinalityThreshold: 2000 }],
  ] as const) {
    check(`a different ${field} is a mismatch`, burnMismatch(m, { ...want, ...alt }) !== null);
  }

  const attested = fixture.hyperevm.message;
  const a = decodeBurnMessage(attested);
  check("attested message is the burn with attester fields filled", sameBurn(source, attested));
  check("attested nonce is set, finality executed 2000", a?.nonce === fixture.hyperevm.nonce && a?.finalityThresholdExecuted === 2000);
  check("minted amount is amount - fee executed", a !== null && mintedAmount(a) === 22_000_000n);
  check("a changed amount is a different burn", !sameBurn(source, patch(attested, 148 + 68, pad(toHex(1n)))));
  check("a changed recipient is a different burn", !sameBurn(source, patch(attested, 148 + 36, pad("0x01"))));
  check("a changed nonce is the same burn", sameBurn(source, patch(attested, 12, keccak256("0x01"))));
  check("truncated bytes do not decode", decodeBurnMessage(slice(attested, 0, 200)) === null);

  const signers = await attestationSigners(attested, fixture.hyperevm.attestation);
  check("attestation recovers Circle's two testnet attesters, ascending",
    JSON.stringify(signers) === JSON.stringify(fixture.hyperevm.attesters)
      && signers !== null && BigInt(signers[0]) < BigInt(signers[1]), signers);
  check("a 64-byte attestation is malformed", (await attestationSigners(attested, slice(fixture.hyperevm.attestation, 0, 64))) === null);
  check("attestation over another message recovers other signers",
    JSON.stringify(await attestationSigners(source, fixture.hyperevm.attestation)) !== JSON.stringify(fixture.hyperevm.attesters));

  console.log("iris (recorded envelopes)");
  const text = (k: keyof typeof fixture.iris) => JSON.stringify(fixture.iris[k].body);
  const complete = parseMessagesResponse(200, text("complete"));
  check("complete: found, complete, carries the message and attestation",
    complete.ok && complete.found && complete.messages[0].complete
      && complete.messages[0].message === attested.toLowerCase()
      && complete.messages[0].attestation === fixture.hyperevm.attestation.toLowerCase());
  const pending = parseMessagesResponse(200, text("pending"));
  check("pending: found, not complete, no bytes",
    pending.ok && pending.found && !pending.messages[0].complete && pending.messages[0].message === null
      && pending.messages[0].attestation === null);
  const notFound = parseMessagesResponse(fixture.iris.notFound.status, text("notFound"));
  check("404: not found yet", notFound.ok && !notFound.found);
  check("429: rate limited", code(parseMessagesResponse(429, text("rateLimited"))) === "IRIS_RATE_LIMITED");
  check("5xx: unavailable", code(parseMessagesResponse(503, "")) === "IRIS_UNAVAILABLE");
  check("bad JSON", code(parseMessagesResponse(200, "<html>")) === "IRIS_BAD_RESPONSE");
  check("no messages array", code(parseMessagesResponse(200, "{}")) === "IRIS_BAD_RESPONSE");
  const empty = parseMessagesResponse(200, JSON.stringify({ messages: [] }));
  check("empty list: not found yet", empty.ok && !empty.found);
  const noAtt = parseMessagesResponse(200, JSON.stringify({ messages: [{ status: "complete", message: attested }] }));
  check("complete without an attestation is not complete", noAtt.ok && noAtt.found && !noAtt.messages[0].complete);

  let asked = "";
  const recorded: FetchFn = async (url) => {
    asked = url;
    return { status: 200, text: async () => text("complete") };
  };
  const viaClient = await irisClient(recorded, IRIS_SANDBOX_URL).messagesForTx(26, fixture.arc.burnTx);
  check("client asks /v2/messages/{domain}?transactionHash=",
    asked === `${IRIS_SANDBOX_URL}/v2/messages/26?transactionHash=${fixture.arc.burnTx}`, asked);
  check("client returns the parsed messages", viaClient.ok && viaClient.found);
  check("client refuses mainnet Iris", code(await irisClient(recorded, "https://iris-api.circle.com").messagesForTx(26, fixture.arc.burnTx)) === "NOT_CONFIGURED");
  check("client rejects a bad hash", code(await irisClient(recorded).messagesForTx(26, "0x1234")) === "VALIDATION_ERROR");
  const down: FetchFn = async () => {
    throw new Error("connect ECONNREFUSED");
  };
  check("network failure is a result, not a throw", code(await irisClient(down).messagesForTx(26, fixture.arc.burnTx)) === "IRIS_UNAVAILABLE");

  console.log("calldata");
  const recipient = getAddress("0x4228ad491653cea301e2276b340e6eb6bece37a9");
  const hooked = encodeFunctionData({
    abi: tokenMessengerV2Abi, functionName: "depositForBurnWithHook",
    args: [1_500_000n, 19, addressToBytes32(recipient), ARC_TESTNET.usdc, zeroHash, 0n, 2000, FORWARD_HOOK_DATA],
  });
  check("depositForBurnWithHook selector", slice(hooked, 0, 4) === toFunctionSelector(
    "depositForBurnWithHook(uint256,uint32,bytes32,address,bytes32,uint256,uint32,bytes)",
  ));
  const back = decodeFunctionData({ abi: tokenMessengerV2Abi, data: hooked });
  check("mint recipient is the wallet left-padded to 32 bytes",
    back.args?.[2] === `0x000000000000000000000000${recipient.slice(2).toLowerCase()}`);
  check("receiveMessage selector 0x57ecfd28", slice(encodeFunctionData({ abi: messageTransmitterV2Abi, functionName: "receiveMessage", args: ["0x", "0x"] }), 0, 4) === "0x57ecfd28");

  console.log("testnet guard");
  check("Arc testnet and HyperEVM testnet are allowed", isTestnetChainId(5_042_002) && isTestnetChainId(998));
  check("HyperEVM mainnet (999) and Ethereum (1) are not", !isTestnetChainId(999) && !isTestnetChainId(1));
  for (const url of ["https://rpc.testnet.arc.io", "https://rpc.testnet.arc.network", "https://rpc.hyperliquid-testnet.xyz/evm", IRIS_SANDBOX_URL, "http://127.0.0.1:8545"]) {
    check(`accepts ${url}`, refuseUrl(url) === null, refuseUrl(url));
  }
  for (const url of ["https://rpc.hyperliquid.xyz/evm", "https://api.hyperliquid.xyz/info", "https://iris-api.circle.com",
    "https://rpc.mainnet.arc.io", "https://rpc.arc.network", "https://eth-mainnet.g.alchemy.com/v2/k", "ftp://x"]) {
    check(`refuses ${url}`, refuseUrl(url) !== null);
  }
  const withdrawal = { source: ARC_TESTNET, destination: HYPEREVM_TESTNET };
  check("a withdrawal to HyperEVM is testnet", refuseRoute(withdrawal) === null);
  check("a mainnet chain id is refused", refuseRoute({ ...withdrawal, destination: { ...HYPEREVM_TESTNET, chainId: 999 } }) !== null);
  check("mainnet CCTP contracts are refused", refuseRoute({
    ...withdrawal, source: { ...ARC_TESTNET, tokenMessenger: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d" },
  }) !== null);

  console.log("amounts, backoff, eligibility");
  const { parseUsdcAmount, irisDelayMs, startWithdrawal } = await import("./transfer.js");
  check("1.5 USDC is 1500000 units", parseUsdcAmount("1.5") === 1_500_000n);
  check("smallest unit", parseUsdcAmount("0.000001") === 1n);
  for (const bad of ["0", "0.0", "1.0000001", "-1", "1e6", "abc", "", "100000000", 5]) {
    check(`rejects ${JSON.stringify(bad)}`, parseUsdcAmount(bad) === null);
  }
  check("backoff starts at 5 s", irisDelayMs(0) === 5_000);
  check("backoff doubles", irisDelayMs(3) === 40_000);
  check("backoff caps at 5 min", irisDelayMs(20) === 300_000);
  check("rate limit waits Circle's 5 min block", irisDelayMs(0, true) === 300_000);
  // M4 is checked before any database or chain access: a null em proves it.
  const noDb = null as unknown as Parameters<typeof startWithdrawal>[0];
  for (const audience of ["minor", null, undefined, "Adult", ""]) {
    const r = await startWithdrawal(noDb, { audience } as never, { amount: "1", destination: "hyperevmTestnet" });
    check(`audience ${JSON.stringify(audience)} is refused before anything else`, code(r) === "INELIGIBLE");
  }
}

// ── 2. database ──

interface FakeRes {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: string;
}

async function callRoute(path: string, cookie: string | null): Promise<{ status: number; body: any }> {
  const { match } = await import("../../router.js");
  const url = new URL(path, "http://localhost");
  const m = match("GET", url.pathname);
  if (!m) return { status: 404, body: null };
  const res: FakeRes = { statusCode: 200, headers: {}, body: "" };
  const fake = {
    get statusCode() { return res.statusCode; },
    set statusCode(v: number) { res.statusCode = v; },
    setHeader(k: string, v: string | string[]) { res.headers[k.toLowerCase()] = v; },
    end(b?: string) { res.body = b ?? ""; },
  } as unknown as ServerResponse;
  const req = { headers: cookie ? { cookie } : {} } as IncomingMessage;
  await m.handler({ req, res: fake, params: m.params, query: url.searchParams });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

function cookieFor(userId: string, set: (res: ServerResponse, s: { userId: string }) => void): string {
  let header = "";
  set({ setHeader: (_k: string, v: string | string[]) => { header = Array.isArray(v) ? v[0] : v; } } as unknown as ServerResponse, { userId });
  return header.split(";")[0];
}

async function database(): Promise<void> {
  if (!process.env.DATABASE_URL?.trim()) {
    console.log("database: skipped (no DATABASE_URL)");
    return;
  }
  console.log("database");
  const { initDb } = await import("../../db.js");
  const { User } = await import("../../entities/User.js");
  const { UserEvmWallet } = await import("../wallet/UserEvmWallet.js");
  const { setCircleApi } = await import("../wallet/circle.js");
  const { setSessionCookie, sessionSecretConfigured } = await import("../../auth/session.js");
  const { CctpTransfer } = await import("./CctpTransfer.js");
  const { startWithdrawal, advanceTransfer, setCctpDeps } = await import("./transfer.js");
  await import("./routes.js");

  const orm = await initDb();
  const em = orm.em.fork();
  const made: string[] = [];
  const mk = async (audience: string | null, withWallet: boolean) => {
    const u = new User();
    // Names are unique ignoring case, and this check makes more than one adult.
    u.name = `cctp-check ${audience ?? "unset"} ${u.id.slice(0, 8)}`;
    u.audience = audience;
    em.persist(u);
    if (withWallet) {
      const w = new UserEvmWallet();
      w.user = u;
      w.circleWalletId = "check-wallet";
      w.address = getAddress(`0x${keccak256(toHex(u.id)).slice(26)}`);
      em.persist(w);
    }
    await em.flush();
    made.push(u.id);
    return u;
  };

  try {
    const minor = await mk("minor", true);
    const unset = await mk(null, true);
    const adultNoWallet = await mk("adult", false);
    const adult = await mk("adult", true);
    const guardian = await mk("guardian", true);

    check("minor with a wallet is refused", code(await startWithdrawal(em, minor, { amount: "1", destination: "hyperevmTestnet" })) === "INELIGIBLE");
    check("unset audience is refused", code(await startWithdrawal(em, unset, { amount: "1", destination: "hyperevmTestnet" })) === "INELIGIBLE");
    check("refusals write nothing", (await em.count(CctpTransfer, { user: { $in: [minor, unset] } })) === 0);
    check("adult without a wallet", code(await startWithdrawal(em, adultNoWallet, { amount: "1", destination: "hyperevmTestnet" })) === "WALLET_NOT_READY");
    check("amount is validated", code(await startWithdrawal(em, adult, { amount: "0", destination: "hyperevmTestnet" })) === "VALIDATION_ERROR");

    const started = await startWithdrawal(em, adult, { amount: "2.5", destination: "hyperevmTestnet" });
    check("adult starts a withdrawal to HyperEVM", started.ok && started.transfer.state === "burn_approval"
      && started.transfer.forward && started.transfer.amount.units === "2500000"
      && started.transfer.source.domain === 26 && started.transfer.destination.domain === 19
      && started.transfer.destination.name === "HyperEVM", started);
    check("one transfer in flight per user", code(await startWithdrawal(em, adult, { amount: "1", destination: "baseSepolia" })) === "TRANSFER_IN_PROGRESS");
    const g = await startWithdrawal(em, guardian, { amount: "1", destination: "baseSepolia" });
    check("guardian starts a withdrawal", g.ok);
    if (!started.ok || !g.ok) return;
    const id = started.transfer.id;

    if (sessionSecretConfigured()) {
      const adultCookie = cookieFor(adult.id, setSessionCookie);
      const guardianCookie = cookieFor(guardian.id, setSessionCookie);
      const mine = await callRoute(`/api/web3/cctp/transfers/${id}`, adultCookie);
      check("GET own transfer: 200", mine.status === 200 && mine.body.transfer.id === id, mine);
      const theirs = await callRoute(`/api/web3/cctp/transfers/${id}`, guardianCookie);
      check("GET someone else's transfer: 404", theirs.status === 404 && theirs.body.error.code === "TRANSFER_NOT_FOUND", theirs);
      const list = await callRoute("/api/web3/cctp/transfers", guardianCookie);
      check("list shows only the caller's transfers", list.status === 200
        && list.body.transfers.length === 1 && list.body.transfers[0].id === g.transfer.id, list.body);
      check("signed out: 401", (await callRoute("/api/web3/cctp/transfers", null)).status === 401);
      check("bad id: 404", (await callRoute("/api/web3/cctp/transfers/not-a-uuid", adultCookie)).status === 404);
    } else {
      console.log("  skip routes (no SESSION_SECRET)");
    }

    // Nothing configured: chain down, Circle absent. Errors land on the row.
    const deadClient = createPublicClient({ chain: arcTestnet, transport: http("http://127.0.0.1:9") }) as PublicClient;
    setCctpDeps({ client: () => deadClient });
    const noChain = await advanceTransfer(orm.em.fork(), id);
    check("chain unreachable: recorded, retried later", noChain.ok && noChain.waitingOn === "retry"
      && noChain.transfer.lastError?.code === "CHAIN_UNAVAILABLE" && noChain.transfer.state === "burn_approval", noChain);

    const stubClient = {
      readContract: async () => 0n,
      call: async () => ({ data: "0x" }),
    } as unknown as PublicClient;
    setCctpDeps({ client: () => stubClient });
    setCircleApi(null);
    const noSign = await advanceTransfer(orm.em.fork(), id);
    check("without --sign it stops at the signature, opening nothing", noSign.ok && noSign.waitingOn === "signature"
      && noSign.challenge === null && noSign.transfer.stepTxId === null, noSign);
    const noCircle = await advanceTransfer(orm.em.fork(), id, { sign: true });
    check("burn approval on Arc reaches the EVM-TESTNET wallet: no Circle, NOT_CONFIGURED recorded",
      noCircle.ok && noCircle.transfer.lastError?.code === "NOT_CONFIGURED" && noCircle.transfer.stepTxId === null, noCircle);

    const locked = await orm.em.fork().transactional(async (tx) => {
      await tx.getConnection().execute(`select id from cctp_transfers where id = ? for update`, [id], "all", tx.getTransactionContext());
      return advanceTransfer(orm.em.fork(), id);
    });
    check("a transfer another worker holds is skipped", code(locked) === "TRANSFER_BUSY", locked);

    // Arc: the burned USDC and the gas come out of one balance.
    const gid = g.transfer.id;
    const richReads = {
      readContract: async () => 10n ** 18n,
      call: async () => ({ data: "0x" }),
    } as unknown as PublicClient;
    const prepared: unknown[] = [];
    const stubSigner = {
      async prepare(_em: unknown, _u: unknown, req: unknown) {
        prepared.push(req);
        return {
          ok: true as const,
          tx: { id: "00000000-0000-4000-8000-000000000001", status: "awaiting_signature" as const, chainId: 5_042_002, txHash: null, challengeId: "c" },
          challenge: null,
          // Enough for gas alone (1000 wei), not for gas plus the 1 USDC burn.
          gas: { requiredWei: "1000", balanceWei: String(10n ** 18n) } as never,
        };
      },
      async status() {
        return { ok: false as const, error: { code: "TX_NOT_FOUND", message: "gone" } };
      },
    };
    const freeIris: IrisClient = {
      async fees() {
        return { ok: true, fees: [{ finalityThreshold: 2000, minimumFeeBps: 0, forwardFee: 0n }] };
      },
      async messagesForTx() {
        return { ok: true, found: false };
      },
    };
    setCctpDeps({ client: () => richReads, signer: stubSigner, iris: freeIris });
    const arcGas = await advanceTransfer(orm.em.fork(), gid, { sign: true });
    check("burn prepared with maxFee 0 once the allowance is in place", arcGas.ok && arcGas.transfer.state === "burn"
      && arcGas.transfer.maxFee === "0" && prepared.length === 1, arcGas);
    check("a burn whose gas and amount exceed Arc's one USDC balance is flagged", arcGas.ok
      && arcGas.transfer.lastError?.code === "INSUFFICIENT_GAS" && /Arc/.test(arcGas.transfer.lastError.message), arcGas);

    // ── withdrawals (forwarded burns to any chain) ──
    const { quoteWithdrawal } = await import("./transfer.js");
    const withdrawer = await mk("adult", true);
    const other = "0x00000000000000000000000000000000000Beef1" as Address;
    check("withdraw: minor is refused", code(await startWithdrawal(em, minor, { amount: "1", destination: "baseSepolia" })) === "INELIGIBLE");
    check("withdraw: unknown destination", code(await startWithdrawal(em, withdrawer, { amount: "1", destination: "moon" })) === "VALIDATION_ERROR");
    check("withdraw: Arc to Arc is refused", code(await startWithdrawal(em, withdrawer, { amount: "1", destination: "arcTestnet" })) === "VALIDATION_ERROR");
    check("withdraw: bad recipient", code(await startWithdrawal(em, withdrawer, { amount: "1", destination: "baseSepolia", recipient: "0x12" })) === "VALIDATION_ERROR");
    check("withdraw: zero recipient", code(await startWithdrawal(em, withdrawer, { amount: "1", destination: "baseSepolia", recipient: "0x0000000000000000000000000000000000000000" })) === "VALIDATION_ERROR");

    // Iris stand-in: 1.3 bps protocol fee, 57543 forwarding fee ("med").
    let irisMessages: unknown[] = [];
    const stubIris: IrisClient = {
      async fees() {
        return { ok: true, fees: [{ finalityThreshold: 2000, minimumFeeBps: 1.3, forwardFee: 57_543n }] };
      },
      async messagesForTx() {
        return irisMessages.length ? { ok: true, found: true, messages: irisMessages as never } : { ok: true, found: false };
      },
    };
    setCctpDeps({ iris: stubIris });
    const q = await quoteWithdrawal({ amount: "10", destination: "baseSepolia" });
    // 10 USDC at 1.3 bps = 1300 units, plus 57543 forwarding.
    check("quote: forwarding fee plus protocol fee, rounded up", q.ok && q.fee === "0.058843"
      && q.receive === "9.941157" && q.destination.name === "Base", q);
    check("quote: an amount below the fee is refused", code(await quoteWithdrawal({ amount: "0.05", destination: "baseSepolia" })) === "AMOUNT_TOO_SMALL");

    const wd = await startWithdrawal(em, withdrawer, { amount: "10", destination: "baseSepolia", recipient: other.toLowerCase() });
    check("withdraw: starts to Base Sepolia for another address", wd.ok && wd.transfer.forward
      && wd.transfer.destination.domain === 6 && wd.transfer.destination.name === "Base"
      && wd.transfer.recipient === getAddress(other) && wd.transfer.source.domain === 26, wd);
    if (wd.ok) {
      const burnReqs: { to: Address; data: Hex; chainId: number }[] = [];
      const burnSigner = {
        async prepare(_em: unknown, _u: unknown, req: { to: Address; data: Hex; chainId: number }) {
          burnReqs.push(req);
          return {
            ok: true as const,
            tx: { id: "00000000-0000-4000-8000-000000000002", status: "awaiting_signature" as const, chainId: req.chainId, txHash: null, challengeId: "c" },
            challenge: null,
            gas: { requiredWei: "1", balanceWei: String(10n ** 30n) } as never,
          };
        },
        async status() {
          return { ok: false as const, error: { code: "TX_NOT_FOUND", message: "gone" } };
        },
      };
      setCctpDeps({ iris: stubIris, client: () => richReads, signer: burnSigner });
      const burned = await advanceTransfer(orm.em.fork(), wd.transfer.id, { sign: true });
      const req = burnReqs[0];
      const call = req ? decodeFunctionData({ abi: tokenMessengerV2Abi, data: req.data }) : null;
      const args = (call?.args ?? []) as readonly unknown[];
      check("withdraw: burns on Arc with depositForBurnWithHook", burned.ok && burned.transfer.state === "burn"
        && req?.chainId === ARC_TESTNET.chainId && call?.functionName === "depositForBurnWithHook", { burned, call });
      check("withdraw: burn mints to the named address on domain 6, any caller, forwarding hook",
        args[1] === 6 && args[2] === addressToBytes32(getAddress(other)) && args[4] === zeroHash
        && args[5] === 58_843n && args[6] === 2000 && args[7] === FORWARD_HOOK_DATA, args);

      // Pretend the burn landed and was attested; the receive is Circle's.
      const msg = fixture.hyperevm.message;
      await em.nativeUpdate(CctpTransfer, { id: wd.transfer.id }, {
        state: "receive", stepTxId: null, burnTxHash: fixture.arc.burnTx, sourceMessage: msg,
        attestedMessage: msg, attestation: fixture.hyperevm.attestation, nonce: fixture.hyperevm.nonce,
      });
      const noNonce = {
        readContract: async () => 0n,
        getTransactionReceipt: async () => { throw new Error("rpc down"); },
      } as unknown as PublicClient;
      setCctpDeps({ iris: stubIris, client: () => noNonce, signer: burnSigner });
      irisMessages = [{ status: "complete", complete: true, message: msg, attestation: fixture.hyperevm.attestation,
        cctpVersion: 2, delayReason: null, forwardState: "PENDING", forwardTxHash: null }];
      const pending = await advanceTransfer(orm.em.fork(), wd.transfer.id, { sign: true });
      check("forwarded receive: waits on Circle's relay, opens no signing request", pending.ok
        && pending.waitingOn === "relay" && pending.transfer.state === "receive" && burnReqs.length === 1, pending);
      await em.nativeUpdate(CctpTransfer, { id: wd.transfer.id }, { nextCheckAt: null });
      const mintHash = `0x${"ab".repeat(32)}` as Hex;
      irisMessages = [{ ...(irisMessages[0] as object), forwardState: "COMPLETE", forwardTxHash: mintHash }];
      const done = await advanceTransfer(orm.em.fork(), wd.transfer.id);
      check("forwarded receive: completes from Iris even with the destination RPC down", done.ok
        && done.transfer.state === "completed" && done.transfer.txs.receive === mintHash
        && done.transfer.mintedAmount !== null, done);
    }
    // ── adding money from an outside wallet ──
    const { recordFunding, advanceFundings, listFundings } = await import("./funding.js");
    const { CctpFunding } = await import("./CctpFunding.js");
    const funder = await mk("adult", false);
    funder.walletAddress = getAddress(`0x${keccak256(toHex(`fund:${funder.id}`)).slice(26)}`);
    const stranger = await mk("adult", false);
    stranger.walletAddress = getAddress(`0x${keccak256(toHex(`fund:${stranger.id}`)).slice(26)}`);
    minor.walletAddress = getAddress(`0x${keccak256(toHex(`fund:${minor.id}`)).slice(26)}`);
    await em.flush();
    const burnA = `0x${"a1".repeat(32)}` as Hex;
    const burnB = `0x${"b2".repeat(32)}` as Hex;
    check("fund: a minor is refused", code(await recordFunding(em, minor, { source: "baseSepolia", txHash: burnA })) === "INELIGIBLE");
    check("fund: the home chain is not a source", code(await recordFunding(em, funder, { source: "arcTestnet", txHash: burnA })) === "VALIDATION_ERROR");
    check("fund: a bad hash is refused", code(await recordFunding(em, funder, { source: "baseSepolia", txHash: "0x12" })) === "VALIDATION_ERROR");
    const fa = await recordFunding(em, funder, { source: "baseSepolia", txHash: burnA.toUpperCase().replace("0X", "0x") });
    check("fund: a reported burn is followed", fa.ok && fa.funding.state === "sent" && fa.funding.sourceName === "Base", fa);
    const faAgain = await recordFunding(em, funder, { source: "baseSepolia", txHash: burnA });
    check("fund: reporting it twice is one row", faAgain.ok && fa.ok && faAgain.funding.id === fa.funding.id);
    check("fund: someone else cannot claim that tx", code(await recordFunding(em, stranger, { source: "baseSepolia", txHash: burnA })) === "FUNDING_NOT_FOUND");
    const fb = await recordFunding(em, stranger, { source: "baseSepolia", txHash: burnB });

    // A burn to Arc for funder's wallet: the recorded message with its
    // destination domain and mint recipient rewritten.
    const toArc = (wallet: Address) =>
      patch(patch(fixture.hyperevm.message, 8, "0x0000001a"), 148 + 36, addressToBytes32(wallet));
    const mintHash = `0x${"cd".repeat(32)}` as Hex;
    const forFunder = toArc(funder.walletAddress as Address);
    irisMessages = [];
    setCctpDeps({ iris: stubIris, client: () => richReads });
    await advanceFundings(orm.em.fork());
    check("fund: nothing from Circle yet, still on its way",
      (await orm.em.fork().findOneOrFail(CctpFunding, { burnTxHash: burnA })).state === "sent");
    await em.nativeUpdate(CctpFunding, {}, { nextCheckAt: null });
    // Both rows see this message: it pays funder's wallet, not stranger's.
    irisMessages = [{ status: "complete", complete: true, message: forFunder, attestation: fixture.hyperevm.attestation,
      cctpVersion: 2, delayReason: null, forwardState: "COMPLETE", forwardTxHash: mintHash }];
    await advanceFundings(orm.em.fork());
    const arrived = await orm.em.fork().findOneOrFail(CctpFunding, { burnTxHash: burnA });
    const want = decodeBurnMessage(forFunder)!;
    check("fund: arrived, with what Circle minted", arrived.state === "arrived" && arrived.mintTxHash === mintHash
      && arrived.amount === want.body.amount.toString() && arrived.receivedAmount === mintedAmount(want).toString(), arrived);
    const notMine = await orm.em.fork().findOneOrFail(CctpFunding, { burnTxHash: burnB });
    check("fund: a burn that pays another wallet is not believed", fb.ok && notMine.state === "failed"
      && /does not send money to your SportsArc wallet/.test(notMine.lastError ?? ""), notMine);
    const mineList = await listFundings(orm.em.fork(), funder);
    check("fund: the list shows only the caller's", mineList.fundings.length === 1 && mineList.fundings[0].state === "arrived");
    setCctpDeps({ iris: stubIris });

    const self = await startWithdrawal(em, guardian, { amount: "1", destination: "sepolia" });
    check("withdraw: one transfer in flight per user, withdrawals included", code(self) === "TRANSFER_IN_PROGRESS");

    em.clear();
    await em.nativeUpdate(User, { id: adult.id }, { audience: "minor" });
    check("audience turned minor mid-transfer: advance refuses", code(await advanceTransfer(orm.em.fork(), id)) === "INELIGIBLE");
  } finally {
    setCctpDeps(undefined);
    setCircleApi(undefined);
    await em.nativeDelete(CctpTransfer, { user: { $in: made } });
    await em.getConnection().execute(`delete from cctp_fundings where user_id in (${made.map(() => "?").join(",") || "null"})`, made);
    await em.getConnection().execute(`delete from notifications where recipient_id in (${made.map(() => "?").join(",") || "null"})`, made);
    await em.nativeDelete(UserEvmWallet, { user: { $in: made } });
    await em.nativeDelete(User, { id: { $in: made } });
    await orm.close();
  }
}

// ── 3. live, read-only ──

async function live(): Promise<void> {
  console.log("live (read-only)");
  if (process.env.HTTPS_PROXY && process.env.NODE_USE_ENV_PROXY !== "1") {
    console.log("  note: HTTPS_PROXY is set; Node's fetch needs NODE_USE_ENV_PROXY=1 to use it");
  }
  const arc = createPublicClient({ chain: arcTestnet, transport: http() });
  const hl = createPublicClient({ chain: hyperliquidEvmTestnet, transport: http() });
  const { tokenMessenger: TM, messageTransmitter: MT, tokenMinter: MINT } = CCTP_V2_TESTNET;

  for (const [name, client, chain, remote] of [
    ["Arc", arc, ARC_TESTNET, HYPEREVM_TESTNET],
    ["HyperEVM", hl, HYPEREVM_TESTNET, ARC_TESTNET],
  ] as const) {
    const c = client as PublicClient;
    check(`${name}: chain id ${chain.chainId}`, (await c.getChainId()) === chain.chainId);
    for (const [label, addr] of [["TokenMessengerV2", TM], ["MessageTransmitterV2", MT], ["TokenMinterV2", MINT]] as const) {
      const code_ = await c.getCode({ address: addr });
      check(`${name}: ${label} has code`, Boolean(code_ && code_.length > 2));
    }
    const [domain, version, lmt, minter, bodyVersion, remoteTm, paused, threshold, minFee] = await Promise.all([
      c.readContract({ address: MT, abi: messageTransmitterV2Abi, functionName: "localDomain" }),
      c.readContract({ address: MT, abi: messageTransmitterV2Abi, functionName: "version" }),
      c.readContract({ address: TM, abi: tokenMessengerV2Abi, functionName: "localMessageTransmitter" }),
      c.readContract({ address: TM, abi: tokenMessengerV2Abi, functionName: "localMinter" }),
      c.readContract({ address: TM, abi: tokenMessengerV2Abi, functionName: "messageBodyVersion" }),
      c.readContract({ address: TM, abi: tokenMessengerV2Abi, functionName: "remoteTokenMessengers", args: [remote.domain] }),
      c.readContract({ address: MT, abi: messageTransmitterV2Abi, functionName: "paused" }),
      c.readContract({ address: MT, abi: messageTransmitterV2Abi, functionName: "signatureThreshold" }),
      c.readContract({ address: TM, abi: tokenMessengerV2Abi, functionName: "minFee" }),
    ]);
    check(`${name}: localDomain() = ${chain.domain}`, domain === chain.domain, domain);
    check(`${name}: message and body version 1`, version === 1 && bodyVersion === 1);
    check(`${name}: TokenMessenger wired to this transmitter and minter`,
      getAddress(lmt) === getAddress(MT) && getAddress(minter) === getAddress(MINT));
    check(`${name}: route to domain ${remote.domain} is open`, remoteTm.toLowerCase() === addressToBytes32(TM), remoteTm);
    check(`${name}: transmitter not paused`, paused === false);
    console.log(`       signatureThreshold ${threshold}, minFee ${minFee}`);
    const limit = await c.readContract({ address: MINT, abi: tokenMinterAbi, functionName: "burnLimitsPerMessage", args: [chain.usdc] });
    check(`${name}: USDC burn limit per message is set (${limit})`, limit > 0n);
    const decimals = await c.readContract({ address: chain.usdc, abi: usdcAbi, functionName: "decimals" });
    check(`${name}: USDC has 6 decimals`, decimals === 6);
  }
  const mapped = await hl.readContract({
    address: MINT, abi: tokenMinterAbi, functionName: "getLocalToken", args: [ARC_TESTNET.domain, addressToBytes32(ARC_TESTNET.usdc)],
  });
  check("HyperEVM mints HyperEVM USDC for Arc USDC", getAddress(mapped) === getAddress(HYPEREVM_TESTNET.usdc), mapped);

  console.log("live: recorded pair");
  // The recorded txs are from 2026-09; a public RPC that has pruned them is
  // a skip, not a failure (the fixture itself is checked in part 1).
  const receipt = await arc.getTransactionReceipt({ hash: fixture.arc.burnTx }).catch(() => null);
  if (!receipt) {
    console.log("  skip burn receipt: this Arc RPC no longer serves the recorded tx");
  } else {
    const liveMsgs = messagesSent(receipt.logs, MT);
    const recordedMsgs = messagesSent(fixture.arc.logs, MT);
    check("burn receipt re-fetched from Arc matches the fixture", liveMsgs.length === 1 && liveMsgs[0] === recordedMsgs[0]);
  }
  const rtx = await hl.getTransaction({ hash: fixture.hyperevm.receiveTx }).catch(() => null);
  if (!rtx) {
    console.log("  skip receive calldata: this HyperEVM RPC no longer serves the recorded tx");
  } else {
    const decoded = decodeFunctionData({ abi: messageTransmitterV2Abi, data: rtx.input });
    check("receive calldata re-fetched from HyperEVM matches the fixture",
      decoded.functionName === "receiveMessage" && decoded.args?.[0] === fixture.hyperevm.message
        && decoded.args?.[1] === fixture.hyperevm.attestation);
  }
  for (const attester of fixture.hyperevm.attesters) {
    const enabled = await hl.readContract({ address: MT, abi: messageTransmitterV2Abi, functionName: "isEnabledAttester", args: [attester] });
    check(`attester ${attester} is enabled on HyperEVM`, enabled);
  }
  const used = await hl.readContract({ address: MT, abi: messageTransmitterV2Abi, functionName: "usedNonces", args: [fixture.hyperevm.nonce] });
  check("recorded nonce is used on HyperEVM", used === 1n);

  console.log("live: Iris sandbox");
  const r = await irisClient().messagesForTx(ARC_TESTNET.domain, fixture.arc.burnTx);
  if (!r.ok && r.error.code === "IRIS_UNAVAILABLE") {
    console.log(`  skip Iris sandbox unreachable from here: ${r.error.message.slice(0, 160)}`);
  } else {
    const match = r.ok && r.found && r.messages.some((m) => m.complete && m.message === fixture.hyperevm.message.toLowerCase()
      && m.attestation === fixture.hyperevm.attestation.toLowerCase());
    check("Iris sandbox returns the recorded message and attestation", match, r);
  }
}

/**
 * Live, read-only: money out (a forwarded burn on Arc to every withdrawal
 * destination, HyperEVM included) and money in (a forwarded burn on another
 * chain, minting on Arc), each simulated with state overrides.
 */
async function liveMoneyInOut(): Promise<void> {
  const arc = clientFor(ARC_TESTNET);
  const TM = CCTP_V2_TESTNET.tokenMessenger;
  const from = getAddress("0x000000000000000000000000000000000000c0DE");
  // Arc USDC is FiatToken-shaped: allowances live in mapping slot 10, and
  // balanceOf reads the native balance (18 dp) scaled to 6 dp.
  const inner = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [from, 10n]));
  const allowanceSlot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [TM, inner]));
  const overrides = [
    { address: from, balance: 10n ** 19n },
    { address: ARC_TESTNET.usdc, stateDiff: [{ slot: allowanceSlot, value: pad(numberToHex(10n ** 12n)) }] },
  ];

  console.log("live: withdrawal (forwarded burn) simulated on Arc, and Iris's forwarding quotes");
  for (const dest of CCTP_TESTNETS.filter((c) => c.chainId !== ARC_TESTNET.chainId)) {
    const fees = await irisClient().fees(ARC_TESTNET.domain, dest.domain, true);
    if (!fees.ok && fees.error.code === "IRIS_UNAVAILABLE") {
      console.log(`  skip Iris sandbox unreachable from here: ${fees.error.message.slice(0, 160)}`);
      break;
    }
    const row = fees.ok ? fees.fees.find((f) => f.finalityThreshold === 2000) : undefined;
    check(`Iris quotes forwarding Arc -> ${dest.name}`, row?.forwardFee != null && row.forwardFee < 1_000_000n, fees);
    if (!row?.forwardFee) continue;
    const hooked = encodeFunctionData({
      abi: tokenMessengerV2Abi, functionName: "depositForBurnWithHook",
      args: [1_000_000n, dest.domain, addressToBytes32(from), ARC_TESTNET.usdc, zeroHash, row.forwardFee, 2000, FORWARD_HOOK_DATA],
    });
    const hg = await arc.estimateGas({ account: from, to: TM, data: hooked, stateOverride: overrides }).catch((e: Error) => e);
    check(`depositForBurnWithHook to ${dest.name} executes on live Arc`, typeof hg === "bigint", hg instanceof Error ? hg.message.slice(0, 200) : hg);
  }

  console.log("live: adding money (a forwarded burn on another chain, minting on Arc), simulated with state overrides");
  const { fundingSteps } = await import("./funding.js");
  const outside = getAddress("0x000000000000000000000000000000000000c0DE");
  const sportsArcWallet = getAddress("0x00000000000000000000000000000000000Beef1");
  for (const key of ["baseSepolia", "sepolia", "arbitrumSepolia"]) {
    const src = CCTP_TESTNETS.find((c) => c.key === key)!;
    // FiatToken layout: balances in mapping slot 9, allowances in slot 10.
    const balSlot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [outside, 9n]));
    const innerSlot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [outside, 10n]));
    const allowSlot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [src.tokenMessenger, innerSlot]));
    const funded = [
      { address: outside, balance: 10n ** 18n },
      { address: src.usdc, stateDiff: [
        { slot: balSlot, value: pad(numberToHex(10n ** 9n)) },
        { slot: allowSlot, value: pad(numberToHex(10n ** 9n)) },
      ] },
    ];
    // A never-used address: `outside` is a well-known one that people have sent testnet USDC to.
    const nobody = getAddress(`0x${keccak256(toHex(`${key}:${Date.now()}`)).slice(26)}`);
    const empty = await fundingSteps({ audience: "adult", walletAddress: sportsArcWallet } as never, { source: key, amount: "5", from: nobody });
    if (!empty.ok && /^IRIS_/.test(empty.error.code)) {
      console.log(`  skip Iris sandbox unreachable from here: ${empty.error.message.slice(0, 160)}`);
      break;
    }
    check(`${src.name}: an outside wallet with no money there is told so`, !empty.ok && empty.error.code === "INSUFFICIENT_USDC", empty);
    // The same request as a wallet that holds USDC there would get it.
    const fees = await irisClient().fees(src.domain, ARC_TESTNET.domain, true);
    const fast = fees.ok ? fees.fees.find((f) => f.finalityThreshold === 1000 && f.forwardFee !== null) : undefined;
    check(`${src.name}: Circle quotes a fast, forwarded transfer to Arc`, fast !== undefined, fees);
    if (!fast || fast.forwardFee === null) continue;
    const amount = 5_000_000n;
    const maxFee = fast.forwardFee + (amount * BigInt(Math.ceil(fast.minimumFeeBps * 100)) + 999_999n) / 1_000_000n;
    const data = encodeFunctionData({
      abi: tokenMessengerV2Abi, functionName: "depositForBurnWithHook",
      args: [amount, ARC_TESTNET.domain, addressToBytes32(sportsArcWallet), src.usdc, zeroHash, maxFee, 1000, FORWARD_HOOK_DATA],
    });
    const there = clientFor(src);
    const gasIn = await there.estimateGas({ account: outside, to: src.tokenMessenger, data, stateOverride: funded }).catch((e: Error) => e);
    check(`${src.name}: the burn to a SportsArc wallet on Arc executes (fee ${Number(maxFee) / 1e6} USDC)`,
      typeof gasIn === "bigint", gasIn instanceof Error ? gasIn.message.slice(0, 200) : gasIn);
  }
}

async function main(): Promise<void> {
  const liveMode = process.argv.includes("--live");
  await pure();
  await database();
  if (liveMode) {
    // The two halves need different networks; one being down must not hide the
    // other. Money in and out runs first: a hung destination RPC has been
    // seen to stall every later request in the process.
    for (const [name, run] of [["money in and out", liveMoneyInOut], ["routes and recorded pair", live]] as const) {
      try {
        await run();
      } catch (err) {
        check(`live (${name}) ran to the end`, false, err instanceof Error ? err.message.split("\n")[0] : err);
      }
    }
  }
  console.log(`\n${passed} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
