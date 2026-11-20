/**
 * Circle User-Controlled Wallets: PIN + wallet setup.
 *
 * POST /api/auth/init and /complete require an existing SportsArc session.
 * Signing back in with that PIN (username + PIN) lives in auth/pin-login.ts.
 */

import {
  initiateUserControlledWalletsClient,
  type Blockchain,
} from "@circle-fin/user-controlled-wallets";
import type { EntityManager } from "@mikro-orm/postgresql";
import { normalizeBuyerChainKey } from "./chain-config.js";
import { User, circleUserIdFor } from "../entities/User.js";
import { findUserById } from "../social/users.js";

export interface AuthInitSuccess {
  ok: true;
  userId: string;
  userToken: string;
  encryptionKey: string;
  walletAddress: string | null;
  challengeId: string | null;
  challengeKind: "pin_wallet" | null;
  isNewUser: boolean;
}

export interface AuthInitError {
  ok: false;
  error: { code: string; message: string; details?: unknown };
}

export type AuthInitResponse = AuthInitSuccess | AuthInitError;

export interface AuthCompleteSuccess {
  ok: true;
  userId: string;
  walletAddress: string;
}

export type AuthCompleteResponse = AuthCompleteSuccess | AuthInitError;

export interface ChallengeStatusSuccess {
  ok: true;
  challengeId: string;
  status: string;
}

export type ChallengeStatusResponse = ChallengeStatusSuccess | AuthInitError;

let _client: ReturnType<typeof initiateUserControlledWalletsClient> | null = null;

export function getCircleWalletsClient(): ReturnType<
  typeof initiateUserControlledWalletsClient
> | null {
  if (_client) return _client;
  const apiKey = process.env.CIRCLE_API_KEY;
  if (!apiKey) return null;
  _client = initiateUserControlledWalletsClient({ apiKey });
  return _client;
}

export function buyerBlockchain(): Blockchain {
  const chainKey = normalizeBuyerChainKey(process.env.BUYER_CHAIN);
  return chainKey === "baseSepolia"
    ? ("BASE-SEPOLIA" as Blockchain)
    : ("ARC-TESTNET" as Blockchain);
}

function isConflict(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const data = (err as { response?: { data?: { code?: number } } })?.response?.data;
  const status = (err as { response?: { status?: number } })?.response?.status;

  if (status === 409 || data?.code === 155101) return true;
  return /already (exists|created)|conflict|duplicate/i.test(message);
}

function msgOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function challengeIdFromCircleData(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const o = data as Record<string, unknown>;
  if (typeof o.challengeId === "string") return o.challengeId;
  const inner = o.data;
  if (inner && typeof inner === "object") {
    const c = (inner as Record<string, unknown>).challengeId;
    if (typeof c === "string") return c;
  }
  return null;
}

export function errorResponse(
  code: string,
  message: string,
  details?: unknown,
): AuthInitError {
  return {
    ok: false,
    error: { code, message, ...(details !== undefined ? { details } : {}) },
  };
}

export async function mintUserToken(
  client: NonNullable<ReturnType<typeof getCircleWalletsClient>>,
  userId: string,
): Promise<{ userToken: string; encryptionKey: string } | AuthInitError> {
  try {
    const tokenRes = await client.createUserToken({ userId });
    const userToken = tokenRes.data?.userToken ?? "";
    const encryptionKey = tokenRes.data?.encryptionKey ?? "";
    if (!userToken || !encryptionKey) {
      throw new Error("Circle did not return userToken + encryptionKey.");
    }
    return { userToken, encryptionKey };
  } catch (err) {
    return errorResponse(
      "CREATE_USER_TOKEN_FAILED",
      `Could not mint userToken: ${msgOf(err)}`,
    );
  }
}

export async function listChainWallet(
  client: NonNullable<ReturnType<typeof getCircleWalletsClient>>,
  userToken: string,
): Promise<{ id: string; address: string } | null> {
  const blockchain = buyerBlockchain();
  const walletsRes = await client.listWallets({ userToken });
  const wallets = walletsRes.data?.wallets ?? [];
  const match = wallets.find((w) => (w.blockchain as string) === blockchain);
  if (!match?.address || !match.id) return null;
  return { id: match.id, address: match.address };
}

async function waitForChainWallet(
  client: NonNullable<ReturnType<typeof getCircleWalletsClient>>,
  userToken: string,
): Promise<{ id: string; address: string } | null> {
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const wallet = await listChainWallet(client, userToken);
      if (wallet) return wallet;
    } catch (err) {
      console.warn("[auth] listWallets failed:", msgOf(err));
    }
    if (attempt < 6) await new Promise((r) => setTimeout(r, 1500));
  }
  return null;
}

async function loadSessionUser(
  em: EntityManager,
  sessionUserId: string,
): Promise<User | AuthInitError> {
  const user = await findUserById(em, sessionUserId);
  if (!user) {
    return errorResponse("AUTH_REQUIRED", "Not signed in.");
  }
  return user;
}

