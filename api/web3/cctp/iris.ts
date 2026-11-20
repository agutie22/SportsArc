/**
 * Client for Circle's attestation service (Iris), CCTP v2:
 *
 *   GET {base}/v2/messages/{sourceDomain}?transactionHash={burn tx}
 *     200 { messages: [{ message, attestation, eventNonce, cctpVersion,
 *                        status: "complete" | "pending_confirmations", ... }] }
 *     404 while Iris has not indexed the burn yet
 *     429 over the rate limit (35 req/s; Circle then blocks for 5 minutes)
 *     Forwarded burns also carry forwardState and forwardTxHash.
 *   GET {base}/v2/burn/USDC/fees/{sourceDomain}/{destinationDomain}[?forward=true]
 *     200 [{ finalityThreshold, minimumFee (bps), forwardFee?: { low, med, high } }]
 *
 * Only `status`, `message`, `attestation` and `cctpVersion` are read. The
 * decodedMessage block is ignored: the caller decodes the bytes itself and
 * checks them against the burn (message.ts). The sandbox base URL is the
 * default; mainnet Iris is refused (config.ts). `fetch` is injectable so the
 * parser runs against recorded responses (check.ts) and a local attester
 * (e2e.ts). Node's fetch honours HTTPS_PROXY only with NODE_USE_ENV_PROXY=1.
 */

import { isHex, type Hex } from "viem";
import { irisUrl, refuseUrl } from "./config.js";

export type FetchFn = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{
  status: number;
  text(): Promise<string>;
}>;

export interface IrisMessage {
  status: string;
  complete: boolean;
  message: Hex | null;
  attestation: Hex | null;
  cctpVersion: number | null;
  delayReason: string | null;
  /** Forwarding Service: "PENDING", "COMPLETE", ... (enum undocumented). */
  forwardState: string | null;
  /** The mint Circle's forwarder sent on the destination chain. */
  forwardTxHash: Hex | null;
}

export interface IrisFailure {
  ok: false;
  error: { code: string; message: string };
}

export type IrisResult =
  | { ok: true; found: false }
  | { ok: true; found: true; messages: IrisMessage[] }
  | IrisFailure;

const TIMEOUT_MS = 10_000;

function fail(code: string, message: string): IrisFailure {
  return { ok: false, error: { code, message } };
}

function hexOrNull(v: unknown): Hex | null {
  return typeof v === "string" && isHex(v) && v.length > 2 && v.length % 2 === 0 ? (v.toLowerCase() as Hex) : null;
}

function txHashOrNull(v: unknown): Hex | null {
  return typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v) ? (v.toLowerCase() as Hex) : null;
}

/** One row of /v2/burn/USDC/fees: the protocol fee and, if asked, the forwarding fee. */
export interface IrisFee {
  finalityThreshold: number;
  /** Protocol fee in basis points; may be fractional (1.3). */
  minimumFeeBps: number;
  /** Forwarding fee in USDC base units, at Circle's "med" gas estimate. */
  forwardFee: bigint | null;
}

export type IrisFeesResult = { ok: true; fees: IrisFee[] } | IrisFailure;

/** Parse one /v2/burn/USDC/fees response body. Exported for check.ts. */
export function parseFeesResponse(status: number, text: string): IrisFeesResult {
  if (status === 429) return fail("IRIS_RATE_LIMITED", "Iris rate limit hit; Circle blocks for 5 minutes.");
  if (status >= 500) return fail("IRIS_UNAVAILABLE", `Iris answered ${status}.`);
  if (status !== 200) return fail("IRIS_BAD_RESPONSE", `Iris answered ${status}: ${text.slice(0, 200)}`);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return fail("IRIS_BAD_RESPONSE", "Iris returned invalid JSON.");
  }
  if (!Array.isArray(body)) return fail("IRIS_BAD_RESPONSE", "Iris fees response is not a list.");
  const fees: IrisFee[] = [];
  for (const raw of body) {
    const m = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    if (typeof m.finalityThreshold !== "number" || typeof m.minimumFee !== "number" || m.minimumFee < 0) continue;
    const ff = (m.forwardFee && typeof m.forwardFee === "object" ? m.forwardFee : null) as Record<string, unknown> | null;
    // The how-to says "med", the API reference "medium"; the live sandbox says "med".
    const med = ff ? (ff.med ?? ff.medium) : undefined;
    fees.push({
      finalityThreshold: m.finalityThreshold,
      minimumFeeBps: m.minimumFee,
      forwardFee: typeof med === "number" && Number.isSafeInteger(med) && med >= 0 ? BigInt(med) : null,
    });
  }
  return { ok: true, fees };
}

