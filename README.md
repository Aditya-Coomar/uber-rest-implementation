# Kerb: a ride-booking SOA demo

Kerb is a local, fully simulated ride-hailing system. It demonstrates service boundaries, a REST gateway, failure isolation, replayable analytics, and how the system behaves under high load.

A rider books from a live city map: pick a destination, see the upfront fare, add a card, and request. You then watch the driver approach, share a PIN, ride to the drop-off, pay, and get a receipt. Behind the app, three Express 5 APIs, a durable worker and a load simulator run on Node.js. They use DynamoDB, S3 and SQS inside an **existing LocalStack** instance.

Everything is simulated. Drivers are seeded, places are presets, trips run in compressed time, and banks approve or decline at random. **Card numbers never leave the browser**: only a token such as `card_visa_4242` (brand and last four digits) is sent.

```
 Browser (Next.js) ── same-origin /rides-api, /sim-api ──▶ Next server (proxy)
                                                             │
                     ┌───────────────────────────────────────┤
                     ▼                                       ▼
            rides-api (public, :4100)                load-simulator (:4103)
              │  PUT/DELETE /internal/reservations ──▶ marketplace-api (:4101)
              │  durable jobs (DynamoDB, indexed)            ▲ fleet sizing
              ▼                                              │
        rides worker ── PUT /internal/payment-attempts ──▶ payments-api (:4102)
              │
              ├─ PutObject ride-completed/ · ride-cancelled/ · payment-settled/ ──▶ S3 archive
              │                                                                       │ object-created
              └─◀──────────────────────────── SQS (+ DLQ) ◀───────────────────────────┘
                 each event counted once → analytics projection (replayable)
```

| Directory | Responsibility |
| --- | --- |
| `rides-api/` | Public REST API: ride state, fare quotes, orchestration, nearby cars, analytics and pipeline reads. Also holds the **worker** (`dist/worker.js`), the LocalStack **bootstrap**, the **replay** command and the **smoke** test. |
| `marketplace-api/` | Driver fleet (3 regular drivers plus optional simulated cars), exclusive ride-keyed reservations, fleet stats (internal). |
| `payments-api/` | Simulated, idempotent payment attempts with a random bank decision (internal). |
| `load-simulator/` | Drives the public Rides API with simulated riders and reports throughput, latency, fleet use, backlog and analytics lag. |
| `frontend/` | Next.js app: **Ride**, **Trips**, **Insights**, **Load lab**. |
| `scripts/start.mjs` | One-command backend launcher (no shell, works on Windows). |

Each service owns one DynamoDB table (`<prefix>-rides`, `<prefix>-marketplace`, `<prefix>-payments`). There is no other database.

## Prerequisites

- **Node.js 24** (`.nvmrc`; `nvm use` picks it up). Newer versions work; older ones are rejected.
- npm (bundled with Node).
- A running **LocalStack** with `dynamodb`, `s3` and `sqs` enabled (Community 4.x is fine). The demo reuses your existing instance and keeps everything under one resource prefix (default `ridedemo`), so other projects on the same LocalStack are not affected.

## Setup

```bash
nvm use                 # Node 24
npm run install:all     # npm ci in all five packages
cp .env.example .env    # optional: every setting has a default
```

### How the LocalStack endpoint is found

`npm start`, `npm run bootstrap`, `npm run smoke` and `npm run analytics:replay` resolve the gateway in this order:

1. `LOCALSTACK_ENDPOINT_URL`, if set. This is authoritative; nothing else is tried.
2. `docker ps`: any running container whose image contains `localstack` and publishes container port 4566. Compose-managed containers are included.
3. `http://localhost:4566`, then `http://127.0.0.1:4566`.

A candidate is accepted only if `/_localstack/health` reports `dynamodb`, `s3` and `sqs` as running or available **and** real SDK calls succeed. Every step is logged. If nothing validates, bootstrap prints each step's result and exits without creating anything.

