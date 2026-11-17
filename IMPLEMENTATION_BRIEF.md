# Ride-booking SOA demo implementation brief

## Objective

Build a local ride-booking demo that shows the service boundaries, REST gateway, failure isolation, and replayable analytics described in the Uber × AWS SOA deck. A rider can book a ride, see the driver and fare, complete or cancel the ride, and retry a simulated declined payment. A completed-trip counter updates asynchronously. This is a simulation with seeded drivers, preset coordinates, and fake payment methods.

Use TypeScript throughout. Implement three separately runnable Express 5 APIs and one TypeScript worker on Node.js. Reuse the existing Next.js starter. Run DynamoDB, S3, and SQS in the user's existing LocalStack instance. Use DynamoDB for all application persistence. The project needs no separately installed database server. Keep fare calculation inside Rides and keep the demo focused on the four components below.

## Repository and delivery order

| Existing directory or component | Responsibility | Completion criterion |
| --- | --- | --- |
| `rides-api/` | Public REST entry point, ride state, fare quote, orchestration, analytics read endpoint | A client can book, retrieve, complete, and cancel a ride without calling an internal API. |
| `marketplace-api/` | Seeded drivers and exclusive reservations | Concurrent requests cannot reserve the same driver for different rides. A terminal ride releases its driver. |
| `payments-api/` | Simulated charges and their durable outcomes | A retried request for the same attempt returns the same result, and at most one attempt per ride is approved. |
| Rides worker entry point in `rides-api/` | Recover interrupted work, publish events to S3, consume SQS notifications, maintain the analytics projection | Restarting the process resumes pending work. Replaying the event archive rebuilds the count. |
| `frontend/` | Next.js rider demo | A browser can book, complete, decline and retry payment, and see the analytics counter update. |

1. Establish the runtime and LocalStack bootstrap. In an isolated demo namespace, verify that DynamoDB can perform a conditional write and a transaction, and that an object-created notification actually reaches the local SQS queue.
2. Implement Marketplace and the Rides booking lifecycle. Exercise concurrent bookings, repeated submissions, and terminal transitions through HTTP before adding payments.
3. Implement Payments and the durable Rides worker operations for driver release and payment. Verify the approved, declined, and unavailable paths.
4. Add S3 publication, SQS consumption, and replay. Verify the counter, duplicate handling, and rebuild using LocalStack.
5. Wire the existing Next.js app, add a root README for setup and the demo, and run the acceptance checks at the end of this brief.

Keep the three existing backend packages, their lockfiles, and the frontend package. Reuse working Express application and server entry points. The backend starters contain sample routes, placeholder metadata, Prisma initialization, and PostgreSQL health checks. Replace the active sample behavior and database wiring with the contracts below. Remove unused scaffold dependencies and environment requirements where they become obsolete. Keep the existing compile-to-JavaScript workflow with `tsc` and `node` unless the repository already provides a working equivalent. Maintain an independently runnable script in each package. Read `frontend/AGENTS.md` and the installed Next.js documentation it points to before editing the frontend.

## Setup, environment, and bootstrap

