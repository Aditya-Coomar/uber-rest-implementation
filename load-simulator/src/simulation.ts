import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { errorFields, logger } from './lib/log';
import { config } from './config';

/**
 * One load-simulation run. Simulated riders arrive open-loop at a fixed rate
 * and behave like the real app: book, hold the trip, complete (or cancel),
 * then wait for the asynchronous payment and retry a decline with another card.
 * Every interaction goes through the public Rides API; the fleet is sized
 * through Marketplace's internal fleet endpoint.
 */

export interface SimulationConfig {
  ratePerSecond: number;
  durationSeconds: number;
  fleetSize: number;
  cancelRate: number;
  tripSeconds: number;
  retryDeclined: boolean;
}

export const LIMITS = {
  ratePerSecond: [1, 50],
  durationSeconds: [5, 180],
  fleetSize: [0, 300],
  cancelRate: [0, 0.5],
  tripSeconds: [1, 15],
} as const;

const MAX_IN_FLIGHT = 800;
const CENTER = { lat: 12.9716, lng: 77.5946 };
const BRANDS = ['visa', 'mastercard', 'amex', 'rupay', 'discover'];

type Status = 'preparing' | 'running' | 'draining' | 'finished' | 'stopped' | 'failed';

class Histogram {
  private values: number[] = [];
  private sorted = true;

  add(v: number): void {
    this.values.push(v);
    this.sorted = false;
  }

  get count(): number {
    return this.values.length;
  }

  summary() {
    if (!this.sorted) {
      this.values.sort((a, b) => a - b);
      this.sorted = true;
    }
    const v = this.values;
    const q = (p: number) => (v.length ? v[Math.min(v.length - 1, Math.floor(p * v.length))] : null);
    return {
      count: v.length,
      mean: v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null,
      p50: q(0.5),
      p90: q(0.9),
      p95: q(0.95),
      p99: q(0.99),
      max: v.length ? v[v.length - 1] : null,
    };
  }
}

interface Bucket {
  t: number;
  requested: number;
  assigned: number;
  noDriver: number;
  failed: number;
  completed: number;
  cancelled: number;
  paid: number;
  declined: number;
  bookingMs: Histogram;
  inFlight?: number;
  busyDrivers?: number;
  totalDrivers?: number;
  jobsPending?: number;
  queueDepth?: number;
  projectedCompleted?: number;
  expectedCompleted?: number;
}

const COUNTERS = [
  'requested', 'assigned', 'noDriver', 'unavailable', 'recovered', 'rejected', 'errors', 'shed',
  'completed', 'cancelled', 'actionFailed', 'paid', 'declined', 'retried', 'paidAfterRetry', 'paymentTimeouts',
] as const;
type Counter = (typeof COUNTERS)[number];

function randomPoint(center: { lat: number; lng: number }, maxMeters: number, minMeters = 0) {
  const r = minMeters + (maxMeters - minMeters) * Math.sqrt(Math.random());
  const a = Math.random() * 2 * Math.PI;
  return {
    lat: Math.round((center.lat + (r * Math.cos(a)) / 111_320) * 1e6) / 1e6,
    lng: Math.round((center.lng + (r * Math.sin(a)) / (111_320 * Math.cos((center.lat * Math.PI) / 180))) * 1e6) / 1e6,
  };
}

const randomCard = () => `card_${BRANDS[Math.floor(Math.random() * BRANDS.length)]}_${String(Math.floor(Math.random() * 10_000)).padStart(4, '0')}`;

interface HttpResult {
  status: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

async function call(method: string, url: string, body?: unknown, idempotencyKey?: string, timeoutMs = 10_000): Promise<HttpResult> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body: parsed };
}

