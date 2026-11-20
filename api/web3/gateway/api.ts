/**
 * Client for Circle's Gateway API (testnet), the four calls a payout needs:
 *
 *   POST /v1/balances                          a depositor's Gateway balance
 *   POST /v1/estimate?enableForwarder=true     the fee and expiry for an intent
 *   POST /v1/transfer?enableForwarder=true     submit a signed intent; Circle's
 *                                              forwarder mints on the destination
 *   GET  /v1/transfer/{id}                     pending | confirmed | finalized |
 *                                              failed | expired
 *
 * Every call returns a result and never throws. `rejected` on a failure
 * means Circle answered 4xx: the request was refused and nothing moved, so a
 * new attempt is safe. Anything else (timeout, 5xx) is unknown. `fetch` is
 * injectable so check.ts runs against recorded responses.
 */

import { parseUnits } from "viem";
import type { Hex } from "viem";
import { gatewayApiUrl } from "./config.js";
import { toJson, type BurnIntent, type TransferSpec } from "./intent.js";

export type FetchFn = (url: string, init?: {
  method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal;
}) => Promise<{ status: number; text(): Promise<string> }>;

export interface ApiFailure {
  ok: false;
  /** Circle refused the request (4xx): nothing moved. */
  rejected: boolean;
  error: { code: string; message: string };
}

export type TransferStatus = "pending" | "confirmed" | "finalized" | "failed" | "expired";

export interface GatewayApi {
  balance(domain: number, depositor: string): Promise<{ ok: true; balance: bigint } | ApiFailure>;
  estimate(spec: TransferSpec): Promise<{ ok: true; maxFee: bigint; maxBlockHeight: bigint } | ApiFailure>;
  transfer(intent: BurnIntent, signature: Hex): Promise<{ ok: true; transferId: string } | ApiFailure>;
  status(transferId: string): Promise<
    { ok: true; status: TransferStatus; txHash: string | null; failureReason: string | null } | ApiFailure
  >;
}

const TIMEOUT_MS = 15_000;
const STATUSES: readonly string[] = ["pending", "confirmed", "finalized", "failed", "expired"];

function failure(code: string, message: string, rejected = false): ApiFailure {
  return { ok: false, rejected, error: { code, message: message.slice(0, 300) } };
}

function uint(v: unknown): bigint | null {
  return typeof v === "string" && /^\d{1,78}$/.test(v) ? BigInt(v) : null;
}

export function gatewayApi(fetchFn: FetchFn = fetch as unknown as FetchFn, base = gatewayApiUrl()): GatewayApi {
  const call = async (method: "GET" | "POST", path: string, body?: unknown):
    Promise<{ ok: true; json: any } | ApiFailure> => {
    if (!base) return failure("NOT_CONFIGURED", "Gateway is testnet only; GATEWAY_API_URL names a mainnet.");
    let status: number;
    let text: string;
    try {
      const res = await fetchFn(`${base}${path}`, {
        method,
        headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : toJson(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      status = res.status;
      text = await res.text();
    } catch (err) {
      return failure("GATEWAY_UNAVAILABLE", `Gateway request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (status >= 500) return failure("GATEWAY_UNAVAILABLE", `Gateway answered ${status}.`);
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      return failure("GATEWAY_BAD_RESPONSE", `Gateway answered ${status} with invalid JSON.`, status >= 400);
    }
    if (status >= 400) {
      const why = typeof json?.message === "string" ? json.message : text;
      return failure("GATEWAY_REJECTED", `Gateway answered ${status}: ${why}`, true);
    }
    return { ok: true, json };
  };

  return {
    async balance(domain, depositor) {
      const r = await call("POST", "/v1/balances", { token: "USDC", sources: [{ domain, depositor }] });
      if (!r.ok) return r;
      const row = Array.isArray(r.json?.balances) ? r.json.balances.find((b: any) => b?.domain === domain) : null;
      const raw = typeof row?.balance === "string" ? row.balance : "";
      if (!/^\d{1,30}(\.\d{1,6})?$/.test(raw)) return failure("GATEWAY_BAD_RESPONSE", "Gateway returned no balance.");
      return { ok: true, balance: parseUnits(raw, 6) };
    },
    async estimate(spec) {
      const r = await call("POST", "/v1/estimate?enableForwarder=true", [{ spec }]);
      if (!r.ok) return r;
      const intent = r.json?.body?.[0]?.burnIntent;
      const maxFee = uint(intent?.maxFee);
      const maxBlockHeight = uint(intent?.maxBlockHeight);
      if (maxFee === null || maxBlockHeight === null) return failure("GATEWAY_BAD_RESPONSE", "Gateway returned no estimate.");
      return { ok: true, maxFee, maxBlockHeight };
    },
    async transfer(intent, signature) {
      const r = await call("POST", "/v1/transfer?enableForwarder=true", [{ burnIntent: intent, signature }]);
      if (!r.ok) return r;
      const id = r.json?.transferId;
      if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) {
        return failure("GATEWAY_BAD_RESPONSE", "Gateway accepted the transfer but returned no id.");
      }
      return { ok: true, transferId: id };
    },
    async status(transferId) {
      const r = await call("GET", `/v1/transfer/${encodeURIComponent(transferId)}`);
      if (!r.ok) return r;
      const status = r.json?.status;
      if (typeof status !== "string" || !STATUSES.includes(status)) {
        return failure("GATEWAY_BAD_RESPONSE", "Gateway returned an unknown transfer status.");
      }
      const tx = r.json?.transactionHash;
      const why = r.json?.forwardingDetails?.failureReason;
      return {
        ok: true,
        status: status as TransferStatus,
        txHash: typeof tx === "string" && /^0x[0-9a-fA-F]{64}$/.test(tx) ? tx : null,
        failureReason: typeof why === "string" ? why.slice(0, 200) : null,
      };
    },
  };
}
