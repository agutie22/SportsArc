/**
 * Username + Circle PIN accounts: no email or phone needed.
 *
 *   signup  username + audience → a new user and a session; the browser
 *           asks before running the PIN + wallet challenge
 *           (circle/auth-handler.ts)
 *   start   username → a Circle signMessage challenge over a one-time login
 *           message, plus a signed ticket holding that message
 *   finish  ticket + signature → the signature must recover to the wallet
 *           address on file, then a session is issued
 *
 * The server never sees the PIN: Circle asks for it to approve the signature.
 * The wallet is an EOA, so a plain EIP-191 check is enough.
 *
 * Usernames are case-insensitive. The login row is stored lowercase; the
 * profile keeps the spelling the person typed. "Alex" and "alex" are one
 * account, and that spelling cannot also be someone else's name.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { UniqueConstraintViolationException } from "@mikro-orm/core";
import type { EntityManager } from "@mikro-orm/postgresql";
import { verifyMessage, type Hex } from "viem";
import { User } from "../entities/User.js";
import { UserIdentifier } from "../entities/UserIdentifier.js";
import {
  errorResponse,
  getCircleWalletsClient,
  listChainWallet,
  mintUserToken,
  type AuthInitError,
} from "../circle/auth-handler.js";
import { applyProfile, identityTaken } from "../social/users.js";
import { claimInvite } from "./invites.js";
import { sessionSecret } from "./session.js";

const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
const TICKET_TTL_MS = 5 * 60 * 1000;

export function normalizeUsername(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().replace(/^@/, "").toLowerCase();
  return USERNAME_RE.test(value) ? value : null;
}

/** The typed spelling of a valid username. Login still uses the lowercase form. */
export function usernameDisplay(raw: unknown): string | null {
  if (typeof raw !== "string" || !normalizeUsername(raw)) return null;
  return raw.trim().replace(/^@/, "");
}

const BAD_USERNAME = errorResponse(
  "VALIDATION_ERROR",
  "Usernames are 3–20 letters, numbers or underscores.",
);

// ── sign up ───────────────────────────────────────────────────────────

export async function signupWithUsername(
  em: EntityManager,
  body: { username?: unknown; audience?: unknown },
): Promise<{ ok: true; user: User } | AuthInitError> {
  const username = normalizeUsername(body.username);
  const display = usernameDisplay(body.username);
  if (!username || !display) return BAD_USERNAME;

  if (await identityTaken(em, display)) {
    return errorResponse("USERNAME_TAKEN", "That username is taken.");
  }

  const id = { kind: "username" as const, value: username };
  const refused = await claimInvite(em, id);
  if (refused) return refused;

  const user = new User();
  const applied = applyProfile(user, {
    name: display,
    role: "player",
    audience: typeof body.audience === "string" ? body.audience : "",
  });
  if (!applied.ok) return errorResponse("VALIDATION_ERROR", applied.message);

  const ident = new UserIdentifier();
  ident.user = user;
  ident.kind = id.kind;
  ident.value = id.value;
  user.identifiers.add(ident);
  em.persist(user);
  em.persist(ident);
  try {
    await em.flush();
  } catch (err) {
    if (err instanceof UniqueConstraintViolationException) {
      return errorResponse("USERNAME_TAKEN", "That username is taken.");
    }
    throw err;
  }
  return { ok: true, user };
}

// ── sign in ───────────────────────────────────────────────────────────

interface Ticket {
  userId: string;
  message: string;
  exp: number;
}

function sealTicket(t: Ticket): string {
  const body = Buffer.from(JSON.stringify(t), "utf8").toString("base64url");
  const mac = createHmac("sha256", sessionSecret()).update(`pin-login.${body}`).digest("base64url");
  return `${body}.${mac}`;
}

function openTicket(raw: unknown): Ticket | null {
  if (typeof raw !== "string") return null;
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = raw.slice(0, dot);
  const expected = createHmac("sha256", sessionSecret()).update(`pin-login.${body}`).digest();
  const given = Buffer.from(raw.slice(dot + 1), "base64url");
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const t = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Ticket;
    if (typeof t.userId !== "string" || typeof t.message !== "string" || typeof t.exp !== "number") return null;
    return t.exp < Date.now() ? null : t;
  } catch {
    return null;
  }
}

