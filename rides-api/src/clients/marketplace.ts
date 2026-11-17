import { isValidId } from '../lib/validate';
import type { DriverSnapshot } from '../domain/types';
import { config } from '../config';
import { callJson, errorCodeOf } from './internal-http';

export type ReserveResult =
  | { kind: 'RESERVED'; driver: DriverSnapshot; pickupDistanceMeters: number | null }
  | { kind: 'NO_DRIVER' }
  | { kind: 'UNAVAILABLE'; reason: string };

function isDriverSnapshot(value: unknown): value is DriverSnapshot {
  const d = value as Record<string, unknown> | null;
  return (
    typeof d === 'object' && d !== null &&
    isValidId(d.driverId) &&
    typeof d.name === 'string' && d.name.length > 0 && d.name.length <= 80 &&
    typeof d.vehicle === 'string' && d.vehicle.length > 0 && d.vehicle.length <= 80 &&
    (d.plate === undefined || (typeof d.plate === 'string' && d.plate.length <= 20)) &&
    (d.rating === undefined || (typeof d.rating === 'number' && d.rating >= 0 && d.rating <= 5))
  );
}

/** PUT /internal/reservations/{rideId}. Every non-decision becomes UNAVAILABLE. */
export async function reserveDriver(
  rideId: string,
  pickup: { lat: number; lng: number },
  deadlineMs: number,
  requestId?: string,
): Promise<ReserveResult> {
  const url = `${config.marketplaceBaseUrl}/internal/reservations/${encodeURIComponent(rideId)}`;
  const res = await callJson('PUT', url, { body: { pickup }, deadlineMs, requestId });
  if (!res.ok) return { kind: 'UNAVAILABLE', reason: res.reason };
  if (res.status === 200) {
    const body = res.body as Record<string, unknown> | null;
    if (body?.rideId === rideId && body.status === 'RESERVED' && isDriverSnapshot(body.driver)) {
      const { driverId, name, vehicle, plate, rating } = body.driver;
      const dist = body.pickupDistanceMeters;
      return {
        kind: 'RESERVED',
        driver: { driverId, name, vehicle, ...(plate !== undefined && { plate }), ...(rating !== undefined && { rating }) },
        pickupDistanceMeters: typeof dist === 'number' && Number.isFinite(dist) && dist >= 0 ? Math.round(dist) : null,
      };
    }
    return { kind: 'UNAVAILABLE', reason: 'invalid reservation payload' };
  }
  const code = errorCodeOf(res.body);
  if (res.status === 409 && code === 'NO_DRIVERS_AVAILABLE') return { kind: 'NO_DRIVER' };
  return { kind: 'UNAVAILABLE', reason: `HTTP ${res.status}${code ? ` ${code}` : ''}` };
}

/** DELETE /internal/reservations/{rideId}. True only once Marketplace confirms. */
export async function releaseDriver(rideId: string, deadlineMs: number): Promise<{ ok: boolean; reason?: string }> {
  const url = `${config.marketplaceBaseUrl}/internal/reservations/${encodeURIComponent(rideId)}`;
  const res = await callJson('DELETE', url, { deadlineMs });
  if (!res.ok) return { ok: false, reason: res.reason };
  if (res.status === 204) return { ok: true };
  return { ok: false, reason: `HTTP ${res.status}${errorCodeOf(res.body) ? ` ${errorCodeOf(res.body)}` : ''}` };
}

export interface NearbyDriver {
  lat: number;
  lng: number;
  distanceMeters: number;
}

/** Available drivers near a point (positions only), for the rider's map. */
export async function nearbyDrivers(
  point: { lat: number; lng: number },
  deadlineMs: number,
): Promise<{ ok: true; drivers: NearbyDriver[] } | { ok: false; reason: string }> {
  const url = `${config.marketplaceBaseUrl}/internal/drivers/available?lat=${point.lat}&lng=${point.lng}&radiusMeters=6000&limit=25`;
  const res = await callJson('GET', url, { deadlineMs });
  if (!res.ok) return { ok: false, reason: res.reason };
  const list = (res.body as { drivers?: unknown } | null)?.drivers;
  if (res.status !== 200 || !Array.isArray(list)) return { ok: false, reason: `HTTP ${res.status}` };
  const drivers: NearbyDriver[] = [];
  for (const d of list as Array<{ location?: { lat?: unknown; lng?: unknown }; distanceMeters?: unknown }>) {
    const lat = d.location?.lat;
    const lng = d.location?.lng;
    if (typeof lat === 'number' && typeof lng === 'number' && typeof d.distanceMeters === 'number') {
      drivers.push({ lat, lng, distanceMeters: d.distanceMeters });
    }
  }
  return { ok: true, drivers };
}