export class Simulation {
  readonly id = `sim_${Date.now().toString(36)}${randomUUID().slice(0, 4)}`;
  status: Status = 'preparing';
  error: string | null = null;
  readonly createdAt = new Date().toISOString();
  startedAt: number | null = null;
  endedAt: number | null = null;
  private stopRequested = false;
  private inFlight = 0;
  private counters = Object.fromEntries(COUNTERS.map((c) => [c, 0])) as Record<Counter, number>;
  private latency = {
    booking: new Histogram(),
    complete: new Histogram(),
    cancel: new Histogram(),
    paymentSettle: new Histogram(),
    timeToAssign: new Histogram(),
  };
  private buckets: Bucket[] = [];
  private fleetSetup: { inserted: number; total: number } | null = null;
  private fleetCleanup: { removed: number; busy: number } | null = null;
  private baselineCompleted: number | null = null;
  private latest: { fleet: unknown; pipeline: unknown; analytics: unknown } = { fleet: null, pipeline: null, analytics: null };
  private seq = 0;

  constructor(readonly cfg: SimulationConfig) {}

  stop(): void {
    this.stopRequested = true;
  }

  get active(): boolean {
    return this.status === 'preparing' || this.status === 'running' || this.status === 'draining';
  }

  private bucket(): Bucket {
    const t = this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0;
    let b = this.buckets[this.buckets.length - 1];
    while (!b || b.t < t) {
      b = { t: b ? b.t + 1 : 0, requested: 0, assigned: 0, noDriver: 0, failed: 0, completed: 0, cancelled: 0, paid: 0, declined: 0, bookingMs: new Histogram() };
      this.buckets.push(b);
    }
    return b;
  }

  private count(c: Counter, bucketField?: keyof Pick<Bucket, 'requested' | 'assigned' | 'noDriver' | 'failed' | 'completed' | 'cancelled' | 'paid' | 'declined'>): void {
    this.counters[c] += 1;
    if (bucketField) this.bucket()[bucketField] += 1;
  }

  async run(): Promise<void> {
    try {
      if (this.cfg.fleetSize > 0) {
        const res = await call('PUT', `${config.marketplaceBaseUrl}/internal/fleet/simulated`, { count: this.cfg.fleetSize }, undefined, 60_000);
        if (res.status !== 200) throw new Error(`fleet setup failed (HTTP ${res.status})`);
        this.fleetSetup = res.body;
      }
      const summary = await call('GET', `${config.ridesBaseUrl}/analytics/summary`).catch(() => null);
      this.baselineCompleted = typeof summary?.body?.completedTrips === 'number' ? summary.body.completedTrips : null;

      this.status = 'running';
      this.startedAt = Date.now();
      logger.info('simulation started', { id: this.id, ...this.cfg });
      const sampler = this.sampleLoop();

      // Open-loop arrivals: the schedule does not wait for responses.
      const endAt = this.startedAt + this.cfg.durationSeconds * 1000;
      let due = 0;
      let lastTick = Date.now();
      while (Date.now() < endAt && !this.stopRequested) {
        await sleep(50);
        const now = Date.now();
        due += ((now - lastTick) / 1000) * this.cfg.ratePerSecond;
        lastTick = now;
        while (due >= 1) {
          due -= 1;
          if (this.inFlight >= MAX_IN_FLIGHT) {
            this.count('shed', 'failed');
            continue;
          }
          void this.rider(++this.seq);
        }
      }

      this.status = 'draining';
      const drainUntil = Date.now() + 90_000;
      while (this.inFlight > 0 && Date.now() < drainUntil) await sleep(250);
      this.status = this.stopRequested ? 'stopped' : 'finished';
      this.endedAt = Date.now();
      await sleep(2_500); // let the sampler capture the pipeline catching up
      this.samplingDone = true;
      await sampler;
      if (this.cfg.fleetSize > 0) await this.cleanupFleet();
      logger.info('simulation ended', { id: this.id, status: this.status, ...this.counters });
    } catch (err) {
      this.status = 'failed';
      this.error = (err as Error).message;
      this.endedAt = Date.now();
      this.samplingDone = true;
      logger.error('simulation failed', { id: this.id, ...errorFields(err) });
    }
  }

  private samplingDone = false;

  private async cleanupFleet(): Promise<void> {
    for (let i = 0; i < 4; i += 1) {
      const res = await call('DELETE', `${config.marketplaceBaseUrl}/internal/fleet/simulated`).catch(() => null);
      if (res?.status === 200) {
        this.fleetCleanup = res.body;
        if (res.body.busy === 0) return;
      }
      await sleep(3_000);
    }
  }