export interface PinLoginStart {
  ok: true;
  challengeId: string;
  userToken: string;
  encryptionKey: string;
  ticket: string;
}

/** Login lookup is case-insensitive, matching the lowercase row we store. */
async function findUsername(em: EntityManager, username: string): Promise<UserIdentifier | null> {
  const rows = await em.execute<{ id: string }[]>(
    `select id from user_identifiers where kind = 'username' and lower(value) = ? limit 1`,
    [username],
  );
  const id = rows[0]?.id;
  if (!id) return null;
  return em.findOne(UserIdentifier, { id }, { populate: ["user"] });
}

const NO_ACCOUNT = errorResponse(
  "NO_PIN_ACCOUNT",
  "No account with a PIN wallet has that username.",
);

export async function startPinLogin(
  em: EntityManager,
  body: { username?: unknown },
): Promise<PinLoginStart | AuthInitError> {
  const username = normalizeUsername(body.username);
  if (!username) return BAD_USERNAME;

  const client = getCircleWalletsClient();
  if (!client) {
    return errorResponse("AUTH_NOT_CONFIGURED", "Circle API credentials are missing (CIRCLE_API_KEY).");
  }

  const ident = await findUsername(em, username);
  const user = ident?.user;
  if (!user?.circleUserId || !user.walletAddress) return NO_ACCOUNT;

  const minted = await mintUserToken(client, user.circleUserId);
  if ("ok" in minted) return minted;

  let wallet: { id: string; address: string } | null = null;
  try {
    wallet = await listChainWallet(client, minted.userToken);
  } catch (err) {
    return errorResponse("CIRCLE_FAILED", `Could not read the wallet: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!wallet || wallet.address.toLowerCase() !== user.walletAddress.toLowerCase()) return NO_ACCOUNT;

  const message = [
    "Sign in to SportsArc",
    `Username: @${username}`,
    `Nonce: ${randomBytes(16).toString("hex")}`,
    `Issued: ${new Date().toISOString()}`,
  ].join("\n");

  let challengeId: string | undefined;
  try {
    const signed = await client.signMessage({
      userToken: minted.userToken,
      walletId: wallet.id,
      message,
      encodedByHex: false,
      memo: "Sign in to SportsArc",
    });
    challengeId = signed.data?.challengeId;
  } catch (err) {
    return errorResponse("CHALLENGE_FAILED", `Could not start sign-in: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!challengeId) return errorResponse("CHALLENGE_FAILED", "Circle did not return a sign-in challenge.");

  return {
    ok: true,
    challengeId,
    userToken: minted.userToken,
    encryptionKey: minted.encryptionKey,
    ticket: sealTicket({ userId: user.id, message, exp: Date.now() + TICKET_TTL_MS }),
  };
}

export async function finishPinLogin(
  em: EntityManager,
  body: { ticket?: unknown; signature?: unknown },
): Promise<{ ok: true; user: User } | AuthInitError> {
  const ticket = openTicket(body.ticket);
  if (!ticket) return errorResponse("LOGIN_EXPIRED", "Sign-in expired. Try again.");
  const signature = typeof body.signature === "string" ? body.signature.trim() : "";
  if (!/^0x[0-9a-fA-F]+$/.test(signature)) {
    return errorResponse("VALIDATION_ERROR", "signature is required.");
  }

  const user = await em.findOne(User, { id: ticket.userId });
  if (!user?.walletAddress) return errorResponse("LOGIN_FAILED", "Could not sign in.");

  let valid = false;
  try {
    valid = await verifyMessage({
      address: user.walletAddress as Hex,
      message: ticket.message,
      signature: signature as Hex,
    });
  } catch {
    valid = false;
  }
  if (!valid) return errorResponse("LOGIN_FAILED", "Could not sign in.");
  return { ok: true, user };
}