/** Parse one /v2/messages response body. Exported for check.ts. */
export function parseMessagesResponse(status: number, text: string): IrisResult {
  if (status === 404) return { ok: true, found: false };
  if (status === 429) return fail("IRIS_RATE_LIMITED", "Iris rate limit hit; Circle blocks for 5 minutes.");
  if (status >= 500) return fail("IRIS_UNAVAILABLE", `Iris answered ${status}.`);
  if (status !== 200) return fail("IRIS_BAD_RESPONSE", `Iris answered ${status}: ${text.slice(0, 200)}`);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return fail("IRIS_BAD_RESPONSE", "Iris returned invalid JSON.");
  }
  const list = (body as { messages?: unknown })?.messages;
  if (!Array.isArray(list)) return fail("IRIS_BAD_RESPONSE", "Iris response has no messages array.");
  if (list.length === 0) return { ok: true, found: false };
  const messages = list.map((raw): IrisMessage => {
    const m = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const s = typeof m.status === "string" ? m.status : "";
    const message = hexOrNull(m.message);
    const attestation = hexOrNull(m.attestation);
    return {
      status: s,
      complete: s === "complete" && message !== null && attestation !== null,
      message,
      attestation,
      cctpVersion: typeof m.cctpVersion === "number" ? m.cctpVersion : null,
      delayReason: typeof m.delayReason === "string" ? m.delayReason : null,
      forwardState: typeof m.forwardState === "string" ? m.forwardState : null,
      forwardTxHash: txHashOrNull(m.forwardTxHash) ?? txHashOrNull(m.destinationMintTxHash),
    };
  });
  return { ok: true, found: true, messages };
}

export interface IrisClient {
  messagesForTx(sourceDomain: number, txHash: Hex): Promise<IrisResult>;
  fees(sourceDomain: number, destinationDomain: number, forward: boolean): Promise<IrisFeesResult>;
}

export function irisClient(fetchFn: FetchFn = fetch as unknown as FetchFn, base = irisUrl()): IrisClient {
  const getText = async (path: string): Promise<{ status: number; text: string } | IrisFailure> => {
    const refused = refuseUrl(base);
    if (refused) return fail("NOT_CONFIGURED", refused);
    try {
      const res = await fetchFn(`${base}${path}`, {
        signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "application/json" },
      });
      return { status: res.status, text: await res.text() };
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      return fail("IRIS_UNAVAILABLE", `Iris request failed: ${why}`);
    }
  };
  const domainOk = (d: number) => Number.isInteger(d) && d >= 0;
  return {
    async messagesForTx(sourceDomain, txHash) {
      if (!domainOk(sourceDomain) || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
        return fail("VALIDATION_ERROR", "Bad domain or transaction hash.");
      }
      const r = await getText(`/v2/messages/${sourceDomain}?transactionHash=${txHash}`);
      return "ok" in r ? r : parseMessagesResponse(r.status, r.text);
    },
    async fees(sourceDomain, destinationDomain, forward) {
      if (!domainOk(sourceDomain) || !domainOk(destinationDomain)) return fail("VALIDATION_ERROR", "Bad domain.");
      const r = await getText(`/v2/burn/USDC/fees/${sourceDomain}/${destinationDomain}${forward ? "?forward=true" : ""}`);
      return "ok" in r ? r : parseFeesResponse(r.status, r.text);
    },
  };
}
