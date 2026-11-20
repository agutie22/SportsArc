/**
 * Sponsorships (Sponsorship.ts): a verified sponsor org names partner
 * courts, and backs league seasons once the league accepts.
 *
 *   partner courts   the sponsor's owners and admins add or end one; it is
 *                    active at once (a court holds no account to ask)
 *   seasons          the sponsor proposes, the league's staff accept or
 *                    decline; either side can end it
 *   prize money      sponsorFor(): may this person fund this event's prize
 *                    for a sponsor? Yes when they are the org's signer (its
 *                    wallet), the org is verified, and it actively sponsors
 *                    the event's season or venue (web3/events startPrize)
 *
 * Reads are public: who sponsors what is part of the record.
 */

import type { EntityManager } from "@mikro-orm/postgresql";
import { fail, type Failure } from "../failure.js";
import { isUuid } from "../validate.js";
import type { Game } from "../entities/Game.js";
import type { User } from "../entities/User.js";
import { Venue } from "../entities/Venue.js";
import { Season } from "../leagues/Season.js";
import { findOrg } from "./orgs.js";
import type { Organization } from "./Organization.js";
import { mayOrg, orgRole, requireOrg, verifiedGate } from "./roles.js";
import { Sponsorship } from "./Sponsorship.js";

const gone = (): Failure => fail("SPONSORSHIP_NOT_FOUND", "No such sponsorship.");

function cleanOffer(raw: unknown): string | null {
  return typeof raw === "string" ? raw.trim().replace(/\s+/g, " ").slice(0, 140) || null : null;
}

/** The sponsor's owners and admins speak for it; it must be a verified sponsor org. */
async function sponsorGate(em: EntityManager, user: User, orgRef: string): Promise<Organization | Failure> {
  const org = await findOrg(em, orgRef);
  if (!org) return fail("ORG_NOT_FOUND", "That organization does not exist.");
  if (org.kind !== "sponsor") return fail("ORG_KIND", "Only a sponsor organization sponsors courts and seasons.");
  const denied = await requireOrg(em, user.id, org.id, "edit");
  if (denied) return denied;
  return verifiedGate(org, "sponsor") ?? org;
}

const isFailure = (v: unknown): v is Failure => typeof v === "object" && v !== null && (v as Failure).ok === false;

export async function sponsorVenue(em: EntityManager, user: User, orgRef: string, body: { venueId?: unknown; offer?: unknown }) {
  const org = await sponsorGate(em, user, orgRef);
  if (isFailure(org)) return org;
  const venue = typeof body.venueId === "string" && isUuid(body.venueId) ? await em.findOne(Venue, { id: body.venueId }) : null;
  if (!venue) return fail("VENUE_NOT_FOUND", "That venue does not exist.");
  let s = await em.findOne(Sponsorship, { sponsor: org, venue });
  if (s?.status === "active") return fail("ALREADY_SPONSORED", `${venue.name} is already a partner court.`);
  if (!s) {
    s = new Sponsorship();
    s.sponsor = org;
    s.kind = "venue";
    s.venue = venue;
    s.createdBy = user;
    em.persist(s);
  }
  s.status = "active";
  s.startsAt = new Date();
  s.endedAt = null;
  s.offer = cleanOffer(body.offer);
  await em.flush();
  return { ok: true as const, sponsorship: { id: s.id } };
}

export async function proposeSeason(em: EntityManager, user: User, orgRef: string, body: { seasonId?: unknown; offer?: unknown }) {
  const org = await sponsorGate(em, user, orgRef);
  if (isFailure(org)) return org;
  const season = typeof body.seasonId === "string" && isUuid(body.seasonId)
    ? await em.findOne(Season, { id: body.seasonId }, { populate: ["league", "league.org"] })
    : null;
  if (!season) return fail("SEASON_NOT_FOUND", "That season does not exist.");
  if (season.status === "final" || season.status === "cancelled") return fail("SEASON_CLOSED", "This season is over.");
  let s = await em.findOne(Sponsorship, { sponsor: org, season });
  if (s && s.status !== "ended") return fail("ALREADY_SPONSORED", "You already back this season, or asked to.");
  if (!s) {
    s = new Sponsorship();
    s.sponsor = org;
    s.kind = "season";
    s.season = season;
    s.createdBy = user;
    em.persist(s);
  }
  s.status = "proposed";
  s.startsAt = null;
  s.endedAt = null;
  s.offer = cleanOffer(body.offer);
  await em.flush();
  return { ok: true as const, sponsorship: { id: s.id, status: s.status } };
}

