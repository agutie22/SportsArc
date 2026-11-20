/**
 * Every Circle call the wallet workstream makes, behind one small interface
 * so the rest can run against a stub (setCircleApi) where Circle keys are
 * placeholders.
 *
 * EVM-TESTNET is Circle's signing-only code for EVM testnets it does not
 * index under their own chain code. A user-controlled wallet on it is
 * created by the user (a CREATE_WALLET challenge), lands in the same wallet
 * set as their ARC-TESTNET wallet and, as an EOA, has the same address.
 * Arc withdrawals are signed with this wallet: the transaction's chain id
 * is Arc's, and Circle signs the raw transaction.
 *
 * Signing a transaction is also a challenge. Circle's server API only
 * reports the challenge's status; the signed transaction is handed to the
 * browser by the web SDK (SignTransactionResult.data.signedTransaction), and
 * the browser posts it back to us to broadcast.
 *
 * Signing typed data (EIP-712) is the same shape: a challenge, and the web
 * SDK hands the browser result.data.signature. The user's Arc wallet signs
 * it, so nothing has to be set up first (signature.ts).
 */

import type { Hex } from "viem";
import { buyerBlockchain, getCircleWalletsClient } from "../../circle/auth-handler.js";

export const EVM_TESTNET = "EVM-TESTNET";

export interface CircleWallet {
  id: string;
  address: string;
  blockchain: string;
  walletSetId: string;
  state: string;
}

export interface CircleUserAuth {
  userToken: string;
  encryptionKey: string;
}

export interface CircleWalletApi {
  /** Short-lived token (and SDK key) for one Circle user. */
  userToken(circleUserId: string): Promise<CircleUserAuth>;
  listWallets(userToken: string): Promise<CircleWallet[]>;
  /** Starts an EVM-TESTNET wallet creation; returns the challengeId. */
  createEvmTestnetWallet(userToken: string): Promise<string>;
  /** Asks the user to sign a hex-serialized unsigned tx; returns the challengeId. */
  signTransaction(input: {
    userToken: string;
    walletId: string;
    rawTransaction: Hex;
    memo?: string;
  }): Promise<string>;
  /** Asks the user to sign EIP-712 typed data (its JSON text); returns the challengeId. */
  signTypedData(input: {
    userToken: string;
    walletId: string;
    data: string;
    memo?: string;
  }): Promise<string>;
  challengeStatus(userToken: string, challengeId: string): Promise<string>;
}

type SdkClient = NonNullable<ReturnType<typeof getCircleWalletsClient>>;

function required(value: string | undefined, what: string): string {
  if (!value) throw new Error(`Circle did not return ${what}.`);
  return value;
}

function fromSdk(client: SdkClient): CircleWalletApi {
  return {
    async userToken(userId) {
      const res = await client.createUserToken({ userId });
      return {
        userToken: required(res.data?.userToken, "a userToken"),
        encryptionKey: required(res.data?.encryptionKey, "an encryptionKey"),
      };
    },
    async listWallets(userToken) {
      const res = await client.listWallets({ userToken, pageSize: 50 });
      return (res.data?.wallets ?? []).map((w) => ({
        id: w.id,
        address: w.address,
        blockchain: w.blockchain as string,
        walletSetId: w.walletSetId,
        state: w.state as string,
      }));
    },
    async createEvmTestnetWallet(userToken) {
      const res = await client.createWallet({
        userToken,
        blockchains: [EVM_TESTNET],
        accountType: "EOA",
      });
      return required(res.data?.challengeId, "a challengeId");
    },
    async signTransaction({ userToken, walletId, rawTransaction, memo }) {
      const res = await client.signTransaction({ userToken, walletId, rawTransaction, memo });
      return required(res.data?.challengeId, "a challengeId");
    },
    async signTypedData({ userToken, walletId, data, memo }) {
      const res = await client.signTypedData({ userToken, walletId, data, memo });
      return required(res.data?.challengeId, "a challengeId");
    },
    async challengeStatus(userToken, challengeId) {
      const res = await client.getUserChallenge({ userToken, challengeId });
      return res.data?.challenge?.status ?? "";
    },
  };
}

let override: CircleWalletApi | null | undefined;

/** Tests only: a stub, null for "not configured", undefined for the real SDK. */
export function setCircleApi(api: CircleWalletApi | null | undefined): void {
  override = api;
}

/** Null when CIRCLE_API_KEY is unset. */
export function circleApi(): CircleWalletApi | null {
  if (override !== undefined) return override;
  const client = getCircleWalletsClient();
  return client ? fromSdk(client) : null;
}

/** The chain code of the user's existing (Arc) wallet. */
export function arcBlockchain(): string {
  return buyerBlockchain();
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * The user's EVM-TESTNET wallet among everything Circle lists for them:
 * the one in the Arc wallet's wallet set, else one at the Arc address, else
 * any (the caller then rejects the address mismatch).
 */
export function pickEvmWallet(
  wallets: CircleWallet[],
  arcAddress: string,
  arcChain: string,
): CircleWallet | null {
  const arc = wallets.find((w) => w.blockchain === arcChain && sameAddress(w.address, arcAddress));
  const evm = wallets.filter((w) => w.blockchain === EVM_TESTNET);
  return (
    evm.find((w) => arc !== undefined && w.walletSetId === arc.walletSetId) ??
    evm.find((w) => sameAddress(w.address, arcAddress)) ??
    evm[0] ??
    null
  );
}
