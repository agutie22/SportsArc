/**
 * Live check of a gasless payment, end to end on WEB3_CHAIN with the real
 * relayer and database; only Circle is stood in for (a local key signs what
 * the PIN screen would):
 *
 *   node --env-file=.env --import=tsx api/web3/pay/check.ts
 *
 * Two temporary accounts with fresh wallets. The relayer gives the payer
 * one cent; the payer pays it to the other through startPayment and
 * confirmPayment. Checks the refusals on the way (a minor, an empty wallet,
 * a signature from the wrong key), that the payer's wallet never sent a
 * transaction, and that a second confirm sends nothing. Costs the relayer
 * about three cents of test USDC (two stay at the throwaway wallets, the
 * rest is gas). Deletes the accounts it creates.
 */

import { erc20Abi, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Notification } from "../../entities/Notification.js";
import { User } from "../../entities/User.js";
import { publicClient, relayer } from "../chains.js";
import { arcBlockchain, setCircleApi, type CircleWalletApi } from "../wallet/circle.js";
import { usdcAddress } from "../wallet/networks.js";
import { parseTypedDataJson } from "../wallet/signature.js";
import { UserSignature } from "../wallet/UserSignature.js";
import { Payment } from "./Payment.js";
import { cancelPayment, confirmPayment, listPayments, startPayment } from "./pay.js";

let failures = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  }
}

const code = (r: { ok: boolean; error?: { code: string } }) => (r.ok ? "ok" : r.error?.code);
const CENT = 10_000n;

async function main(): Promise<void> {
  const sender = relayer();
  const usdc = usdcAddress();
  if (!sender || !usdc) throw new Error("Set TESTNET_PRIVATE_KEY and a USDC address first.");
  const client = publicClient();
  const { initDb } = await import("../../db.js");
  const orm = await initDb();
  const em = orm.em.fork();

  const payerKey = privateKeyToAccount(generatePrivateKey());
  const strangerKey = privateKeyToAccount(generatePrivateKey());
  const payeeAddress = privateKeyToAccount(generatePrivateKey()).address;
  const made: string[] = [];
  const person = async (name: string, audience: string, wallet: string | null) => {
    const u = new User();
    u.name = `pay-check ${name}`;
    u.audience = audience;
    u.walletAddress = wallet;
    await em.persistAndFlush(u);
    made.push(u.id);
    return u;
  };

  // Circle, stood in for: the payer's Arc wallet, and the data it was asked to sign.
  let asked: string | null = null;
  const stub: CircleWalletApi = {
    userToken: async () => ({ userToken: "check-token", encryptionKey: "check-key" }),
    listWallets: async () => [
      { id: "check-wallet", address: payerKey.address, blockchain: arcBlockchain(), walletSetId: "check-set", state: "LIVE" },
    ],
    createEvmTestnetWallet: async () => "unused",
    signTransaction: async () => "unused",
    signTypedData: async ({ data }) => {
      asked = data;
      return "check-challenge";
    },
    challengeStatus: async () => "PENDING",
  };
  const pinSign = async (key: typeof payerKey): Promise<Hex> => {
    if (!asked) throw new Error("no typed data was sent to Circle");
    const data = parseTypedDataJson(asked);
    return key.signTypedData(data as Parameters<typeof key.signTypedData>[0]);
  };
  const balance = (address: `0x${string}`) =>
    client.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [address] });

  setCircleApi(stub);
  try {
    const payer = await person("payer", "adult", payerKey.address);
    const payee = await person("payee", "minor", payeeAddress);
    console.log("refusals");
    check("a minor cannot pay", code(await startPayment(em, payee, { userId: payer.id, amount: "0.01" })) === "NOT_ELIGIBLE");
    check("an empty wallet is told how much it is short",
      code(await startPayment(em, payer, { userId: payee.id, amount: "0.01" })) === "LOW_BALANCE");
    check("nothing was sent to Circle for either", asked === null);

    const fund = await sender.writeContract({ address: usdc, abi: erc20Abi, functionName: "transfer", args: [payerKey.address, CENT] });
    await client.waitForTransactionReceipt({ hash: fund });

    console.log("a payment");
    const started = await startPayment(em, payer, { userId: payee.id, amount: "0.01", note: "check" });
    check("starts with a challenge to sign", started.ok && "challenge" in started && started.challenge.challengeId === "check-challenge", started);
    if (!started.ok || !("payment" in started)) throw new Error("payment did not start");
    const id = started.payment.id;
    const message = asked ? parseTypedDataJson(asked) : null;
    check("asks for a TransferWithAuthorization of one cent to the payee",
      message?.primaryType === "TransferWithAuthorization" && message.message.value === CENT
        && message.message.to === payeeAddress && message.message.from === payerKey.address, message);

    check("confirm without a signature leaves it pending",
      (await confirmPayment(em, payer, id)).ok && (await em.findOneOrFail(Payment, { id })).status === "pending");
    check("a signature from another key is refused",
      code(await confirmPayment(em, payer, id, { signature: await pinSign(strangerKey) })) === "SIGNATURE_MISMATCH");
    check("and nothing moved", (await balance(payeeAddress)) === 0n);

    const signature = await pinSign(payerKey);
    const paid = await confirmPayment(em, payer, id, { signature });
    check("the payer's signature pays it", paid.ok && "payment" in paid && paid.payment.status === "paid" && Boolean(paid.payment.txHash), paid);
    check("the payee holds the cent", (await balance(payeeAddress)) === CENT);
    check("the payer holds nothing and sent no transaction",
      (await balance(payerKey.address)) === 0n && (await client.getTransactionCount({ address: payerKey.address })) === 0);
    const again = await confirmPayment(em, payer, id, { signature });
    check("confirming again changes nothing", again.ok && "payment" in again && again.payment.status === "paid"
      && (await balance(payeeAddress)) === CENT);
    check("the payee was told", (await em.count(Notification, { recipient: payee, kind: "paid" })) === 1);
    const listed = await listPayments(em, payee);
    check("it is in the payee's recent payments", listed.recent.some((p) => p.id === id && p.direction === "in"));

    console.log("backing out");
    const fund2 = await sender.writeContract({ address: usdc, abi: erc20Abi, functionName: "transfer", args: [payerKey.address, CENT] });
    await client.waitForTransactionReceipt({ hash: fund2 });
    const second = await startPayment(em, payer, { userId: payee.id, amount: "0.01" });
    if (!second.ok || !("payment" in second)) throw new Error("second payment did not start");
    const unsigned = await pinSign(payerKey);
    check("a payment never signed can be cancelled", code(await cancelPayment(em, payer, second.payment.id)) === "ok");
    check("its signature is then worthless",
      code(await confirmPayment(em, payer, second.payment.id, { signature: unsigned })) === "ok"
        && (await balance(payeeAddress)) === CENT && (await balance(payerKey.address)) === CENT);
  } finally {
    setCircleApi(undefined);
    await em.nativeDelete(Notification, { recipient: { $in: made } });
    await em.nativeDelete(Payment, { payer: { $in: made } });
    await em.nativeDelete(UserSignature, { user: { $in: made } });
    await em.nativeDelete(User, { id: { $in: made } });
    await orm.close(true);
  }
}

await main().catch((err) => {
  failures += 1;
  console.error(err instanceof Error ? err.stack ?? err.message : err);
});
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