export async function initWalletSetup(
  em: EntityManager,
  sessionUserId: string,
): Promise<AuthInitResponse> {
  const client = getCircleWalletsClient();
  if (!client) {
    return errorResponse(
      "AUTH_NOT_CONFIGURED",
      "Circle API credentials are missing (CIRCLE_API_KEY).",
    );
  }

  const loaded = await loadSessionUser(em, sessionUserId);
  if ("ok" in loaded && loaded.ok === false) return loaded;
  const user = loaded as User;

  if (user.walletAddress) {
    const circleId = circleUserIdFor(user);
    const minted = await mintUserToken(client, circleId);
    if ("ok" in minted && minted.ok === false) return minted;
    const { userToken, encryptionKey } = minted as {
      userToken: string;
      encryptionKey: string;
    };
    return {
      ok: true,
      userId: user.id,
      userToken,
      encryptionKey,
      walletAddress: user.walletAddress,
      challengeId: null,
      challengeKind: null,
      isNewUser: false,
    };
  }

  const circleId = circleUserIdFor(user);
  let isNewUser = false;
  try {
    await client.createUser({ userId: circleId });
    isNewUser = true;
  } catch (err) {
    if (!isConflict(err)) {
      console.error("[auth] createUser failed:", { userId: circleId, error: err });
      return errorResponse(
        "CREATE_USER_FAILED",
        `Could not create Circle user: ${msgOf(err)}`,
      );
    }
  }
  if (!user.circleUserId) {
    user.circleUserId = circleId;
    await em.flush();
  }

  const minted = await mintUserToken(client, circleId);
  if ("ok" in minted && minted.ok === false) return minted;
  const { userToken, encryptionKey } = minted as {
    userToken: string;
    encryptionKey: string;
  };

  let wallet: { id: string; address: string } | null = null;
  try {
    wallet = await listChainWallet(client, userToken);
  } catch (err) {
    console.warn("[auth] listWallets failed:", msgOf(err));
  }

  if (wallet) {
    user.walletAddress = wallet.address;
    user.circleUserId = circleId;
    await em.flush();
    return {
      ok: true,
      userId: user.id,
      userToken,
      encryptionKey,
      walletAddress: wallet.address,
      challengeId: null,
      challengeKind: null,
      isNewUser,
    };
  }

  try {
    const pinRes = await client.createUserPinWithWallets({
      userToken,
      blockchains: [buyerBlockchain()],
      accountType: "EOA",
    });
    const challengeId = challengeIdFromCircleData(pinRes.data);
    if (!challengeId) {
      return errorResponse(
        "CHALLENGE_FAILED",
        "Circle did not return a wallet challengeId.",
      );
    }
    return {
      ok: true,
      userId: user.id,
      userToken,
      encryptionKey,
      walletAddress: null,
      challengeId,
      challengeKind: "pin_wallet",
      isNewUser,
    };
  } catch (err) {
    return errorResponse(
      "CHALLENGE_FAILED",
      `Could not create PIN + wallet challenge: ${msgOf(err)}`,
    );
  }
}

export async function getChallengeStatus(
  em: EntityManager,
  sessionUserId: string,
  challengeIdRaw: string,
): Promise<ChallengeStatusResponse> {
  const challengeId = challengeIdRaw.trim();
  if (!challengeId) {
    return errorResponse("VALIDATION_ERROR", "challengeId is required.");
  }

  const client = getCircleWalletsClient();
  if (!client) {
    return errorResponse(
      "AUTH_NOT_CONFIGURED",
      "Circle API credentials are missing (CIRCLE_API_KEY).",
    );
  }

  const loaded = await loadSessionUser(em, sessionUserId);
  if ("ok" in loaded && loaded.ok === false) return loaded;
  const user = loaded as User;
  const circleId = circleUserIdFor(user);

  const minted = await mintUserToken(client, circleId);
  if ("ok" in minted && minted.ok === false) return minted;
  const { userToken } = minted as { userToken: string };

  try {
    const chRes = await client.getUserChallenge({ userToken, challengeId });
    const status = chRes.data?.challenge?.status ?? "";
    return { ok: true, challengeId, status };
  } catch (err) {
    return errorResponse(
      "CHALLENGE_FAILED",
      `Could not read challenge: ${msgOf(err)}`,
    );
  }
}

export async function completeWalletSetup(
  em: EntityManager,
  sessionUserId: string,
  challengeIdRaw: string,
): Promise<AuthCompleteResponse> {
  const challengeId = challengeIdRaw.trim();
  if (!challengeId) {
    return errorResponse("VALIDATION_ERROR", "challengeId is required.");
  }

  const client = getCircleWalletsClient();
  if (!client) {
    return errorResponse(
      "AUTH_NOT_CONFIGURED",
      "Circle API credentials are missing (CIRCLE_API_KEY).",
    );
  }

  const loaded = await loadSessionUser(em, sessionUserId);
  if ("ok" in loaded && loaded.ok === false) return loaded;
  const user = loaded as User;
  const circleId = circleUserIdFor(user);

  const minted = await mintUserToken(client, circleId);
  if ("ok" in minted && minted.ok === false) return minted;
  const { userToken } = minted as { userToken: string };

  try {
    const chRes = await client.getUserChallenge({ userToken, challengeId });
    const status = chRes.data?.challenge?.status ?? "";
    if (status !== "COMPLETE") {
      return errorResponse(
        "CHALLENGE_INCOMPLETE",
        `Challenge is ${status || "unknown"}, not COMPLETE.`,
        { status },
      );
    }
  } catch (err) {
    return errorResponse(
      "CHALLENGE_FAILED",
      `Could not verify challenge: ${msgOf(err)}`,
    );
  }

  const wallet = await waitForChainWallet(client, userToken);
  if (!wallet) {
    return errorResponse(
      "WALLET_NOT_READY",
      "Circle wallet was not available after the PIN challenge.",
    );
  }

  user.walletAddress = wallet.address;
  user.circleUserId = circleId;
  await em.flush();

  return { ok: true, userId: user.id, walletAddress: wallet.address };
}
