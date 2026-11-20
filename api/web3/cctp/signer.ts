/**
 * The one way a CCTP step reaches a chain: a tx from the user's own wallet,
 * built by the wallet workstream's prepareUserTx and signed by the user
 * through a Circle challenge. This module never signs and holds no key; it
 * only asks the wallet workstream for a signing request on the step's
 * chain and reads back where the resulting UserEvmTx stands.
 *
 * The wallet builds, broadcasts and reads txs on Arc (wallet/networks.ts).
 * A withdrawal signs only the approval and the burn there, through the
 * user's EVM-TESTNET wallet; Circle submits the mint on the destination.
 * The wallet's RPC is configured there (WALLET_RPC_URL_<chainId>),
 * separately from this stream's read clients.
 *
 * A submitted tx that never mines and whose nonce the wallet has since used
 * (dropped from a mempool, or replaced) is written "dropped" by the
 * wallet's txStatus, so its step can be prepared again instead of waiting
 * forever.
 */

import type { EntityManager } from "@mikro-orm/postgresql";
import type { Address, Hex } from "viem";
import type { User } from "../../entities/User.js";
import { prepareUserTx, txStatus, type ChallengeHandoff, type GasView, type TxView } from "../wallet/service.js";
import type { EvmTxStatus } from "../wallet/UserEvmTx.js";

export interface Failure {
  ok: false;
  error: { code: string; message: string };
}

export function failure(code: string, message: string): Failure {
  return { ok: false, error: { code, message } };
}

export interface StepTx {
  id: string;
  /** The wallet's status; "dropped" is submitted, never mined, nonce since used. */
  status: EvmTxStatus;
  chainId: number;
  txHash: Hex | null;
  challengeId: string | null;
}

export interface StepTxRequest {
  chainId: number;
  to: Address;
  data: Hex;
  /** UserEvmTx.kind, at most 32 characters. */
  kind: string;
  /** Shown in Circle's confirmation screen, at most 120 characters. */
  memo: string;
}

export type PrepareResult =
  | { ok: true; tx: StepTx; challenge: ChallengeHandoff | null; gas: GasView | null }
  | Failure;

export type StatusResult = { ok: true; tx: StepTx } | Failure;

export interface StepSigner {
  prepare(em: EntityManager, user: User, req: StepTxRequest): Promise<PrepareResult>;
  status(em: EntityManager, user: User, txId: string): Promise<StatusResult>;
}

function stepTx(tx: TxView): StepTx {
  return {
    id: tx.id,
    status: tx.status,
    chainId: tx.chainId,
    txHash: (tx.txHash as Hex | null) ?? null,
    challengeId: tx.challengeId,
  };
}

/** The wallet workstream as a StepSigner, on whichever chain the step names. */
export function walletSigner(): StepSigner {
  return {
    async prepare(em, user, req) {
      const r = await prepareUserTx(em, user, {
        chainId: req.chainId, to: req.to, data: req.data, kind: req.kind, memo: req.memo,
      });
      if (!r.ok) return r;
      return { ok: true, tx: stepTx(r.tx), challenge: r.challenge, gas: r.gas };
    },

    async status(em, user, txId) {
      const r = await txStatus(em, user, txId);
      if (!r.ok) {
        if (r.error.code === "TX_NOT_FOUND") return failure("TX_NOT_FOUND", "The step's wallet transaction is gone.");
        return r;
      }
      return { ok: true, tx: stepTx(r.tx) };
    },
  };
}