  /** Once per second: fleet utilisation, pipeline backlog and projection progress. */
  private async sampleLoop(): Promise<void> {
    while (!this.samplingDone) {
      const [fleet, pipeline, analytics] = await Promise.all([
        call('GET', `${config.marketplaceBaseUrl}/internal/fleet/stats`, undefined, undefined, 2_000).catch(() => null),
        call('GET', `${config.ridesBaseUrl}/ops/pipeline`, undefined, undefined, 3_000).catch(() => null),
        call('GET', `${config.ridesBaseUrl}/analytics/summary`, undefined, undefined, 2_000).catch(() => null),
      ]);
      this.latest = { fleet: fleet?.body ?? null, pipeline: pipeline?.body ?? null, analytics: analytics?.body ?? null };
      const b = this.bucket();
      b.inFlight = this.inFlight;
      if (fleet?.status === 200) {
        b.busyDrivers = fleet.body.busy;
        b.totalDrivers = fleet.body.total;
      }
      if (pipeline?.status === 200) {
        b.jobsPending = pipeline.body.jobs?.total;
        const q = pipeline.body.eventQueue;
        b.queueDepth = q ? q.visible + q.inFlight : undefined;
      }
      if (analytics?.status === 200 && this.baselineCompleted !== null) {
        b.projectedCompleted = analytics.body.completedTrips - this.baselineCompleted;
        b.expectedCompleted = this.counters.completed;
      }
      await sleep(1_000);
    }
  }

