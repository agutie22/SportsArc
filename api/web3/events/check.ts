/**
 * Runnable checks for the events workstream's pure logic (no database, no
 * chain): the platform fee, prize shares and splits, team keys, and the
 * EIP-712 vector that contracts/test/EventVault.t.sol also asserts (one
 * message of every kind anyone signs), so TypeScript and Solidity cannot
 * drift apart unnoticed. When contracts/out exists (forge build), the ABI
 * is also compared with the compiled contract.
 *
 *   node --import=tsx api/web3/events/check.ts
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getAddress, hashDomain, keccak256, toEventSelector, toFunctionSelector, toHex, type Abi, type AbiEvent, type AbiFunction,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { gameKey } from "../ids.js";
import { parseTypedDataJson, signedBy, typedDataJson } from "../wallet/signature.js";
import {
  SPLIT_PRESETS, cancelDigest, cancelTypedData, chainStatus, entryDigest, entryPermitDigest, entryTypedData,
  eventVaultAbi, feeOn, isRefundable, isSettled, leaveDigest, leaveTypedData, prizeDigest, prizePermitDigest,
  prizeShare, resultDeadlineFor, resultDigest, resultTypedData, signEntryPermit, signPrizePermit, signResult,
  soloTeamKey, termsDigest, termsTypedData, validSplit, vaultDomain,
  type EntryMessage, type EventTermsMessage, type PrizeMessage, type ResultMessage,
} from "./protocol.js";

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`ok  ${name}`);
}

await check("platform fee: 1% plus the gas fee, never more than the entry", () => {
  assert.equal(feeOn(10_000_000n, 100, 10_000n), 110_000n); // $10 -> 11 cents
  assert.equal(feeOn(100_000n, 100, 10_000n), 11_000n);
  assert.equal(feeOn(5_000n, 100, 10_000n), 5_000n); // clamped to the entry
  assert.equal(feeOn(0n, 100, 10_000n), 0n);
  assert.equal(feeOn(10_000_000n, 0, 0n), 0n);
  // 20 players at $10: the host receives $197.80.
  assert.equal((10_000_000n - feeOn(10_000_000n, 100, 10_000n)) * 20n, 197_800_000n);
});

await check("prize shares: split by place, then evenly inside a team, rounding down", () => {
  const top3 = SPLIT_PRESETS.top3;
  assert.equal(prizeShare(200_000_000n, top3, 1), 120_000_000n);
  assert.equal(prizeShare(200_000_000n, top3, 2), 60_000_000n);
  assert.equal(prizeShare(200_000_000n, top3, 3), 20_000_000n);
  assert.equal(prizeShare(200_000_000n, top3, 4), 0n);
  assert.equal(prizeShare(200_000_000n, top3, 0), 0n);
  assert.equal(prizeShare(100n, top3, 1, 7), 8n); // 60 / 7
  assert.equal(prizeShare(200_000_000n, SPLIT_PRESETS.winner, 1), 200_000_000n);
});

await check("splits: 1 to 8 non-zero shares that sum to 10000", () => {
  for (const preset of Object.values(SPLIT_PRESETS)) assert.ok(validSplit([...preset]));
  assert.ok(!validSplit([]));
  assert.ok(!validSplit([5_000, 4_000]));
  assert.ok(!validSplit([10_000, 0]));
  assert.ok(!validSplit([1_250, 1_250, 1_250, 1_250, 1_250, 1_250, 1_250, 625, 625]));
  assert.ok(!validSplit([5_000.5, 4_999.5]));
  assert.ok(!validSplit("top3"));
});

await check("statuses: what is settled and what is refundable", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 9].map(chainStatus), ["none", "open", "cancelled", "void", "posted", "final", "expired", "none"]);
  assert.deepEqual(["open", "posted", "none"].map((s) => isSettled(s as "open")), [false, false, false]);
  assert.deepEqual(["final", "cancelled", "void", "expired"].map((s) => isSettled(s as "final")), [true, true, true, true]);
  assert.ok(!isRefundable("final") && isRefundable("void"));
});

await check("the result deadline is three days after the game ends", () => {
  assert.equal(resultDeadlineFor(new Date(1_800_000_000_000), 90), 1_800_000_000n + 5_400n + 259_200n);
});

// The vector contracts/test/EventVault.t.sol asserts (test_vector_matchesTypeScript).
const D = { chainId: 5_042_002, vault: getAddress("0xe7e0000000000000000000000000000000000002") };
const eventId = gameKey("3F2B8C1E-5D4A-4B6C-9E7F-0123456789AB");
const player = getAddress("0x00000000000000000000000000000000000000a1");
const team = soloTeamKey(player);
const terms: EventTermsMessage = {
  eventId,
  organizer: getAddress("0x00000000000000000000000000000000000000b1"),
  entryFee: 10_000_000n,
  minEntrants: 4,
  minAttendees: 3,
  startsAt: 1_800_000_000n,
  registrationClosesAt: 1_799_996_400n,
  resultDeadline: 1_800_259_200n,
};
const entry: EntryMessage = { eventId, player, teamKey: team, routed: true, attempt: 2 };
const prize: PrizeMessage = {
  eventId,
  sponsor: getAddress("0x00000000000000000000000000000000000000c1"),
  amount: 200_000_000n,
  split: [6_000, 3_000, 1_000],
  salt: toHex(7, { size: 32 }),
};
const result: ResultMessage = { eventId, placements: [team, keccak256(toHex("team b"))], attendees: 9, revision: 1 };

await check("EIP-712 vector matches the Foundry test (every message kind)", () => {
  assert.equal(eventId, "0x6b490ae47c7f8c70f3220d5928509c0916f4df7d71d5e9e74088e293ac024770");
  assert.equal(hashDomain({ domain: { ...vaultDomain(D), chainId: BigInt(D.chainId) }, types: { EIP712Domain: [
    { name: "name", type: "string" }, { name: "version", type: "string" },
    { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" },
  ] } }), "0xf2593530fb2c0bd95f7c0111a52e8f1b7966c66d36a2f857f3df58e48458d16f");
  assert.equal(team, "0xaadc37b8ba5645e62f4546802db221593a94729ccbfc5a97d01365a88f649878");
  assert.equal(termsDigest(D, terms), "0x8a1bbd061409a19f2cc1b7e8a459439048b9031cc893faa763bb5a2c93538075");
  assert.equal(entryDigest(D, entry), "0x4844397a44e70e47690da05febaf6de40b6f8fa16e05567f71b65829e5a30894");
  assert.equal(entryPermitDigest(D, entry), "0x14290c7bdf70941138cef41bc26615de5fc997ecb9f9946dd0ba6ef73e104c36");
  assert.equal(leaveDigest(D, { eventId, player, attempt: 2 }), "0x1fc848e89dcf98e6bac4af8ac9251ed86c9dfc0abc28de5432acb2dacf4889d3");
  assert.equal(prizeDigest(D, prize), "0x7bbf269abfac484c0c3f5897c343161b398d4f4f67b6096fcc91e50f445a52c1");
  assert.equal(prizePermitDigest(D, prize), "0x3f492a34811e0f63817406b24bc547376dd6ab331a9ee375fbe0f4126fe65375");
  assert.equal(resultDigest(D, result), "0x6ad5a840067ece4ca1c2ac19deb5e84cfe7e192c3de82efe5a9ab418a389f3fd");
  assert.equal(cancelDigest(D, eventId), "0x36ef63436e060e80eb896856b2701c5f184f08cf60a19d9b390e2fbbccc01574");
});

await check("digests are bound to chain, contract and every signed field", () => {
  const base = entryDigest(D, entry);
  assert.notEqual(entryDigest({ ...D, chainId: 998 }, entry), base);
  assert.notEqual(entryDigest({ ...D, vault: getAddress("0xe7e0000000000000000000000000000000000003") }, entry), base);
  assert.notEqual(entryDigest(D, { ...entry, routed: false }), base);
  assert.notEqual(entryDigest(D, { ...entry, attempt: 3 }), base);
  assert.notEqual(entryDigest(D, { ...entry, teamKey: keccak256(toHex("team b")) }), base);
  // A permit is not an entry, and the reverse: the server cannot enter for a player.
  assert.notEqual(entryPermitDigest(D, entry), base);
  assert.notEqual(prizePermitDigest(D, prize), prizeDigest(D, prize));
  assert.notEqual(prizeDigest(D, { ...prize, split: [10_000] }), prizeDigest(D, prize));
  assert.notEqual(resultDigest(D, { ...result, revision: 2 }), resultDigest(D, result));
  assert.notEqual(resultDigest(D, { ...result, placements: [...result.placements].reverse() }), resultDigest(D, result));
  assert.notEqual(termsDigest(D, { ...terms, entryFee: 1n }), termsDigest(D, terms));
});

await check("what a wallet is asked to sign survives the trip through Circle's JSON", async () => {
  // signature.ts stores typed data as JSON and verifies against what it parses back.
  const key = privateKeyToAccount(generatePrivateKey());
  const cases: [ReturnType<typeof termsTypedData>, Hex][] = [
    [termsTypedData(D, terms), termsDigest(D, terms)],
    [entryTypedData(D, entry), entryDigest(D, entry)],
    [leaveTypedData(D, { eventId, player, attempt: 2 }), leaveDigest(D, { eventId, player, attempt: 2 })],
    [resultTypedData(D, result), resultDigest(D, result)],
    [resultTypedData(D, { ...result, placements: [] }), resultDigest(D, { ...result, placements: [] })],
    [cancelTypedData(D, eventId), cancelDigest(D, eventId)],
  ];
  for (const [data, digest] of cases) {
    const back = parseTypedDataJson(typedDataJson(data));
    const signature = await key.signTypedData(back as Parameters<typeof key.signTypedData>[0]);
    assert.ok(await signedBy(key.address, data, signature), data.primaryType);
    // The same signature the contract would check against its own digest.
    assert.equal(await key.sign({ hash: digest }), signature, `${data.primaryType} digest`);
  }
});

await check("the server's signatures are over the permit and result digests", async () => {
  const server = privateKeyToAccount(generatePrivateKey());
  assert.equal(await signEntryPermit(server, D, entry), await server.sign({ hash: entryPermitDigest(D, entry) }));
  assert.equal(await signPrizePermit(server, D, prize), await server.sign({ hash: prizePermitDigest(D, prize) }));
  assert.equal(await signResult(server, D, result), await server.sign({ hash: resultDigest(D, result) }));
});

const ARTIFACT = join(dirname(fileURLToPath(import.meta.url)), "../../../contracts/out/EventVault.sol/EventVault.json");
if (existsSync(ARTIFACT)) {
  await check("the ABI matches the compiled EventVault", () => {
    const compiled = JSON.parse(readFileSync(ARTIFACT, "utf-8")).abi as Abi;
    for (const item of eventVaultAbi) {
      if (item.type === "function") {
        const match = compiled.find((c): c is AbiFunction => c.type === "function" && c.name === item.name);
        assert.ok(match, `EventVault has no ${item.name}`);
        assert.equal(toFunctionSelector(item), toFunctionSelector(match), item.name);
        assert.equal(match.stateMutability, item.stateMutability, `${item.name} mutability`);
        assert.deepEqual(JSON.stringify(match.outputs.map(shape)), JSON.stringify(item.outputs.map(shape)), `${item.name} outputs`);
      } else if (item.type === "event") {
        const match = compiled.find((c): c is AbiEvent => c.type === "event" && c.name === item.name);
        assert.ok(match, `EventVault has no event ${item.name}`);
        assert.equal(toEventSelector(item), toEventSelector(match), item.name);
        assert.deepEqual(match.inputs.map((i) => Boolean(i.indexed)), item.inputs.map((i) => "indexed" in i && Boolean(i.indexed)), `${item.name} indexed`);
      } else if (item.type === "error") {
        assert.ok(compiled.some((c) => c.type === "error" && c.name === item.name), `EventVault has no error ${item.name}`);
      }
    }
    // Every error the contract can raise has a name here, so a refused relay can say why.
    for (const c of compiled) {
      if (c.type !== "error" || /^(ECDSA|SafeERC20|InvalidShortString|StringTooLong)/.test(c.name)) continue;
      assert.ok(eventVaultAbi.some((i) => i.type === "error" && i.name === c.name), `protocol.ts is missing error ${c.name}`);
    }
  });
} else {
  console.log("--  ABI comparison skipped: run (cd contracts && forge build) first");
}

/** A parameter's type, with tuple components, so struct returns are compared field by field. */
function shape(p: { type: string; components?: readonly unknown[] }): unknown {
  return p.components ? [p.type, (p.components as { type: string }[]).map(shape)] : p.type;
}

console.log(`\n${passed} checks passed`);
