/**
 * Runnable checks for the gateway workstream:
 *
 *   node --env-file=.env --import=tsx api/web3/gateway/check.ts
 *
 * 1. Pure, no network and no database: the burn intent (padding, the salt
 *    per attempt, a signature that recovers to its signer), the testnet
 *    guard, the chains on offer, and the API client against responses
 *    recorded from the testnet API on 2026-11-10.
 * 2. With DATABASE_URL: saved payout addresses, and the payout machine with
 *    Circle, the chain and the wallet stood in for: the happy path, a payout
 *    smaller than the fee, a refused transfer, a lost answer (asked again
 *    with the same salt, paid once), a failed transfer, and the daily cap.
 *    Every failure ends in the player's SportsArc wallet. Deletes what it
 *    creates.
 *
 * e2e.ts runs the same code against the real testnet.
 */

import { randomUUID } from "node:crypto";
import { getAddress, keccak256, recoverTypedDataAddress, toHex, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { gatewayApi, type FetchFn, type GatewayApi } from "./api.js";
import { GATEWAY_TESTNET, gatewayApiUrl, payoutChainByKey, payoutChains, payoutSource } from "./config.js";
import { BURN_INTENT_TYPES, GATEWAY_DOMAIN, payoutSalt, signBurnIntent, transferSpec, type BurnIntent } from "./intent.js";

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

const recorded = (status: number, body: unknown): FetchFn => async () => ({ status, text: async () => JSON.stringify(body) });

async function pure(): Promise<void> {
  console.log("burn intent");
  const source = payoutSource();
  const base = payoutChainByKey("baseSepolia");
  check("WEB3_CHAIN is a chain Gateway serves", source !== null, process.env.WEB3_CHAIN);
  check("Base Sepolia is a payout chain; Linea and the home chain are not",
    base !== null && payoutChainByKey("lineaSepolia") === null && payoutChainByKey(source?.key) === null);
  if (!source || !base) return;
  check("ten chains on offer", payoutChains().length === 10, payoutChains().map((c) => c.key));

  const signer = privateKeyToAccount(generatePrivateKey());
  const recipient = getAddress("0x00000000000000000000000000000000000Beef1");
  const id = randomUUID();
  const spec = transferSpec({ source, destination: base, depositor: signer.address, recipient, value: 944_137n, salt: payoutSalt(id, 0) });
  check("addresses are left-padded to 32 bytes, lowercase",
    spec.sourceContract === `0x000000000000000000000000${GATEWAY_TESTNET.wallet.slice(2).toLowerCase()}`
    && spec.destinationRecipient === `0x000000000000000000000000${recipient.slice(2).toLowerCase()}`
    && spec.sourceDepositor === spec.sourceSigner, spec);
  check("any caller may mint (the forwarder)", BigInt(spec.destinationCaller) === 0n);
  check("domains: Arc 26 to Base 6", spec.sourceDomain === source.domain && spec.destinationDomain === 6);
  check("one attempt, one salt; a new attempt, a new salt",
    payoutSalt(id, 0) === payoutSalt(id, 0) && payoutSalt(id, 0) !== payoutSalt(id, 1) && payoutSalt(id, 0) !== payoutSalt(randomUUID(), 0));
  const intent: BurnIntent = { maxBlockHeight: 73_162_273n, maxFee: 55_863n, spec };
  const signature = await signBurnIntent(signer, intent);
  const who = await recoverTypedDataAddress({
    domain: GATEWAY_DOMAIN, types: BURN_INTENT_TYPES, primaryType: "BurnIntent", message: intent, signature,
  });
  check("the signature recovers to the payout wallet", who === signer.address);

  console.log("testnet guard");
  const saved = process.env.GATEWAY_API_URL;
  process.env.GATEWAY_API_URL = "https://gateway-api.circle.com";
  check("the mainnet API is refused", gatewayApiUrl() === null);
  const refused = await gatewayApi(recorded(200, {})).status("29890230-ab6d-47b3-9bf3-d46b017bea10");
  check("and the client answers NOT_CONFIGURED", !refused.ok && refused.error.code === "NOT_CONFIGURED");
  if (saved === undefined) delete process.env.GATEWAY_API_URL;
  else process.env.GATEWAY_API_URL = saved;
  check("the testnet API is the default", gatewayApiUrl() === "https://gateway-api-testnet.circle.com" || Boolean(saved));

  console.log("API client (recorded testnet responses)");
  const url = "https://gateway-api-testnet.circle.com";
  const bal = await gatewayApi(recorded(200, {
    token: "USDC", balances: [{ domain: 26, depositor: signer.address, balance: "1.000000", pendingBatch: "0" }],
  }), url).balance(26, signer.address);
  check("balance \"1.000000\" is 1000000 units", bal.ok && bal.balance === 1_000_000n, bal);
  const est = await gatewayApi(recorded(200, {
    body: [{ burnIntent: { maxBlockHeight: "73162273", maxFee: "55863", spec: {} } }],
    fees: { token: "USDC", total: "0.055863", forwardingFee: "0.052363" },
  }), url).estimate(spec);
  check("estimate: max fee and expiry", est.ok && est.maxFee === 55_863n && est.maxBlockHeight === 73_162_273n, est);
  const tr = await gatewayApi(recorded(201, {
    transferId: "29890230-ab6d-47b3-9bf3-d46b017bea10", fees: { total: "0.055863" }, expirationBlock: "57146527",
  }), url).transfer(intent, signature);
  check("transfer: the id", tr.ok && tr.transferId === "29890230-ab6d-47b3-9bf3-d46b017bea10", tr);
  const st = await gatewayApi(recorded(200, {
    destinationDomain: 6, status: "confirmed",
    transactionHash: "0x1986f64c7ae81464a91407a57917e79734a91187190c2fcb1325d7c384e37514",
    forwardingDetails: { forwardingEnabled: true },
  }), url).status("29890230-ab6d-47b3-9bf3-d46b017bea10");
  check("status: confirmed with the mint's hash", st.ok && st.status === "confirmed" && st.txHash?.startsWith("0x1986") === true, st);
  const no = await gatewayApi(recorded(400, { code: 400, message: "insufficient balance" }), url).transfer(intent, signature);
  check("a 4xx is a refusal: nothing moved", !no.ok && no.rejected && /insufficient balance/.test(no.error.message), no);
  const down = await gatewayApi(recorded(503, {}), url).transfer(intent, signature);
  check("a 5xx is unknown, not a refusal", !down.ok && !down.rejected && down.error.code === "GATEWAY_UNAVAILABLE", down);
  const dead: FetchFn = async () => { throw new Error("socket hang up"); };
  const lost = await gatewayApi(dead, url).status("29890230-ab6d-47b3-9bf3-d46b017bea10");
  check("a network failure is a result, not a throw", !lost.ok && !lost.rejected, lost);
}

async function database(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.log("database\n  skip (no DATABASE_URL)");
    return;
  }
  console.log("database");
  const { initDb } = await import("../../db.js");
  const { User } = await import("../../entities/User.js");
  const { Notification } = await import("../../entities/Notification.js");
  const { GatewayPayout } = await import("./GatewayPayout.js");
  const { PayoutDestination } = await import("./PayoutDestination.js");
  const { payoutOptions, removeDestination, resolveChoice } = await import("./destinations.js");
  const { advancePayout, listPayouts, setPayoutDeps } = await import("./payouts.js");

  const orm = await initDb();
  const em = orm.em.fork();
  const made: string[] = [];
  const person = async (audience: string) => {
    const u = new User();
    // Names are unique (users_name_lower_unique), and a run may make two of one audience.
    u.name = `gateway-check ${audience} ${u.id.slice(0, 8)}`;
    u.audience = audience;
    u.walletAddress = getAddress(`0x${keccak256(toHex(u.id)).slice(26)}`);
    em.persist(u);
    await em.flush();
    made.push(u.id);
    return u;
  };
  const code = (r: { ok: boolean; error?: { code: string } }) => (r.ok ? "ok" : r.error?.code ?? "?");

  try {
    const alice = await person("adult");
    const bob = await person("adult");
    const dest = getAddress("0x00000000000000000000000000000000000Beef1");

    // ── saved addresses ──
    const none = await resolveChoice(em, alice, "wallet");
    check("\"wallet\" is no choice at all", none.ok && none.choice === null);
    check("an unknown chain is refused", code(await resolveChoice(em, alice, { chain: "moon", address: dest })) === "VALIDATION_ERROR");
    check("the home chain is refused", code(await resolveChoice(em, alice, { chain: "arcTestnet", address: dest })) === "VALIDATION_ERROR");
    check("a bad address is refused", code(await resolveChoice(em, alice, { chain: "baseSepolia", address: "0x12" })) === "VALIDATION_ERROR");
    const first = await resolveChoice(em, alice, { chain: "baseSepolia", address: dest.toLowerCase() });
    check("a new address is accepted, checksummed", first.ok && first.choice?.address === dest && first.choice.chainKey === "baseSepolia", first);
    await resolveChoice(em, alice, { chain: "baseSepolia", address: dest });
    const opts = await payoutOptions(em, alice);
    check("and saved once", opts.saved.length === 1 && opts.saved[0].chainName === "Base", opts.saved);
    const again = await resolveChoice(em, alice, { destinationId: opts.saved[0].id });
    check("a saved address is chosen by id", again.ok && again.choice?.address === dest);
    check("someone else's saved address is not found", code(await resolveChoice(em, bob, { destinationId: opts.saved[0].id })) === "DESTINATION_NOT_FOUND");
    check("nor removable by them", code(await removeDestination(em, bob, opts.saved[0].id)) === "DESTINATION_NOT_FOUND");
    check("its owner removes it", (await removeDestination(em, alice, opts.saved[0].id)).ok && (await em.count(PayoutDestination, { user: alice })) === 0);

    // ── the payout machine ──
    const wallet = privateKeyToAccount(generatePrivateKey());
    const writes: { functionName: string; args: readonly unknown[] }[] = [];
    const chain = {
      readContract: async ({ functionName }: { functionName: string }) => (functionName === "allowance" ? 0n : 10n ** 12n),
      waitForTransactionReceipt: async () => ({ status: "success" as const }),
      getTransactionReceipt: async () => ({ status: "success" as const }),
    };
    const walletStub = {
      account: wallet,
      writeContract: async (req: { functionName: string; args: readonly unknown[] }) => {
        writes.push({ functionName: req.functionName, args: req.args });
        return `0x${(writes.length).toString(16).padStart(64, "0")}` as Hex;
      },
    };
    interface Script {
      fee?: bigint;
      estimate?: "reject";
      transfer?: ("ok" | "reject" | "unknown")[];
      status?: ("pending" | "confirmed" | "failed" | "expired")[];
    }
    const salts: Hex[] = [];
    const api = (s: Script): GatewayApi => ({
      balance: async () => ({ ok: true, balance: 10n ** 12n }),
      estimate: async () => (s.estimate === "reject"
        ? { ok: false, rejected: true, error: { code: "GATEWAY_REJECTED", message: "no route" } }
        : { ok: true, maxFee: s.fee ?? 55_863n, maxBlockHeight: 99n }),
      transfer: async (intent) => {
        salts.push(intent.spec.salt);
        const next = s.transfer?.shift() ?? "ok";
        if (next === "ok") return { ok: true, transferId: randomUUID() };
        return { ok: false, rejected: next === "reject", error: { code: next === "reject" ? "GATEWAY_REJECTED" : "GATEWAY_UNAVAILABLE", message: next } };
      },
      status: async () => ({
        ok: true, status: s.status?.shift() ?? "confirmed", txHash: `0x${"ab".repeat(32)}`, failureReason: null,
      }),
    });
    let clock = Date.now();
    const use = (s: Script) => {
      clock = Date.now(); // each case starts with a fresh payout, so a fresh clock
      writes.length = 0;
      salts.length = 0;
      setPayoutDeps({ api: api(s), wallet: () => walletStub as never, client: () => chain as never, now: () => new Date(clock) });
    };
    const queue = async (user: InstanceType<typeof User>, amount: bigint) => {
      const p = new GatewayPayout();
      p.user = user;
      p.sourceKey = `check:${randomUUID()}`;
      p.amount = amount.toString();
      p.destChainKey = "baseSepolia";
      p.destAddress = dest;
      em.persist(p);
      await em.flush();
      return p.id;
    };
    /** Run the machine until it settles, letting time pass between passes. */
    const drive = async (id: string, passes = 12) => {
      let p = null;
      for (let i = 0; i < passes; i++) {
        p = await advancePayout(orm.em.fork(), id);
        if (p && (p.state === "completed" || p.state === "fallback")) break;
        clock += 6 * 60_000;
      }
      return p!;
    };

    use({ status: ["pending", "confirmed"] });
    const happy = await drive(await queue(alice, 1_000_000n));
    check("happy path: completed, the fee out of the payout", happy.state === "completed"
      && happy.fee === "55863" && happy.sentAmount === "944137" && happy.destTxHash !== null, happy);
    check("it approved Gateway, deposited the exact amount, and sent nothing else",
      writes.map((w) => w.functionName).join(",") === "approve,deposit" && writes[1].args[1] === 1_000_000n, writes);
    check("one transfer, for the payout's own salt", salts.length === 1 && salts[0] === payoutSalt(happy.id, 0), salts);
    check("the player is told", (await em.count(Notification, { recipient: alice, kind: "payout_sent" })) === 1);
    const view = (await listPayouts(orm.em.fork(), alice)).payouts.find((p) => p.id === happy.id);
    check("their list shows it arrived, with a receipt", view?.state === "completed" && view.sentUsdc === "0.944137"
      && view.receipt?.includes("basescan") === true && view.toWallet === false, view);
    check("another player's list does not", (await listPayouts(orm.em.fork(), bob)).payouts.length === 0);

    use({ fee: 60_000n });
    const small = await drive(await queue(alice, 50_000n));
    check("smaller than the fee: paid to the SportsArc wallet in full", small.state === "fallback"
      && writes.length === 1 && writes[0].functionName === "transfer"
      && writes[0].args[0] === getAddress(alice.walletAddress as Address) && writes[0].args[1] === 50_000n, { small, writes });
    check("nothing was deposited or sent to Circle for it", salts.length === 0 && small.depositTxHash === null);
    check("and the player is told why", /network fee/.test(small.fallbackReason ?? "")
      && (await em.count(Notification, { recipient: alice, kind: "payout_wallet" })) === 1, small.fallbackReason);

    use({ transfer: ["reject", "ok"] });
    const retried = await drive(await queue(bob, 2_000_000n));
    check("a refused transfer is tried again with a new salt, and paid once", retried.state === "completed"
      && salts.length === 2 && salts[0] === payoutSalt(retried.id, 0) && salts[1] === payoutSalt(retried.id, 1)
      && writes.filter((w) => w.functionName === "deposit").length === 1, { salts, writes });

    use({ transfer: ["unknown", "ok"] });
    const lost = await drive(await queue(bob, 2_000_000n));
    check("a lost answer is asked again with the same salt", lost.state === "completed"
      && salts.length === 2 && salts[0] === salts[1] && salts[0] === payoutSalt(lost.id, 0), salts);

    use({ transfer: ["reject", "reject", "reject", "reject", "reject", "reject", "reject", "reject"] });
    const refusedOut = await drive(await queue(bob, 2_000_000n), 20);
    check("refused for good: paid to the SportsArc wallet", refusedOut.state === "fallback"
      && writes.at(-1)?.functionName === "transfer" && writes.at(-1)?.args[1] === 2_000_000n, refusedOut);

    use({ status: ["pending", "failed"] });
    const failed = await drive(await queue(bob, 2_000_000n));
    check("a transfer that failed on the other network: paid to the SportsArc wallet", failed.state === "fallback"
      && /failed/.test(failed.fallbackReason ?? ""), failed);

    use({ estimate: "reject" });
    const noRoute = await drive(await queue(bob, 2_000_000n));
    check("no route quoted: paid to the SportsArc wallet, nothing deposited", noRoute.state === "fallback"
      && noRoute.depositTxHash === null, noRoute);

    const savedCap = process.env.GATEWAY_DAILY_CAP_USDC;
    process.env.GATEWAY_DAILY_CAP_USDC = "1";
    use({});
    const capped = await drive(await queue(bob, 2_000_000n));
    check("over the daily cap: paid to the SportsArc wallet", capped.state === "fallback"
      && /limit/.test(capped.fallbackReason ?? "") && salts.length === 0, capped);
    if (savedCap === undefined) delete process.env.GATEWAY_DAILY_CAP_USDC;
    else process.env.GATEWAY_DAILY_CAP_USDC = savedCap;
  } finally {
    setPayoutDeps(undefined);
    await em.nativeDelete(Notification, { recipient: { $in: made } });
    await em.nativeDelete(GatewayPayout, { user: { $in: made } });
    await em.nativeDelete(PayoutDestination, { user: { $in: made } });
    await em.nativeDelete(User, { id: { $in: made } });
    await orm.close(true);
  }
}

async function main(): Promise<void> {
  await pure();
  await database();
  console.log(`\n${passed} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

void main();
