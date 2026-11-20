/**
 * Asks the record contract one question straight from the browser: "when
 * was this entry written?" The call goes to the network's public address,
 * not through SportsArc, so the answer on a verified record is the
 * network's and not ours. The question needs nothing but the entry's ID.
 *
 * No dependencies and no DOM, so the server's tests can import it
 * (api/web3/record/chain-check.test.ts pins the encoding against the ABI).
 */

/** SportsArcRecord.writtenAt(bytes32 entry) returns (uint64). */
const WRITTEN_AT = "8a7d0e89";

const word = (hex) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");

/** ABI call data for writtenAt(entry). */
export function writtenAtCallData(entry) {
  return `0x${WRITTEN_AT}${word(entry)}`;
}

/**
 * When the entry was written, as an ISO time; false when the contract has
 * no such entry; null when it could not be asked (no network address, the
 * request failed, or the answer was not a number).
 */
export async function askWrittenAt({ rpcUrl, contract, hash }) {
  if (!rpcUrl || !contract || !hash) return null;
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: contract, data: writtenAtCallData(hash) }, "latest"] }),
    });
    const out = (await res.json()).result;
    if (typeof out !== "string" || !/^0x[0-9a-f]{64}$/i.test(out)) return null;
    const seconds = Number(BigInt(out));
    return seconds > 0 ? new Date(seconds * 1000).toISOString() : false;
  } catch {
    return null;
  }
}
