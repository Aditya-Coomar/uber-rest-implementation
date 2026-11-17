/** Map projection for the simulated city: lat/lng -> a 1000x1000 canvas. */
export const BOUNDS = { minLat: 12.925, maxLat: 13.02, minLng: 77.55, maxLng: 77.66 };
export const CANVAS = 1000;

export interface Pt {
  x: number;
  y: number;
}

export function project(lat: number, lng: number): Pt {
  const x = ((lng - BOUNDS.minLng) / (BOUNDS.maxLng - BOUNDS.minLng)) * CANVAS;
  const y = ((BOUNDS.maxLat - lat) / (BOUNDS.maxLat - BOUNDS.minLat)) * CANVAS;
  return { x, y };
}

const EARTH_RADIUS_M = 6_371_008.8;
const rad = (d: number) => (d * Math.PI) / 180;

export function haversineMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** A plausible street route: leave along one axis, turn once mid-way, arrive along the other. */
export function streetRoute(a: Pt, b: Pt): Pt[] {
  const dx = Math.abs(b.x - a.x);
  const dy = Math.abs(b.y - a.y);
  if (dx < 6 || dy < 6) return [a, b];
  if (dx >= dy) {
    const midX = a.x + (b.x - a.x) * 0.55;
    return [a, { x: midX, y: a.y }, { x: midX, y: b.y }, b];
  }
  const midY = a.y + (b.y - a.y) * 0.55;
  return [a, { x: a.x, y: midY }, { x: b.x, y: midY }, b];
}

export function pathLength(points: Pt[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  return total;
}

/** Position and heading (degrees, 0 = east) at fraction t of a polyline. */
export function along(points: Pt[], t: number): { p: Pt; heading: number } {
  if (points.length < 2) return { p: points[0] ?? { x: 0, y: 0 }, heading: 0 };
  let remaining = Math.min(Math.max(t, 0), 1) * pathLength(points);
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    const heading = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
    if (remaining <= seg || i === points.length - 1) {
      const f = seg === 0 ? 0 : Math.min(remaining / seg, 1);
      return { p: { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }, heading };
    }
    remaining -= seg;
  }
  return { p: points[points.length - 1], heading: 0 };
}

export function toPath(points: Pt[]): string {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
}

/** Deterministic start point for an approaching driver, `meters` away from the pickup. */
export function approachStart(pickup: { lat: number; lng: number }, meters: number, seed: string): { lat: number; lng: number } {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const angle = ((h % 360) * Math.PI) / 180;
  const m = Math.max(450, meters);
  return {
    lat: pickup.lat + (m * Math.cos(angle)) / 111_320,
    lng: pickup.lng + (m * Math.sin(angle)) / (111_320 * Math.cos(rad(pickup.lat))),
  };
}
