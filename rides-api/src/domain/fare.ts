import type { Coordinates } from '../lib/validate';
import type { Fare } from './types';

const EARTH_RADIUS_M = 6_371_008.8;
const rad = (deg: number) => (deg * Math.PI) / 180;

export const BASE_FARE_MINOR = 200;
export const PER_KM_MINOR = 150;
export const CURRENCY = 'USD';

/** Great-circle distance in meters (Haversine). */
export function haversineMeters(a: Coordinates, b: Coordinates): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Deterministic quote, frozen on the ride at booking time. */
export function quoteFare(pickup: Coordinates, destination: Coordinates): Fare {
  const distanceMeters = Math.round(haversineMeters(pickup, destination));
  return {
    distanceMeters,
    amountMinor: BASE_FARE_MINOR + Math.round((distanceMeters * PER_KM_MINOR) / 1000),
    currency: CURRENCY,
  };
}

/** Average urban speeds used for display estimates (meters per second). */
const TRIP_SPEED_MPS = 22_000 / 3600;
const APPROACH_SPEED_MPS = 25_000 / 3600;

/** Estimated in-car time for a trip, including a minute for pickup and drop-off. */
export function estimateDurationSeconds(distanceMeters: number): number {
  return Math.round(60 + distanceMeters / TRIP_SPEED_MPS);
}

/** Estimated time for a driver to reach the pickup. */
export function etaSeconds(distanceMeters: number): number {
  return Math.max(60, Math.round(distanceMeters / APPROACH_SPEED_MPS));
}