/** The league's staff accept or decline a season sponsorship. */
export async function answerSeasonSponsor(em: EntityManager, user: User, id: string, accept: boolean) {
  const s = isUuid(id) ? await em.findOne(Sponsorship, { id }, { populate: ["season", "season.league"] }) : null;
  if (!s || s.kind !== "season" || !s.season || s.status !== "proposed") return gone();
  const denied = await requireOrg(em, user.id, s.season.league.org.id, "run");
  if (denied) return denied;
  if (accept) {
    s.status = "active";
    s.startsAt = new Date();
  } else {
    em.remove(s);
  }
  await em.flush();
  return { ok: true as const };
}

/** Either side ends it: the sponsor's owners and admins, or (for a season) the league's staff. */
export async function endSponsorship(em: EntityManager, user: User, id: string) {
  const s = isUuid(id) ? await em.findOne(Sponsorship, { id }, { populate: ["season", "season.league"] }) : null;
  if (!s || s.status === "ended") return gone();
  const sponsorSide = mayOrg(await orgRole(em, user.id, s.sponsor.id), "edit");
  const leagueSide = s.season ? mayOrg(await orgRole(em, user.id, s.season.league.org.id), "run") : false;
  if (!sponsorSide && !leagueSide) return fail("NOT_ORG_STAFF", "Only the sponsor or the league can end this.");
  if (s.status === "proposed") em.remove(s);
  else {
    s.status = "ended";
    s.endedAt = new Date();
  }
  await em.flush();
  return { ok: true as const };
}

export interface SponsorView {
  id: string;
  status: string;
  offer: string | null;
  startsAt: string | null;
  sponsor: { id: string; slug: string; name: string; verified: boolean };
  venue: { id: string; name: string; lat: number; lng: number } | null;
  season: { id: string; name: string; league: string; org: { slug: string; name: string } } | null;
}

function view(s: Sponsorship): SponsorView {
  return {
    id: s.id,
    status: s.status,
    offer: s.offer ?? null,
    startsAt: s.startsAt?.toISOString() ?? null,
    sponsor: { id: s.sponsor.id, slug: s.sponsor.slug, name: s.sponsor.name, verified: Boolean(s.sponsor.verifiedAt) },
    venue: s.venue ? { id: s.venue.id, name: s.venue.name, lat: s.venue.lat, lng: s.venue.lng } : null,
    season: s.season
      ? { id: s.season.id, name: s.season.name, league: s.season.league.name, org: { slug: s.season.league.org.slug, name: s.season.league.org.name } }
      : null,
  };
}

const POPULATE = ["sponsor", "venue", "season", "season.league", "season.league.org"] as const;

/** What an org sponsors. Proposals show only to its own staff. Public. */
export async function orgSponsorships(em: EntityManager, orgRef: string, viewerId?: string) {
  const org = await findOrg(em, orgRef);
  if (!org) return fail("ORG_NOT_FOUND", "That organization does not exist.");
  const staff = mayOrg(await orgRole(em, viewerId, org.id), "run");
  const rows = await em.find(
    Sponsorship,
    { sponsor: org, status: { $in: staff ? ["active", "proposed"] : ["active"] } },
    { populate: POPULATE, orderBy: { createdAt: "ASC" } },
  );
  return { ok: true as const, sponsorships: rows.map(view) };
}

/** A season's sponsors: active for everyone, proposals for the league's staff. */
export async function seasonSponsors(em: EntityManager, season: Season, staff: boolean): Promise<SponsorView[]> {
  const rows = await em.find(
    Sponsorship,
    { season, status: { $in: staff ? ["active", "proposed"] : ["active"] } },
    { populate: POPULATE, orderBy: { createdAt: "ASC" } },
  );
  return rows.map(view);
}

/** Active partner courts of verified sponsors, by venue id (insights and the map). */
export async function partnerCourts(em: EntityManager): Promise<Map<string, SponsorView>> {
  const rows = await em.find(Sponsorship, { kind: "venue", status: "active", sponsor: { verifiedAt: { $ne: null } } }, { populate: POPULATE });
  return new Map(rows.map((s) => [s.venue!.id, view(s)]));
}

/**
 * The sponsor org this person may fund `game`'s prize for, or null: they
 * are its signer (whose wallet pays), it is verified, and it actively
 * sponsors the game's season or venue.
 */
export async function sponsorFor(em: EntityManager, user: User, game: Game): Promise<Organization | null> {
  const where = [
    ...(game.season ? [{ season: game.season.id }] : []),
    { venue: game.venue.id },
  ];
  const rows = await em.find(Sponsorship, { status: "active", $or: where }, { populate: ["sponsor"] });
  for (const s of rows) {
    const org = s.sponsor;
    if (org.verifiedAt && org.signer?.id === user.id) return org;
  }
  return null;
}
