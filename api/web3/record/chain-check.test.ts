/**
 * The browser builds SportsArcRecord.writtenAt's call data by hand
 * (frontend/chain-check.js has no viem). This pins it to the ABI.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { encodeFunctionData, keccak256, toHex, type Hex } from "viem";
import { recordAbi } from "./abi.js";

const h = (s: string): Hex => keccak256(toHex(s));

test("the browser's writtenAt() call data matches the ABI", async () => {
  const path = new URL("../../../frontend/chain-check.js", import.meta.url).href;
  const { writtenAtCallData } = (await import(path)) as { writtenAtCallData: (record: string) => string };
  for (const record of [h("a"), h("record"), `0x${"00".repeat(31)}01`]) {
    const expected = encodeFunctionData({ abi: recordAbi, functionName: "writtenAt", args: [record as Hex] });
    assert.equal(writtenAtCallData(record), expected);
    assert.equal(writtenAtCallData(record.toUpperCase().replace("0X", "0x")), expected);
  }
});
