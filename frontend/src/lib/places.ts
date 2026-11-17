import type { Location } from './api';

export interface Place extends Location {
  id: string;
  label: string;
  area: string;
}

/** Preset places in the simulated city. */
export const PLACES: Place[] = [
  { id: 'city-center', label: 'City Center', area: 'MG Circle', lat: 12.9716, lng: 77.5946 },
  { id: 'park-gate', label: 'Park Gate', area: 'Cubbon Park east entrance', lat: 12.981, lng: 77.606 },
  { id: 'old-market', label: 'Old Market', area: 'Chickpet bazaar', lat: 12.965, lng: 77.577 },
  { id: 'tech-park', label: 'Tech Park', area: 'Koramangala Block 4', lat: 12.9352, lng: 77.6245 },
  { id: 'central-station', label: 'Central Station', area: 'Platform 1 drop-off', lat: 12.9779, lng: 77.5713 },
  { id: 'lakeside-mall', label: 'Lakeside Mall', area: 'Ulsoor Lake road', lat: 12.9817, lng: 77.6195 },
  { id: 'university', label: 'University Campus', area: 'North gate', lat: 13.0002, lng: 77.5843 },
  { id: 'museum-quarter', label: 'Museum Quarter', area: 'Kasturba Road', lat: 12.9745, lng: 77.5966 },
  { id: 'riverside', label: 'Riverside Walk', area: 'Ghat steps', lat: 12.9551, lng: 77.6005 },
  { id: 'stadium', label: 'Stadium', area: 'Gate 3', lat: 12.9788, lng: 77.5996 },
  { id: 'hospital', label: 'City Hospital', area: 'Emergency bay', lat: 12.9592, lng: 77.6448 },
  { id: 'airport-bus', label: 'Airport Bus Stand', area: 'Hebbal flyover', lat: 13.0101, lng: 77.5911 },
];

export const DEFAULT_PICKUP = PLACES[0];

export function placeById(id: string): Place | undefined {
  return PLACES.find((p) => p.id === id);
}
