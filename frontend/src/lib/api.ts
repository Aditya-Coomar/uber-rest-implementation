/**
 * Typed client for the public Rides API and the load simulator. The browser
 * calls same-origin paths that Next proxies (see next.config.ts), so the app
 * also works behind a single public URL. Marketplace and Payments are never
 * called from the browser.
 */

export const API_BASE_URL = (process.env.NEXT_PUBLIC_API_BASE_URL ?? '/rides-api').replace(/\/+$/, '');
export const SIM_BASE_URL = (process.env.NEXT_PUBLIC_SIM_API_BASE_URL ?? '/sim-api').replace(/\/+$/, '');

export type RideStatus = 'PENDING_MATCH' | 'ASSIGNED' | 'NO_DRIVER' | 'COMPLETED' | 'CANCELLED';
export type PaymentStatus = 'NOT_STARTED' | 'PENDING' | 'PAID' | 'DECLINED';

export interface Location {
  lat: number;
  lng: number;
  label?: string;
}

export interface PaymentMethodInfo {
  brand: string;
  last4: string | null;
}

export interface Fare {
  distanceMeters: number;
  amountMinor: number;
  currency: string;
  baseMinor: number;
  distanceMinor: number;
  perKmMinor: number;
}

export interface Ride {
  rideId: string;
  riderId: string;
  pickup: Location;
  destination: Location;
  status: RideStatus;
  driver: { driverId: string; name: string; vehicle: string; plate?: string; rating?: number } | null;
  fare: Fare;
  estimatedDurationSeconds: number;
  pickupDistanceMeters: number | null;
  pickupEtaSeconds: number | null;
  tripDurationSeconds: number | null;
  payment: {
    status: PaymentStatus;
    attemptId: string | null;
    declineCode: string | null;
    method: PaymentMethodInfo;
    paidAt?: string;
    attempts: Array<{ attemptId: string; status: 'PAID' | 'DECLINED'; declineCode: string | null; method: PaymentMethodInfo; settledAt: string }>;
  };
  createdAt: string;
  updatedAt: string;
  assignedAt?: string;
  completedAt?: string;
  cancelledAt?: string;
}

export interface FareQuote {
  fare: Fare;
  estimatedDurationSeconds: number;
}

export interface NearbyDrivers {
  drivers: Array<{ lat: number; lng: number; distanceMeters: number; etaSeconds: number }>;
  nearestEtaSeconds: number | null;
}

export interface AnalyticsSummary {
  completedTrips: number;
  updatedAt: string | null;
  generation: string | null;
  cancelledTrips: number;
  completionRate: number | null;
  currency: string;
  grossBookingsMinor: number;
  collectedMinor: number;
  declinedMinor: number;
  averageFareMinor: number | null;
  averageDistanceMeters: number | null;
  averageDurationSeconds: number | null;
  totalDistanceMeters: number;
  paymentsApproved: number;
  paymentsDeclined: number;
  approvalRate: number | null;
}

export interface PipelineStatus {
  jobs: { total: number; due: number; byKind: Record<string, number>; truncated: boolean };
  eventQueue: { visible: number; inFlight: number } | null;
  deadLetterQueue: { visible: number; inFlight: number } | null;
  worker: { state: string; heartbeatAgeMs: number | null };
  timestamp: string;
}

export interface LatencySummary {
  count: number;
  mean: number | null;
  p50: number | null;
  p90: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
}

export interface SimulationConfig {
  ratePerSecond: number;
  durationSeconds: number;
  fleetSize: number;
  cancelRate: number;
  tripSeconds: number;
  retryDeclined: boolean;
}

export interface SimulationPoint {
  t: number;
  requested: number;
  assigned: number;
  noDriver: number;
  failed: number;
  completed: number;
  cancelled: number;
  paid: number;
  declined: number;
  bookingP50: number | null;
  bookingP95: number | null;
  inFlight: number | null;
  busyDrivers: number | null;
  totalDrivers: number | null;
  jobsPending: number | null;
  queueDepth: number | null;
  projectedCompleted: number | null;
  expectedCompleted: number | null;
}

