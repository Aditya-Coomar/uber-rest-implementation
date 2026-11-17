'use client';

import { useCallback, useSyncExternalStore } from 'react';

/**
 * localStorage-backed state. Reads go through useSyncExternalStore so the
 * server render (no storage) and the client agree, and updates in one place
 * (or another tab) re-render every reader.
 */
const EVENT = 'kerb:storage';
const cache = new Map<string, { raw: string | null; value: unknown }>();

function read<T>(key: string): T | null {
  const raw = window.localStorage.getItem(key);
  const hit = cache.get(key);
  if (hit && hit.raw === raw) return hit.value as T;
  let value: T | null = null;
  try {
    value = raw === null ? null : (JSON.parse(raw) as T);
  } catch {
    value = null;
  }
  cache.set(key, { raw, value });
  return value;
}

function subscribe(callback: () => void): () => void {
  window.addEventListener('storage', callback);
  window.addEventListener(EVENT, callback);
  return () => {
    window.removeEventListener('storage', callback);
    window.removeEventListener(EVENT, callback);
  };
}

export function writeLocal<T>(key: string, value: T | null): void {
  if (value === null) window.localStorage.removeItem(key);
  else window.localStorage.setItem(key, JSON.stringify(value));
  window.dispatchEvent(new Event(EVENT));
}

export function readLocal<T>(key: string): T | null {
  return typeof window === 'undefined' ? null : read<T>(key);
}

export function useLocal<T>(key: string): [T | null, (value: T | null) => void] {
  const value = useSyncExternalStore(
    subscribe,
    () => read<T>(key),
    () => null,
  );
  const set = useCallback((v: T | null) => writeLocal(key, v), [key]);
  return [value, set];
}

export const KEYS = {
  rider: 'kerb:rider',
  card: 'kerb:card',
  activeRide: 'kerb:active-ride',
  trips: 'kerb:trips',
  clock: (rideId: string) => `kerb:clock:${rideId}`,
};

/** Stable rider identity for this browser. */
export function ensureRiderId(): string {
  const existing = readLocal<string>(KEYS.rider);
  if (existing) return existing;
  const id = `rider-${crypto.randomUUID().slice(0, 8)}`;
  writeLocal(KEYS.rider, id);
  return id;
}

export function rememberTrip(rideId: string): void {
  const trips = readLocal<string[]>(KEYS.trips) ?? [];
  if (!trips.includes(rideId)) writeLocal(KEYS.trips, [rideId, ...trips].slice(0, 25));
}
