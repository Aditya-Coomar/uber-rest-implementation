import type { Coordinates } from './lib/validate';

export interface DriverSnapshot {
  driverId: string;
  name: string;
  vehicle: string;
  plate?: string;
  rating?: number;
}

export interface SeedDriver extends DriverSnapshot {
  location: Coordinates;
  plate: string;
  rating: number;
  simulated?: boolean;
}

/** Deterministic demo fleet. */
export const SEED_DRIVERS: SeedDriver[] = [
  { driverId: 'driver-01', name: 'Asha', vehicle: 'Blue hatchback', plate: 'KA 01 AB 1234', rating: 4.92, location: { lat: 12.972, lng: 77.595 } },
  { driverId: 'driver-02', name: 'Dev', vehicle: 'White sedan', plate: 'KA 05 MN 4821', rating: 4.87, location: { lat: 12.976, lng: 77.6 } },
  { driverId: 'driver-03', name: 'Mira', vehicle: 'Silver compact', plate: 'KA 03 XY 7310', rating: 4.95, location: { lat: 12.968, lng: 77.59 } },
];

export const SIM_DRIVER_PREFIX = 'sim-driver-';
export const MAX_SIM_DRIVERS = 500;
const CITY_CENTER: Coordinates = { lat: 12.9716, lng: 77.5946 };

const NAMES = ['Arjun', 'Priya', 'Kiran', 'Meera', 'Rahul', 'Sneha', 'Vikram', 'Anjali', 'Rohan', 'Divya', 'Karthik', 'Neha', 'Sameer', 'Lakshmi', 'Imran', 'Pooja', 'Farah', 'Naveen', 'Tara', 'Joseph'];
const COLORS = ['White', 'Silver', 'Grey', 'Black', 'Blue', 'Red', 'Green', 'Beige'];
const MODELS = ['hatchback', 'sedan', 'compact', 'SUV', 'MPV'];

/** Small deterministic PRNG so simulated driver N always looks the same. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Simulated driver #n (1-based), spread over ~4.5 km around the city center. */
export function simulatedDriver(n: number): SeedDriver {
  const rand = mulberry32(n * 7919);
  const radius = 4_500 * Math.sqrt(rand());
  const angle = rand() * 2 * Math.PI;
  const dLat = (radius * Math.cos(angle)) / 111_320;
  const dLng = (radius * Math.sin(angle)) / (111_320 * Math.cos((CITY_CENTER.lat * Math.PI) / 180));
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
  const letters = () => String.fromCharCode(65 + Math.floor(rand() * 26), 65 + Math.floor(rand() * 26));
  return {
    driverId: `${SIM_DRIVER_PREFIX}${String(n).padStart(4, '0')}`,
    name: pick(NAMES),
    vehicle: `${pick(COLORS)} ${pick(MODELS)}`,
    plate: `KA ${String(1 + Math.floor(rand() * 60)).padStart(2, '0')} ${letters()} ${String(1000 + Math.floor(rand() * 9000))}`,
    rating: Math.round((4.55 + rand() * 0.45) * 100) / 100,
    location: { lat: Math.round((CITY_CENTER.lat + dLat) * 1e6) / 1e6, lng: Math.round((CITY_CENTER.lng + dLng) * 1e6) / 1e6 },
    simulated: true,
  };
}

const EARTH_RADIUS_M = 6_371_008.8;
const rad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance in meters. */
export function haversineMeters(a: Coordinates, b: Coordinates): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}