- Check the repository's Node and npm requirements and the installed versions. Use Node.js 24 for a new local setup. Install existing packages with npm from their lockfiles. Keep runtime dependencies small. Use `express`, `cors` for Rides, native `fetch` for internal HTTP, and AWS SDK for JavaScript v3. Add `@aws-sdk/client-dynamodb` and `@aws-sdk/lib-dynamodb` where used, and add `@aws-sdk/client-s3` and `@aws-sdk/client-sqs` only to the package that runs the worker and bootstrap. Keep TypeScript and the matching Node and Express types as development dependencies.
- Discover the existing LocalStack gateway from an explicit `LOCALSTACK_ENDPOINT_URL` first, then from the running instance or its Docker/Compose configuration. Validate the candidate using `/_localstack/health` and SDK calls before creating resources. If the current shell cannot reach the instance, report which discovery steps succeeded and run the integration check from the environment that hosts LocalStack when available. Use the existing instance and preserve its data.
- Pass the resolved endpoint and region explicitly to every SDK client. Use scoped dummy credentials for LocalStack and `forcePathStyle: true` for S3. Require a verified LocalStack endpoint before resource creation. If SQS advertises a queue URL that the app cannot resolve, configure the client to use the verified gateway for transport while preserving the queue identity returned by LocalStack. Confirm the exact settings against the installed SDK and the existing LocalStack configuration. [LocalStack JavaScript SDK setup](https://docs.localstack.cloud/aws/connecting/aws-sdks/javascript/) · [LocalStack SQS configuration](https://docs.localstack.cloud/aws/services/sqs/)
- Use one configurable resource prefix and one region for the demo. Bootstrap three DynamoDB tables, a dedicated S3 archive bucket, and a standard SQS queue with a dead-letter queue. Wait for resources to be usable before seeding or configuring notifications. Grant S3 `sqs:SendMessage` on the destination queue scoped to the archive bucket ARN and configure object-created notifications for the trip-event prefix. Add a finite SQS redrive policy. The bootstrap may create missing resources and reconcile its own configuration. Repeated runs preserve existing ride data and driver reservations. [S3 notification destinations](https://docs.aws.amazon.com/AmazonS3/latest/userguide/notification-how-to-event-types-and-destinations.html) · [S3 destination permissions](https://docs.aws.amazon.com/AmazonS3/latest/userguide/grant-destinations-permissions-to-s3.html)
- Provide one Windows-friendly command for backend startup after dependency installation. It should validate configuration, run bootstrap, start the three APIs and the worker, and show each process's status. Resolve application addresses from the environment or discover them at startup. Pass `MARKETPLACE_API_BASE_URL` and `PAYMENTS_API_BASE_URL` to the Rides API and worker. Provide the actual Rides URL for the frontend's `NEXT_PUBLIC_API_BASE_URL` and the actual frontend origin for the Rides CORS configuration. Bind the demo locally. Provide an environment example with placeholders and document `npm` scripts for install, build, typecheck, start, smoke test, and analytics replay.

## REST conventions

- Send JSON. Use UTC ISO 8601 timestamps, unique string IDs, and integer minor units for money. Validate incoming bodies and internal response payloads. Coordinates use `{ "lat": number, "lng": number }` with finite latitude and longitude in their geographic ranges. A location can also carry a display `label`.
- Errors use `{ "error": { "code": "ERROR_CODE", "message": "Readable message", "requestId": "...", "details": {} } }`. Include `details` only when it carries useful structured information. Use `400` for malformed request data, `404` for an unknown resource, `409` for state conflicts, and `503` for transient dependency failures. Keep unexpected failures distinguishable from a business outcome.
- Require `Idempotency-Key` on public booking and payment retry. Scope each key to its operation and the rider or ride as applicable. Compare a canonical fingerprint of the validated fields. Return the previously linked resource for a repeated key and equivalent request. A repeated key with different input returns `409 IDEMPOTENCY_CONFLICT`. Enforce a reasonable header length and avoid putting raw keys in logs.
- Preserve the existing `/api/health` route across all three services. It should check the service's own DynamoDB table and return `200` when usable or `503` when it cannot serve requests that need its store. Rides health and `GET /rides/{rideId}` are independent of Marketplace, Payments, S3, and SQS. Propagate or generate a request ID. Log route, outcome, elapsed time, and relevant ride or attempt IDs. Configure explicit browser origins on Rides and allow `Content-Type` and `Idempotency-Key`. Keep internal services reachable only in the local environment.

## Rides API

### Public contract

| Method and path | Request | Result |
| --- | --- | --- |
| `POST /rides` | `{ riderId, pickup, destination, paymentMethodId }` and `Idempotency-Key` | `201` and `Location` when assigned for the first time. `200` with the current ride on successful replay. `409 NO_DRIVERS_AVAILABLE` for a confirmed no-driver outcome. `503 MARKETPLACE_UNAVAILABLE` for an unresolved match, with `details.rideId` and the ride URL in `Location` after intent creation. |
| `GET /rides/{rideId}` | Ride ID | `200` with the current ride or `404 RIDE_NOT_FOUND`. |
| `POST /rides/{rideId}/complete` | Empty body | `200` with the completed ride, including its current payment status. Repeated completion returns the current ride. |
| `POST /rides/{rideId}/cancel` | Empty body | `200` with the cancelled ride. Repeated cancellation returns the current ride. |
| `POST /rides/{rideId}/payment/retry` | `{ paymentMethodId }` and `Idempotency-Key` | `202` with the ride when a new payment attempt is scheduled. An equivalent retry of the same request returns the current ride with `200`. |
| `GET /analytics/summary` | None | `200` with `{ completedTrips, updatedAt }`. For a fresh projection, return zero and `updatedAt: null`. |

Successful ride responses use one representation containing `rideId`, `riderId`, `pickup`, `destination`, `status`, `driver`, `fare`, `payment`, `createdAt`, and `updatedAt`. Include `completedAt` and `cancelledAt` when applicable. `driver` is null until assigned, then holds the display snapshot `{ driverId, name, vehicle }` with three string fields. Keep that snapshot on terminal rides. `fare` is `{ distanceMeters, amountMinor, currency }`. `payment` contains `{ status, attemptId, declineCode }`, with nullable attempt and decline fields when unavailable. Expose neither database keys nor outbox records.

### Booking and lifecycle

- Validate the fake method ID and inputs before creating a ride. Support `demo_approve` and `demo_decline`. Use Haversine distance with rounded meters for the quote. For a deterministic demo, use `USD`, a base fare of 200 minor units, and 150 per kilometer. Calculate `200 + round(distanceMeters * 150 / 1000)` and freeze it at booking.
- Create a `PENDING_MATCH` ride, its idempotency key record, and a `MATCH` job in one DynamoDB transaction. Generate the ride ID once. The first HTTP request attempts Marketplace within a short request deadline while the worker can recover unfinished jobs. Both paths use the same ride ID and validated pickup. A confirmed reservation changes the ride to `ASSIGNED`; a confirmed lack of drivers changes it to `NO_DRIVER`. Settle the ride and retire the match job atomically. Include the ride ID in the no-driver response details and preserve that result for replay. A fresh booking after a no-driver outcome uses a fresh key.
- On a Marketplace timeout or transient error, leave the ride in `PENDING_MATCH` and keep the job. A `503` with the ride ID means the booking may still finish in the background. The browser can fetch that ride or repeat the original request with the same key. A replay arriving while matching is still unresolved returns `503` with the same ride ID. A failed DynamoDB write before intent creation returns a storage-unavailable response with no ride ID. If the result of an intent write is ambiguous, re-read the idempotency record before deciding which response to return.
- The state transitions are `PENDING_MATCH → ASSIGNED | NO_DRIVER` and `ASSIGNED → COMPLETED | CANCELLED`. Completion and cancellation use conditional updates, so only one terminal action wins. An action against an incompatible state returns `409 INVALID_RIDE_STATE`. Public terminal actions become available after assignment.
- Completion commits the ride transition, a `RELEASE_DRIVER` job, the initial `CHARGE` job, and a `PUBLISH_RIDE_COMPLETED` job in one transaction. Set payment status to `PENDING` and record a stable attempt ID in that transaction. Cancellation commits its transition and a release job together and leaves payment status `NOT_STARTED`. Return from both endpoints after the transaction commits. The worker settles each job independently, so delayed driver release or payment cannot delay the response or prevent analytics publication.

### Payment orchestration

Payment status is `NOT_STARTED`, `PENDING`, `PAID`, or `DECLINED`. On a durable approved or declined result, update the ride and retire its charge job together. Condition the update on the matching active attempt ID and `PENDING` status. An unavailable Payments API leaves the ride `COMPLETED` and payment `PENDING`. The worker retries the same attempt ID and frozen fare.

Accept a new payment attempt only for a completed ride with a confirmed `DECLINED` result. Use the selected fake method, the same fare, and a new attempt ID. Conditionally update the ride and create the retry idempotency record and charge job in one transaction. Look up the retry key before checking the current state so a replay works after the original retry succeeds. A fresh request during a pending attempt returns `409 PAYMENT_PENDING`. A fresh request after payment succeeds returns `409 PAYMENT_ALREADY_PAID`. Use `409 INVALID_RIDE_STATE` if the ride is ineligible for any other reason.

## Marketplace API

| Method and path | Request | Behavior |
| --- | --- | --- |
| `PUT /internal/reservations/{rideId}` | `{ pickup: { lat, lng } }` | `200` with `{ rideId, status: "RESERVED", driver: { driverId, name, vehicle } }` after reservation. Return `409 NO_DRIVERS_AVAILABLE` for a confirmed rejection. |
| `DELETE /internal/reservations/{rideId}` | Ride ID | `204` after release. A repeat or an unknown reservation also returns `204`. |

Seed the following deterministic drivers. Store each driver's ID, name, vehicle, coordinates, and current reservation. Insert missing drivers only.

| Driver ID | Name | Vehicle | Latitude | Longitude |
| --- | --- | --- | --- | --- |
| `driver-01` | Asha | Blue hatchback | 12.9720 | 77.5950 |
| `driver-02` | Dev | White sedan | 12.9760 | 77.6000 |
| `driver-03` | Mira | Silver compact | 12.9680 | 77.5900 |

Rank available drivers by pickup distance with driver ID as tie-breaker. Use a paginated scan of the small seeded dataset. Use one transaction to conditionally claim the driver and insert the ride-keyed reservation. Try the next candidate on a genuine claim conflict, or re-read the ride's reservation if another request may have already won for the same ride. After an exhausted candidate pass, persist a `NO_DRIVER` reservation outcome using a conditional insert. A race with a successful reservation must return the stored winner.

An equivalent repeated match returns the saved decision. Reject a changed pickup for the same ride with `409 IDEMPOTENCY_CONFLICT`. Release by conditionally clearing the driver only when it still points to that ride, and mark the reservation `RELEASED` in the same transaction. A delayed match request against a released reservation returns `409 RESERVATION_CLOSED` and cannot acquire a driver again. Keep the driver snapshot in the reservation so a retry refers to the same assignment. Treat release as complete only after Marketplace confirms it.

## Payments API

Expose `PUT /internal/payment-attempts/{attemptId}`. Accept `{ rideId, amountMinor, currency, paymentMethodId }` and return `200` with `{ attemptId, rideId, status, amountMinor, currency, declineCode }`. `status` is `APPROVED` or `DECLINED`. `demo_approve` approves and `demo_decline` declines with `DEMO_DECLINED`. Reject other method IDs with `400 INVALID_PAYMENT_METHOD`. Payment methods are synthetic identifiers. Collect no payment card fields.

Store the request fingerprint and result under the attempt ID. A repeat returns the stored result. A changed payload for the same attempt returns `409 IDEMPOTENCY_CONFLICT`. A decline needs only the conditional attempt insert. An approval needs a transaction that conditionally creates the attempt and a paid marker keyed by ride ID. A different attempt for an already paid ride returns `409 RIDE_ALREADY_PAID` with `details.approvedAttemptId`; Rides can read that durable approval from `GET /internal/payment-attempts/{attemptId}` and reconcile the ride if the result belongs to that ride and agrees with its fare. The lookup returns the same response shape or `404 PAYMENT_ATTEMPT_NOT_FOUND`. Resolve ambiguous writes by looking up the existing attempt or paid marker before retrying.

## DynamoDB storage model

Use one physical table per service with string partition key `pk` and AWS SDK document commands. Use `PAY_PER_REQUEST`. The following keys are the required access patterns. Store normalized domain attributes alongside each key. Keep each service's repositories inside its own package. The Rides worker is part of the Rides domain and uses the Rides table.

| Table owner | Item keys | Contents and reads |
| --- | --- | --- |
| Rides | `RIDE#<rideId>` | Ride state, timestamps, quote, assigned driver snapshot, and current payment attempt. Read directly by ID. |
| Rides | `IDEM#BOOK#<scopeHash>`, `IDEM#PAYMENT_RETRY#<scopeHash>` | Fingerprint and linked ride or attempt ID. Read directly before replaying a request. |
| Rides | `JOB#<kind>#<subjectId>` | Pending operation, stable input, attempts, and next execution time. Key by ride ID for match, release, and event publication, and by attempt ID for charging. |
| Rides | `ANALYTICS#ACTIVE`, `ANALYTICS#<generation>#SUMMARY`, `ANALYTICS#<generation>#EVENT#<eventId>` | Current projection pointer, count, timestamp, and per-event deduplication markers. |
| Marketplace | `DRIVER#<driverId>`, `RESERVATION#<rideId>` | Seeded drivers, current reservations, and durable match decisions. |
| Payments | `ATTEMPT#<attemptId>`, `PAID#<rideId>` | Immutable attempted charge and one approved attempt marker per ride. |

Use consistent direct table reads to classify replays and recover ambiguous writes. Use conditions on the write actions themselves when committing state changes. DynamoDB transactions require each action to target a different item. At demo scale, the worker can perform a bounded paginated scan for due jobs. Process all pages over successive ticks and avoid indexing work until the demo volume calls for it. Pending jobs survive restarts. Retire a job only after its side effect is durable. [LocalStack DynamoDB coverage](https://docs.localstack.cloud/aws/services/dynamodb/) · [DynamoDB transaction actions](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_TransactWriteItems.html)

## Rides worker, event archive, and analytics

Run two independent loops in the same worker process. One handles due jobs with bounded per-operation deadlines and capped retry backoff. The other long-polls SQS. A failure in either loop should be logged and retried without stopping the other loop. Backoff writes must condition on the job still existing. Use the same business identifiers on every retry, because an HTTP call or S3 write can succeed before its caller sees the result. Support graceful shutdown by stopping new polling and letting bounded calls finish.

Publish one event per completed ride under `ride-completed/<rideId>.json`. The immutable payload contains `schemaVersion: 1`, `eventType: "RideCompleted"`, `eventId: "ride-completed:<rideId>"`, `rideId`, and `occurredAt` equal to the stored completion timestamp. A publisher retry writes the same payload to the same object key. Store no rider details, payment method, or coordinates in the analytics event. Retire the publication job after a successful `PutObject`.

On SQS receive, parse the S3 `Records` envelope, decode the object key, validate the expected bucket and prefix, fetch the object, and validate the event body. Recognize S3's `s3:TestEvent` message and acknowledge it. For a validated trip event, use one DynamoDB transaction to conditionally insert its generation-specific deduplication marker and increment that generation's summary. A duplicate with a confirmed marker is a success. Delete the SQS message only after all relevant records are applied or confirmed as duplicates. Retry transient storage failures via queue visibility. Let permanently malformed messages reach the dead-letter queue and log enough context to diagnose them. [S3 event message structure](https://docs.aws.amazon.com/AmazonS3/latest/userguide/notification-content-structure.html)

Provide a replay command that paginates the archive and applies its events to a fresh analytics generation with the same validation and deduplication logic. Stop the worker during the rebuild so both archive publication and projection writes are paused. The APIs may remain running, and new completions will accumulate in the durable job queue. Swap the active generation only after a successful full replay, then restart the worker. Older queue messages will deduplicate against the rebuilt generation. Keep the previous projection intact if replay fails. Return the analytics endpoint's count from the currently active generation.

## Next.js integration

Use the existing App Router project. Build one page with rider ID `demo-rider`, a simulated payment selector, and a booking button. Use `City Center` at `{ lat: 12.9716, lng: 77.5946 }` and `Park Gate` at `{ lat: 12.9810, lng: 77.6060 }` as the default pickup and destination presets. Show the driver, formatted fare, ride status, payment status, and the analytics count. Display Complete and Cancel only for `ASSIGNED` rides and Retry Payment only for `DECLINED` payments on completed rides. Cancellation ends the ride and leaves the counter unchanged.

Put public API calls in one small typed client. Preserve one idempotency key per booking or retry action across double-clicks and transport retries. Generate a new key for a distinct action. Disable controls while a request is running. If booking returns a pending ride ID, display a pending state and poll its public URL. Poll the ride during pending payment and refresh analytics on a short bounded interval while waiting for a completion to appear. Stop polling when the component unmounts. Store the active ride ID locally so a reload can recover it. Show errors where the user can act on them, and keep existing ride details visible when the analytics request fails. Use ordinary form controls and the frontend's existing styling approach.

## Acceptance checks

Use an isolated resource prefix for smoke runs so they can prove counts and reservations without touching existing data. Assert results through HTTP and verify the actual LocalStack event path. Record which commands ran and report any environment blockers explicitly.

| Scenario | Expected result |
| --- | --- |
| Clean bootstrap and bootstrap again | Tables, bucket, queue, notification policy, and seed data exist. The second run preserves data and reservations. |
| Book and pay with `demo_approve` | One ride is assigned with a fixed fare. Completion returns promptly, payment eventually becomes `PAID`, the driver is released, and analytics increases by one. |
| Decline and retry | `demo_decline` produces `COMPLETED` with `DECLINED`; `demo_approve` on retry changes only the payment outcome. The count increases only for the original completion. |
| Cancellation and conflicting actions | Cancellation releases the driver and produces no charge or completion event. Concurrent complete and cancel calls result in one terminal transition. |
| Contended driver and no-driver path | Two different bookings never share an active driver. When all seeded drivers are occupied, the API reports a confirmed no-driver outcome. |
| Idempotency | Same-key booking and payment retry preserve the original ride or attempt. Changed payloads for the same key conflict. Repeated completion leaves one event and one initial attempt. |
| Marketplace unavailable | New booking reports an unresolved match. Existing reads still work. Recovery settles the same ride without holding two reservations. |
| Payments unavailable | Ride completion, release, and analytics proceed. Payment stays pending and settles once on recovery using the original attempt ID. |
| Worker restart and duplicate delivery | Restart resumes queued work. Re-delivering the same S3 notification leaves the counter unchanged. |
| Replay | Rebuilding a fresh projection from S3 restores the expected completed-trip count. Resuming the worker does not double-count queued notifications from the archive. |
| Frontend and package checks | Backend TypeScript checks and builds succeed. Existing frontend lint and build scripts pass. A browser session completes the approve and decline/retry flows using the Rides API. |

Finish with a README that gives the actual setup commands, endpoint-discovery procedure, environment variables, startup and shutdown steps, demo sequence, and replay command. Keep demo data under its own resource prefix so the existing LocalStack instance can continue serving other projects.