  private async rider(n: number): Promise<void> {
    this.inFlight += 1;
    const rides = config.ridesBaseUrl;
    try {
      const pickup = randomPoint(CENTER, 3_500);
      const destination = randomPoint(pickup, 5_000, 600);
      const started = Date.now();
      this.count('requested', 'requested');
      const booked = await call('POST', `${rides}/rides`, {
        riderId: `sim-${this.id.slice(4)}-${n}`,
        pickup,
        destination,
        paymentMethodId: randomCard(),
      }, `sim-${this.id}-${n}`);
      const ms = Date.now() - started;
      this.latency.booking.add(ms);
      this.bucket().bookingMs.add(ms);

      let rideId: string | null = null;
      if (booked.status === 201 || booked.status === 200) {
        rideId = booked.body.rideId;
        this.latency.timeToAssign.add(ms);
        this.count('assigned', 'assigned');
      } else if (booked.status === 409 && booked.body?.error?.code === 'NO_DRIVERS_AVAILABLE') {
        this.count('noDriver', 'noDriver');
        return;
      } else if (booked.status === 503 && booked.body?.error?.details?.rideId) {
        // Unresolved match: the booking may still finish in the background.
        this.count('unavailable', 'failed');
        const pendingId = booked.body.error.details.rideId as string;
        const settled = await this.pollRide(pendingId, (r) => r.status !== 'PENDING_MATCH', 30_000);
        if (settled?.status !== 'ASSIGNED') return;
        this.latency.timeToAssign.add(Date.now() - started);
        this.count('recovered');
        rideId = pendingId;
      } else {
        this.count(booked.status >= 500 ? 'errors' : 'rejected', 'failed');
        return;
      }

      // Hold the trip like a real ride would (compressed).
      const hold = this.cfg.tripSeconds * 1000 * (0.5 + Math.random());
      const holdUntil = Date.now() + hold;
      while (Date.now() < holdUntil && !this.stopRequested) await sleep(Math.min(250, holdUntil - Date.now()));

      if (Math.random() < this.cfg.cancelRate) {
        const t = Date.now();
        const res = await call('POST', `${rides}/rides/${rideId}/cancel`);
        this.latency.cancel.add(Date.now() - t);
        if (res.status === 200) this.count('cancelled', 'cancelled');
        else this.count('actionFailed', 'failed');
        return;
      }

      const t = Date.now();
      const done = await call('POST', `${rides}/rides/${rideId}/complete`);
      this.latency.complete.add(Date.now() - t);
      if (done.status !== 200) {
        this.count('actionFailed', 'failed');
        return;
      }
      this.count('completed', 'completed');

      let ride = await this.pollRide(rideId!, (r) => r.payment?.status !== 'PENDING', 45_000);
      if (!ride) {
        this.count('paymentTimeouts');
        return;
      }
      this.latency.paymentSettle.add(Date.now() - t);
      if (ride.payment.status === 'PAID') {
        this.count('paid', 'paid');
        return;
      }
      this.count('declined', 'declined');
      if (!this.cfg.retryDeclined) return;

      // The rider enters another card and pays again.
      this.count('retried');
      const retried = await call('POST', `${rides}/rides/${rideId}/payment/retry`, { paymentMethodId: randomCard() }, `sim-retry-${this.id}-${n}`);
      if (retried.status !== 202 && retried.status !== 200) return;
      ride = await this.pollRide(rideId!, (r) => r.payment?.status !== 'PENDING', 45_000);
      if (ride?.payment.status === 'PAID') this.count('paidAfterRetry', 'paid');
      else if (ride?.payment.status === 'DECLINED') this.count('declined', 'declined');
    } catch (err) {
      this.count('errors', 'failed');
      logger.debug('rider failed', { n, ...errorFields(err) });
    } finally {
      this.inFlight -= 1;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async pollRide(rideId: string, done: (ride: any) => boolean, timeoutMs: number): Promise<any | null> {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      await sleep(750);
      const res = await call('GET', `${config.ridesBaseUrl}/rides/${rideId}`).catch(() => null);
      if (res?.status === 200 && done(res.body)) return res.body;
    }
    return null;
  }

  snapshot() {
    const now = this.endedAt ?? Date.now();
    const elapsed = this.startedAt ? (now - this.startedAt) / 1000 : 0;
    const c = this.counters;
    const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
    return {
      id: this.id,
      status: this.status,
      error: this.error,
      config: this.cfg,
      createdAt: this.createdAt,
      startedAt: this.startedAt ? new Date(this.startedAt).toISOString() : null,
      endedAt: this.endedAt ? new Date(this.endedAt).toISOString() : null,
      elapsedSeconds: Math.round(elapsed * 10) / 10,
      inFlight: this.inFlight,
      totals: { ...c },
      rates: {
        achievedRequestsPerSecond: elapsed > 0 ? Math.round((c.requested / Math.min(elapsed, this.cfg.durationSeconds)) * 10) / 10 : 0,
        assignedPct: pct(c.assigned, c.requested),
        noDriverPct: pct(c.noDriver, c.requested),
        failedPct: pct(c.unavailable + c.rejected + c.errors + c.shed, c.requested + c.shed),
        approvalPct: pct(c.paid + c.paidAfterRetry, c.paid + c.paidAfterRetry + c.declined),
      },
      latencyMs: {
        booking: this.latency.booking.summary(),
        complete: this.latency.complete.summary(),
        cancel: this.latency.cancel.summary(),
        paymentSettle: this.latency.paymentSettle.summary(),
        timeToAssign: this.latency.timeToAssign.summary(),
      },
      fleet: { setup: this.fleetSetup, cleanup: this.fleetCleanup, latest: this.latest.fleet },
      pipeline: this.latest.pipeline,
      analytics: {
        baselineCompleted: this.baselineCompleted,
        latest: this.latest.analytics,
      },
      timeline: this.buckets.slice(-240).map((b) => {
        const s = b.bookingMs.summary();
        return {
          t: b.t,
          requested: b.requested,
          assigned: b.assigned,
          noDriver: b.noDriver,
          failed: b.failed,
          completed: b.completed,
          cancelled: b.cancelled,
          paid: b.paid,
          declined: b.declined,
          bookingP50: s.p50,
          bookingP95: s.p95,
          inFlight: b.inFlight ?? null,
          busyDrivers: b.busyDrivers ?? null,
          totalDrivers: b.totalDrivers ?? null,
          jobsPending: b.jobsPending ?? null,
          queueDepth: b.queueDepth ?? null,
          projectedCompleted: b.projectedCompleted ?? null,
          expectedCompleted: b.expectedCompleted ?? null,
        };
      }),
    };
  }
}