export interface Simulation {
  id: string;
  status: 'preparing' | 'running' | 'draining' | 'finished' | 'stopped' | 'failed';
  error: string | null;
  config: SimulationConfig;
  elapsedSeconds: number;
  inFlight: number;
  totals: Record<
    | 'requested' | 'assigned' | 'noDriver' | 'unavailable' | 'recovered' | 'rejected' | 'errors' | 'shed'
    | 'completed' | 'cancelled' | 'actionFailed' | 'paid' | 'declined' | 'retried' | 'paidAfterRetry' | 'paymentTimeouts',
    number
  >;
  rates: { achievedRequestsPerSecond: number; assignedPct: number | null; noDriverPct: number | null; failedPct: number | null; approvalPct: number | null };
  latencyMs: Record<'booking' | 'complete' | 'cancel' | 'paymentSettle' | 'timeToAssign', LatencySummary>;
  fleet: { setup: { inserted: number; total: number } | null; cleanup: { removed: number; busy: number } | null; latest: { total: number; busy: number; available: number } | null };
  pipeline: PipelineStatus | null;
  analytics: { baselineCompleted: number | null; latest: AnalyticsSummary | null };
  timeline: SimulationPoint[];
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Transport failures and 5xx may succeed if repeated with the same key. */
  get retryable(): boolean {
    return this.status === 0 || this.status >= 500;
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  idempotencyKey?: string;
  signal?: AbortSignal;
  transportRetries?: number;
}

async function request<T>(base: string, path: string, options: RequestOptions = {}): Promise<{ status: number; data: T }> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
  const attempts = 1 + (options.transportRetries ?? 0);
  for (let attempt = 1; ; attempt += 1) {
    let response: Response;
    try {
      const timeout = AbortSignal.timeout(12_000);
      response = await fetch(`${base}${path}`, {
        method: options.method ?? 'GET',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
        cache: 'no-store',
      });
    } catch (err) {
      if (options.signal?.aborted) throw err;
      if (attempt < attempts) {
        await new Promise((r) => setTimeout(r, 400 * attempt));
        continue;
      }
      throw new ApiError(0, 'NETWORK_ERROR', 'Can’t reach Kerb right now. Check your connection and try again.');
    }
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      throw new ApiError(response.status, 'BAD_RESPONSE', `Unexpected response (HTTP ${response.status}).`);
    }
    if (response.ok) return { status: response.status, data: json as T };
    const error = (json as { error?: { code?: string; message?: string; details?: Record<string, unknown>; requestId?: string } })?.error;
    throw new ApiError(response.status, error?.code ?? 'HTTP_ERROR', error?.message ?? `Request failed (HTTP ${response.status}).`, error?.details ?? {}, error?.requestId);
  }
}

export interface BookingInput {
  riderId: string;
  pickup: Location;
  destination: Location;
  paymentMethodId: string;
}

const rideUrl = (id: string) => `/rides/${encodeURIComponent(id)}`;

export const ridesApi = {
  async quote(pickup: Location, destination: Location, signal?: AbortSignal) {
    return (await request<FareQuote>(API_BASE_URL, '/fare-quotes', { method: 'POST', body: { pickup, destination }, signal })).data;
  },
  async nearby(point: { lat: number; lng: number }, signal?: AbortSignal) {
    return (await request<NearbyDrivers>(API_BASE_URL, `/drivers/nearby?lat=${point.lat}&lng=${point.lng}`, { signal })).data;
  },
  /** 201 on first assignment, 200 on replay. Errors carry details.rideId when a ride exists. */
  async bookRide(input: BookingInput, idempotencyKey: string) {
    const { status, data } = await request<Ride>(API_BASE_URL, '/rides', { method: 'POST', body: input, idempotencyKey, transportRetries: 1 });
    return { created: status === 201, ride: data };
  },
  async getRide(rideId: string, signal?: AbortSignal) {
    return (await request<Ride>(API_BASE_URL, rideUrl(rideId), { signal })).data;
  },
  async completeRide(rideId: string) {
    return (await request<Ride>(API_BASE_URL, `${rideUrl(rideId)}/complete`, { method: 'POST', transportRetries: 1 })).data;
  },
  async cancelRide(rideId: string) {
    return (await request<Ride>(API_BASE_URL, `${rideUrl(rideId)}/cancel`, { method: 'POST', transportRetries: 1 })).data;
  },
  async retryPayment(rideId: string, paymentMethodId: string, idempotencyKey: string) {
    return (await request<Ride>(API_BASE_URL, `${rideUrl(rideId)}/payment/retry`, { method: 'POST', body: { paymentMethodId }, idempotencyKey, transportRetries: 1 })).data;
  },
  async analytics(signal?: AbortSignal) {
    return (await request<AnalyticsSummary>(API_BASE_URL, '/analytics/summary', { signal })).data;
  },
  async pipeline(signal?: AbortSignal) {
    return (await request<PipelineStatus>(API_BASE_URL, '/ops/pipeline', { signal })).data;
  },
};

export const simApi = {
  async current(signal?: AbortSignal): Promise<Simulation | null> {
    try {
      return (await request<Simulation>(SIM_BASE_URL, '/simulations/current', { signal })).data;
    } catch (err) {
      if (err instanceof ApiError && err.code === 'NO_SIMULATION') return null;
      throw err;
    }
  },
  async start(config: SimulationConfig) {
    return (await request<Simulation>(SIM_BASE_URL, '/simulations', { method: 'POST', body: config })).data;
  },
  async stop() {
    return (await request<Simulation>(SIM_BASE_URL, '/simulations/current/stop', { method: 'POST' })).data;
  },
};

export function newIdempotencyKey(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}
