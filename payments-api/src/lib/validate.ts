import { createHash } from 'node:crypto';
import { ApiError, invalidRequest } from './errors';

export interface Coordinates {
  lat: number;
  lng: number;
}

export interface Location extends Coordinates {
  label?: string;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw invalidRequest(`${field} must be a JSON object.`, { field });
  return value;
}

const ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;

/** Opaque identifier: 1-64 characters from a conservative alphabet. */
export function parseId(value: unknown, field: string, maxLength = 64): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || !ID_PATTERN.test(value)) {
    throw invalidRequest(`${field} must be a string of 1-${maxLength} letters, digits, '_', '.', ':' or '-'.`, { field });
  }
  return value;
}

export function isValidId(value: unknown, maxLength = 64): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && ID_PATTERN.test(value);
}

export function parseCoordinates(value: unknown, field: string): Coordinates {
  const obj = requireObject(value, field);
  const { lat, lng } = obj;
  if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw invalidRequest(`${field}.lat must be a finite number between -90 and 90.`, { field: `${field}.lat` });
  }
  if (typeof lng !== 'number' || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    throw invalidRequest(`${field}.lng must be a finite number between -180 and 180.`, { field: `${field}.lng` });
  }
  return { lat, lng };
}

export function parseLocation(value: unknown, field: string): Location {
  const coords = parseCoordinates(value, field);
  const label = (value as Record<string, unknown>).label;
  if (label === undefined || label === null) return coords;
  if (typeof label !== 'string' || label.trim().length === 0 || label.length > 80) {
    throw invalidRequest(`${field}.label must be a non-empty string of at most 80 characters.`, { field: `${field}.label` });
  }
  return { ...coords, label: label.trim() };
}

export function isCoordinates(value: unknown): value is Coordinates {
  if (!isPlainObject(value)) return false;
  const { lat, lng } = value;
  return (
    typeof lat === 'number' && Number.isFinite(lat) && lat >= -90 && lat <= 90 &&
    typeof lng === 'number' && Number.isFinite(lng) && lng >= -180 && lng <= 180
  );
}

/** JSON with recursively sorted keys, so equal values give equal fingerprints. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function fingerprint(value: unknown): string {
  return sha256(canonicalJson(value));
}

const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7E]{1,128}$/;

/** Validate the Idempotency-Key header (1-128 visible ASCII characters). */
export function parseIdempotencyKey(header: string | undefined): string {
  if (header === undefined || header.length === 0) {
    throw new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key header with this request.');
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(header)) {
    throw new ApiError(400, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must be 1-128 visible ASCII characters.');
  }
  return header;
}
