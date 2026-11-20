/**
 * Coordinates: validation, great-circle distance and the bounding-box prefilter
 * for "near me" queries.
 */

import { num } from "./validate.js";

export const MAX_RADIUS_KM = 200;
export const DEFAULT_RADIUS_KM = 25;

/** Great-circle distance in km. */
export function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const lat1 = (aLat * Math.PI) / 180;
  const lat2 = (bLat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function validLat(v: unknown): number | null {
  const n = num(v);
  return n !== null && n >= -90 && n <= 90 ? n : null;
}

export function validLng(v: unknown): number | null {
  const n = num(v);
  return n !== null && n >= -180 && n <= 180 ? n : null;
}

/** Bounding box prefilter — cheap in SQL, refined by haversine in JS. */
export function boundingBox(lat: number, lng: number, radiusKm: number) {
  const latDelta = radiusKm / 111.32;
  const lngDelta = radiusKm / (111.32 * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));
  return {
    lat: { $gte: lat - latDelta, $lte: lat + latDelta },
    lng: { $gte: lng - lngDelta, $lte: lng + lngDelta },
  };
}

export const round1 = (n: number) => Math.round(n * 10) / 10;