All SDK clients get the resolved endpoint and region explicitly, use dummy credentials (`test`/`test`, never your real AWS credentials), and use path-style S3. LocalStack advertises queue URLs on `localhost.localstack.cloud`. The SQS client keeps that URL as the queue's identity but sends traffic to the verified gateway (`useQueueUrlAsEndpoint: false`).

### Environment variables

Root `.env` (read by the root scripts):

| Variable | Default | Purpose |
| --- | --- | --- |
| `LOCALSTACK_ENDPOINT_URL` | discovered | LocalStack gateway |
| `AWS_REGION` | `us-east-1` | Region for every client |
| `DEMO_RESOURCE_PREFIX` | `ridedemo` | Namespace for tables, bucket and queues |
| `RIDES_API_PORT`, `MARKETPLACE_API_PORT`, `PAYMENTS_API_PORT`, `SIMULATOR_PORT` | first free port from 4100 / 4101 / 4102 / 4103 | Backend ports. An explicitly set port must be free. |
| `FRONTEND_ORIGIN` | `http://localhost:3000` | Browser origin(s) allowed by Rides CORS (comma-separated) |
| `PAYMENT_APPROVAL_RATE` | `0.75` | Probability that the simulated bank approves a card charge |

The launcher derives and passes these to the processes. Set them yourself only when you run a package on its own (see each package's `.env.example`):

| Variable | Used by |
| --- | --- |
| `PORT`, `BIND_HOST` (`127.0.0.1`) | every API |
| `MARKETPLACE_API_BASE_URL`, `PAYMENTS_API_BASE_URL` | Rides API and worker |
| `RIDES_API_BASE_URL`, `MARKETPLACE_API_BASE_URL` | load simulator |
| `CORS_ORIGINS` | Rides API |
| `RIDES_API_PROXY_TARGET`, `SIM_API_PROXY_TARGET` | frontend proxy targets (`frontend/.env.local`) |
| `NEXT_PUBLIC_API_BASE_URL` (`/rides-api`), `NEXT_PUBLIC_SIM_API_BASE_URL` (`/sim-api`) | frontend; set the first to the absolute Rides URL to call it directly via CORS instead |

## Run it

**Terminal 1: backend**

```bash
npm start
```

This builds the four backend packages and then:

1. validates the configuration;
2. bootstraps LocalStack:
   - three `PAY_PER_REQUEST` tables, including two sparse indexes (`jobs-due` on Rides and `drivers` on Marketplace) added in place to existing tables;
   - the `<prefix>-trip-events` archive bucket;
   - the `<prefix>-trip-events` queue with a DLQ (`maxReceiveCount` 5), plus a queue policy that lets S3 send messages only from the archive bucket's ARN;
   - object-created notifications for the three event prefixes;
   - checks that conditional writes and transactions work and that an S3 notification actually reaches SQS;
3. seeds or reconciles the three drivers' profiles (current reservations are never touched);
4. starts Marketplace, Payments, Rides, the worker and the load simulator, waits for health checks, and prints a status table;
5. writes `frontend/.env.local` with the proxy targets. It only does this if the file is missing or was created by the launcher.

Running the bootstrap again is safe: it never resets rides, reservations, archived events or analytics. Type `status` + Enter to re-check the processes. **Ctrl+C** stops everything (the worker first; its in-flight SQS poll is allowed to finish).

**Terminal 2: frontend**

```bash
npm run frontend:dev        # or: npm run frontend:build && npm start --prefix frontend
```

Open <http://localhost:3000>.

### What to try

1. **Ride:** *Where to?* → *Park Gate*. You get an upfront fare of **$4.43** (1.6 km: $2.00 base + $1.50/km), with nearby cars on the map. Add a card (try `4242 4242 4242 4242`, any future expiry, any CVC) and press **Request Kerb Go**.
2. **On the trip:** Asha's car drives to you along the amber route. You'll see her rating, plate and a 4-digit PIN, then the trip runs to the drop-off. Trips run in compressed time; **Skip to pickup / Start trip now / Skip to drop-off** fast-forward. You can **Cancel** before the trip starts.
3. **Payment:** at the drop-off the trip ends and your card is charged. The bank decides at random. If it's declined (insufficient funds, card limit and so on), enter another card and **Pay $4.43**. The receipt lists every attempt.
4. **Reload** at any point: the trip resumes where it was.
5. **Trips:** your history, with receipts and a **Pay now** link for any unpaid trip.
6. **Insights:** city-wide numbers, all built from the event archive: completed and cancelled trips, fares booked, revenue collected, average fare, distance and time, bank approval rate. Also the live state of the pipeline that feeds them.
7. **Load lab:** pick *Quiet afternoon*, *Rush hour* or *Stadium exit*, or set the request rate, duration, fleet size, trip length and cancel rate, then **Start simulation**. Six live charts plus a plain-language *What happened* summary show where the system bends.

### Share a public URL (Cloudflare quick tunnel)

The browser only calls same-origin paths that Next proxies, so a single tunnel to the frontend is enough. Marketplace, Payments and LocalStack stay on localhost.

```bash
npm start                                                       # terminal 1
npm run frontend:build && npx --prefix frontend next start -p 3000   # terminal 2
cloudflared tunnel --no-autoupdate --url http://localhost:3000  # terminal 3: prints https://<random>.trycloudflare.com
```

Quick-tunnel URLs are random and last only as long as `cloudflared` runs. Anyone with the URL can book rides and start load simulations (both bounded and simulated). For a stable hostname, use a named tunnel on your own Cloudflare domain.

## Behaviour under load

The simulator sends open-loop traffic (arrivals don't wait for earlier responses), just as many independent riders would. Each simulated rider books, holds the car, completes or cancels, then polls until the payment settles and retries a decline with another card. Simulated cars are added for the run and removed afterwards.

Measured on one laptop running everything in LocalStack:

| Scenario | Outcome |
| --- | --- |
| 10 req/s · 40 cars | 100% matched, booking p95 172 ms, payment settled ~0.8 s after trip end, projection exactly caught up |
| 15 req/s · 120 cars | 100% matched, booking p95 866 ms, end-trip p95 283 ms, up to 82 pending jobs drained, 594/594 trips counted |
| 25 req/s · 120 cars | Fleet saturated, so 44% got a fast "no cars". Booking p95 ~4 s from contention for the nearest free cars; 12% exceeded the 2.5 s matching budget and were settled in the background. Job backlog peaked at 462 and queued events at 130, then drained. 298/298 trips counted. |

The design choices that make this degrade gracefully:

- Ending a trip commits one transaction and returns. Payment, driver release and event publication are durable jobs.
- The worker queries an index of due jobs and runs 16 at a time, instead of scanning the table.
- Matching reads driver keys from a sparse index, then fetches drivers with a consistent batch read, so it never scans accumulated reservations.
- SQS messages are processed in parallel and deduplicated per event.

## Replay analytics

```bash
npm run analytics:replay
```

This rebuilds **every** analytics metric from the S3 archive (all three event prefixes) into a fresh projection generation:

1. It asks the worker to pause and waits for the acknowledgement. If no worker is running (its heartbeat is stale), replay proceeds directly. The APIs keep serving, and new work queues as durable jobs.
2. It lists the archive page by page and applies each event in parallel batches, with the same validation and per-event deduplication as the live consumer.
3. Only after a full successful pass does it swap `ANALYTICS#ACTIVE` to the new generation. Then it resumes the worker.

If the replay fails, the previous generation stays active. Notifications still queued for archived events deduplicate against the rebuilt generation.

## Commands

| Command (repository root) | What it does |
| --- | --- |
| `npm run install:all` | `npm ci` in all five packages |
| `npm run build` | `tsc` for the four backend packages |
| `npm run typecheck` | `tsc --noEmit` everywhere; `next typegen && tsc --noEmit` for the frontend |
| `npm start` | Build, bootstrap, seed, start all backend processes |
| `npm run bootstrap` | Build, then bootstrap and seed only |
| `npm run smoke` | Full acceptance run on an isolated `smoke-<id>` prefix (resources removed afterwards; `-- --keep` to inspect) |
| `npm run analytics:replay` | Rebuild the projection from S3 |
| `npm run frontend:dev` / `frontend:build` / `frontend:lint` | Next.js dev server, production build, lint |

Each package also builds with `tsc` and runs with `node` on its own, reading an optional `.env` (see its `.env.example`). Run the bootstrap once first.

## API

All bodies are JSON. Timestamps are UTC ISO 8601, money is integer minor units, and coordinates are `{ "lat", "lng" }` with an optional `label`. Every response carries `X-Request-Id`.

Errors look like `{ "error": { "code", "message", "requestId", "details"? } }`. Status codes: `400` malformed input, `404` unknown resource, `409` state or idempotency conflict, `503` a dependency is temporarily unavailable, `500` an unexpected failure.

### Rides (public)

| Method and path | Notes |
| --- | --- |
| `POST /fare-quotes` | `{ pickup, destination }` → `{ fare: { distanceMeters, amountMinor, currency, baseMinor, distanceMinor, perKmMinor }, estimatedDurationSeconds }` |
| `GET /drivers/nearby?lat=&lng=` | Available cars (positions and ETA only, no identity) and `nearestEtaSeconds`. `503` if Marketplace is down. |
| `POST /rides` + `Idempotency-Key` | `{ riderId, pickup, destination, paymentMethodId }`, where `paymentMethodId` is `card_<brand>_<last4>` (or `demo_approve` / `demo_decline` for deterministic tests). `201` + `Location` when first assigned; `200` on replay; `409 NO_DRIVERS_AVAILABLE` (with `details.rideId`); `503 MARKETPLACE_UNAVAILABLE` (with `details.rideId` and `Location`) when matching will finish in the background. A reused key with a different body returns `409 IDEMPOTENCY_CONFLICT`. |
| `GET /rides/{rideId}` | `200` or `404 RIDE_NOT_FOUND`. Depends only on the Rides table. |
| `POST /rides/{rideId}/complete` | `200` with payment `PENDING`. Repeats return the current ride. |
| `POST /rides/{rideId}/cancel` | `200` (payment `NOT_STARTED`); repeats return the current ride. |
| `POST /rides/{rideId}/payment/retry` + `Idempotency-Key` | `{ paymentMethodId }`; only after a `DECLINED` payment on a completed ride. `202` when scheduled, `200` on replay. Otherwise `409 PAYMENT_PENDING`, `PAYMENT_ALREADY_PAID` or `INVALID_RIDE_STATE`. |
| `GET /analytics/summary` | `completedTrips`, `updatedAt`, plus `cancelledTrips`, `completionRate`, `grossBookingsMinor`, `collectedMinor`, `declinedMinor`, `averageFareMinor`, `averageDistanceMeters`, `averageDurationSeconds`, `paymentsApproved`, `paymentsDeclined`, `approvalRate`, `generation`. |
| `GET /ops/pipeline` | Pending jobs by kind, event queue and DLQ depth, worker state. |
| `GET /api/health` | `200` when the Rides table is usable, else `503`. |

A ride response contains:

- `rideId`, `riderId`, `pickup`, `destination`, `status`;
- `driver`: `{ driverId, name, vehicle, plate, rating }`;
- `fare`, with its breakdown;
- `estimatedDurationSeconds`, `pickupDistanceMeters`, `pickupEtaSeconds`, `tripDurationSeconds`;
- `payment`: `{ status, attemptId, declineCode, method: { brand, last4 }, paidAt?, attempts: [...] }`;
- timestamps: `createdAt`, `updatedAt`, `assignedAt`, `completedAt` and `cancelledAt` where applicable.

Database keys, jobs and raw payment-method IDs are never exposed.

### Internal (localhost only)

- **Marketplace:**
  - `PUT /internal/reservations/{rideId}` `{ pickup }` → `200 RESERVED` with a driver snapshot and `pickupDistanceMeters`, or `409 NO_DRIVERS_AVAILABLE` / `RESERVATION_CLOSED` / `IDEMPOTENCY_CONFLICT`.
  - `DELETE /internal/reservations/{rideId}` → `204`.
  - `GET /internal/drivers/available`, `GET /internal/fleet/stats`, `PUT|DELETE /internal/fleet/simulated`.
- **Payments:** `PUT /internal/payment-attempts/{attemptId}` → `200 { attemptId, rideId, status, amountMinor, currency, declineCode }` or `409 RIDE_ALREADY_PAID`. `GET /internal/payment-attempts/{attemptId}`. The random decision is made once and stored with the attempt, so retries of the same attempt always return it.
- **Load simulator:** `POST /simulations` (bounded inputs; one run at a time), `GET /simulations/current`, `POST /simulations/current/stop`.

### Archived events

| Key | Payload (no rider details, payment methods or coordinates) |
| --- | --- |
| `ride-completed/<rideId>.json` | `RideCompleted` v2: `eventId`, `rideId`, `occurredAt`, `fareAmountMinor`, `currency`, `distanceMeters`, `durationSeconds` (v1 objects are still accepted) |
| `ride-cancelled/<rideId>.json` | `RideCancelled` v1: `eventId`, `rideId`, `occurredAt` |
| `payment-settled/<attemptId>.json` | `PaymentSettled` v1: `eventId`, `attemptId`, `rideId`, `status`, `amountMinor`, `currency`, `declineCode`, `occurredAt` |

## How the guarantees are implemented

- **Booking:** the ride, its idempotency record and a delayed `MATCH` job are written in one transaction. The request then tries Marketplace within 2.5 s; otherwise the worker retries with the same ride ID and pickup. Settlement and job retirement are atomic.
- **Exclusive drivers:** Marketplace claims a driver and inserts the ride-keyed reservation in one conditional transaction. On a conflict it tries the next driver (ranked by distance, then ID). After every candidate fails, it stores a `NO_DRIVER` decision. Release clears the driver only if it still points at the ride.
- **At most one approval per ride:** each attempt is stored under its ID with a request fingerprint. An approval also creates a `PAID#<rideId>` marker in the same transaction.
- **Payment history:** each settlement appends to the ride's attempt history and schedules its `PaymentSettled` event in the same transaction that retires the charge job.
- **Worker:** two independent loops. The job loop queries the `jobs-due` index and runs 16 jobs at a time with capped exponential backoff; each backoff write requires the job to still exist. The SQS loop long-polls and handles messages in parallel. It validates the envelope, bucket, prefix and event body, then applies each event once per generation (deduplication marker plus counter increments in one transaction). Malformed messages go to the DLQ.
- **Isolation:** completion returns as soon as its transaction commits. A down Marketplace or Payments only delays jobs, and Rides health and reads use only the Rides table.

## Acceptance results

`npm run smoke` runs every scenario against the real LocalStack on an isolated prefix:

- bootstrap twice (tables, both indexes, bucket, queues, policy, redrive, notifications, seed);
- approve, with the exact v2 event payload;
- cancel, including the RideCancelled event and concurrent complete-versus-cancel;
- decline and retry, with full payment history;
- idempotency;
- five concurrent bookings for three drivers;
- Marketplace down, Payments down, and worker restart;
- duplicate S3 notifications and DLQ routing;
- fare quotes, nearby cars, card tokens with random outcomes, extended metrics, and the pipeline status endpoint;
- a load simulation, including fleet cleanup and exact counting;
- a replay that rebuilds every metric identically.

It prints one pass/fail line per check and exits non-zero if any check fails.

## Troubleshooting

- **`No verified LocalStack endpoint`:** read the printed discovery steps, then set `LOCALSTACK_ENDPOINT_URL`.
- **Port already in use:** unset the `*_PORT` variable so the launcher picks a free port. It checks both `127.0.0.1` and IPv6, because `localhost` may resolve to `::1`.
- **The app can't reach the backend:** confirm `frontend/.env.local` has the proxy targets printed by `npm start`, then restart or rebuild the frontend.
- **Removing demo data:** delete the resources named `<prefix>-*` in LocalStack (three tables, the `-trip-events` bucket, and the `-trip-events`, `-trip-events-dlq` and `-notify-check` queues).
