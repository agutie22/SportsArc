import type { EntityManager } from "@mikro-orm/postgresql";
import {
  User,
  isUserAudience,
  isUserRole,
  profileComplete,
  type UserAudience,
  type UserRole,
} from "../entities/User.js";
import { UserIdentifier } from "../entities/UserIdentifier.js";
import { reliabilityOf, type Reliability } from "./reliability.js";
import { teamByKey, type PublicTeam } from "../teams/catalog.js";

export interface PublicUser {
  id: string;
  name: string | null;
  role: string | null;
  headline: string | null;
  audience: string | null;
  email: string | null;
  phone: string | null;
  walletAddress: string | null;
  avatarUrl: string | null;
  circleUserId: string | null;
  profileComplete: boolean;
  /** Showed ÷ seats held after check-in closed. "New" under 3 games. */
  reliability: Reliability;
  /** The team whose colors the app wears; null for the SportsArc default. */
  team: PublicTeam | null;
}

/**
 * Starting headline for a brand new profile. Only ever applied when the
 * user has not written one: PATCH /api/profile lets them set their own,
 * and changing a name or role must not silently overwrite it.
 */
export function defaultHeadlineFor(role: string): string {
  if (role === "coach") return "Coach";
  if (role === "player") return "Player";
  return "Scout";
}

export async function toPublicUser(em: EntityManager, user: User): Promise<PublicUser> {
  const identifiers = await em.find(UserIdentifier, { user });
  const email = identifiers.find((i) => i.kind === "email")?.value ?? null;
  const phone = identifiers.find((i) => i.kind === "phone")?.value ?? null;
  return {
    id: user.id,
    name: user.name ?? null,
    role: user.role ?? null,
    headline: user.headline ?? null,
    audience: user.audience ?? null,
    email,
    phone,
    walletAddress: user.walletAddress ?? null,
    avatarUrl: user.avatarUrl ?? null,
    circleUserId: user.circleUserId ?? null,
    profileComplete: profileComplete(user),
    reliability: await reliabilityOf(em, user.id),
    team: teamByKey(user.teamKey),
  };
}

export async function findUserById(em: EntityManager, id: string): Promise<User | null> {
  return em.findOne(User, { id });
}

/**
 * True when this spelling is already someone's name or username.
 * Comparison is case-insensitive, so "Alex" and "alex" are one identity.
 * `exceptUserId` is the account being renamed, which may keep its own.
 */
export async function identityTaken(
  em: EntityManager,
  name: string,
  exceptUserId?: string,
): Promise<boolean> {
  const trimmed = name.trim();
  if (!trimmed) return false;
  const except = exceptUserId ?? null;
  const rows = await em.execute<{ hit: number }[]>(
    `select 1 as hit
     from user_identifiers
     where kind = 'username'
       and lower(value) = lower(?)
       and (cast(? as uuid) is null or user_id <> cast(? as uuid))
     union all
     select 1
     from users
     where name is not null
       and lower(name) = lower(?)
       and (cast(? as uuid) is null or id <> cast(? as uuid))
     limit 1`,
    [trimmed, except, except, trimmed, except, except],
  );
  return rows.length > 0;
}

export function applyProfile(
  user: User,
  body: { name?: string; role?: string; audience?: string },
): { ok: true } | { ok: false; message: string } {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const role = typeof body.role === "string" ? body.role.trim() : "";
  const audience = typeof body.audience === "string" ? body.audience.trim() : "";
  if (!name) return { ok: false, message: "Name is required." };
  if (!isUserRole(role)) return { ok: false, message: "Select a role." };
  if (!isUserAudience(audience)) return { ok: false, message: "Select who you are (18+, under 18, or parent/guardian)." };
  user.name = name;
  user.role = role as UserRole;
  user.audience = audience as UserAudience;
  if (!user.headline?.trim()) user.headline = defaultHeadlineFor(role);
  return { ok: true };
}
