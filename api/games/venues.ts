/**
 * Venues: where games happen. Built from user input, listed by name or
 * distance.
 */

import type { EntityManager } from "@mikro-orm/postgresql";
import { Venue, isVenueKind } from "../entities/Venue.js";
import type { User } from "../entities/User.js";
import { fail, type Failure } from "../failure.js";
import { DEFAULT_RADIUS_KM, MAX_RADIUS_KM, boundingBox, haversineKm, round1, validLat, validLng } from "../geo.js";
import { num } from "../validate.js";

export interface VenueInput {
  name?: unknown;
  address?: unknown;
  lat?: unknown;
  lng?: unknown;
  kind?: unknown;
  indoor?: unknown;
}

export function buildVenue(body: VenueInput, createdBy: User | null): Venue | Failure {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return fail("VALIDATION_ERROR", "Venue name is required.");
  if (name.length > 160) return fail("VALIDATION_ERROR", "Venue name is too long.");

  const lat = validLat(body.lat);
  const lng = validLng(body.lng);
  if (lat === null || lng === null) {
    return fail("VALIDATION_ERROR", "Venue needs a valid lat and lng.");
  }

  const kindRaw = typeof body.kind === "string" ? body.kind.trim() : "park";
  if (!isVenueKind(kindRaw)) return fail("VALIDATION_ERROR", "Unknown venue kind.");

  const venue = new Venue();
  venue.name = name;
  venue.address = typeof body.address === "string" ? body.address.trim().slice(0, 255) || null : null;
  venue.lat = lat;
  venue.lng = lng;
  venue.kind = kindRaw;
  venue.indoor = body.indoor === true;
  venue.createdBy = createdBy;
  return venue;
}

export function toPublicVenue(v: Venue) {
  return {
    id: v.id,
    name: v.name,
    address: v.address ?? null,
    lat: v.lat,
    lng: v.lng,
    kind: v.kind,
    indoor: v.indoor,
  };
}

export async function listVenues(
  em: EntityManager,
  opts: { lat?: unknown; lng?: unknown; radiusKm?: unknown; q?: unknown },
) {
  const lat = validLat(opts.lat);
  const lng = validLng(opts.lng);
  const q = typeof opts.q === "string" ? opts.q.trim() : "";

  const where: Record<string, unknown> = {};
  if (q) where.name = { $ilike: `%${q}%` };

  if (lat !== null && lng !== null) {
    const radius = Math.min(num(opts.radiusKm) ?? DEFAULT_RADIUS_KM, MAX_RADIUS_KM);
    Object.assign(where, boundingBox(lat, lng, radius));
    const rows = await em.find(Venue, where, { limit: 200 });
    return rows
      .map((v) => ({ ...toPublicVenue(v), distanceKm: round1(haversineKm(lat, lng, v.lat, v.lng)) }))
      .filter((v) => v.distanceKm <= radius)
      .sort((a, b) => a.distanceKm - b.distanceKm);
  }

  const rows = await em.find(Venue, where, { limit: 100, orderBy: { name: "ASC" } });
  return rows.map(toPublicVenue);
}
