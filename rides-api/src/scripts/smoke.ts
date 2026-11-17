/**
 * End-to-end acceptance run against the real LocalStack.
 *
 * Uses an isolated, throwaway resource prefix (smoke-<timestamp>), runs the
 * bootstrap twice, starts the three APIs and the worker as separate processes,
 * drives every scenario through HTTP, and verifies the S3 -> SQS event path.
 * Resources are deleted afterwards unless --keep is passed.
 *
 *   npm run smoke              (from the repository root, after npm run build)
 *   npm run smoke -- --keep    keep the smoke resources for inspection
 */
import { ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { DeleteTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import {
  DeleteBucketCommand, DeleteObjectsCommand, GetBucketNotificationConfigurationCommand, GetObjectCommand,
  ListObjectsV2Command, PutObjectCommand, S3Client,
} from '@aws-sdk/client-s3';
import {
  DeleteQueueCommand, GetQueueAttributesCommand, GetQueueUrlCommand, SQSClient, SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { discoverEndpoint } from '../aws/endpoint';

// ------------------------------------------------------------------ setup

const KEEP = process.argv.includes('--keep');
const PREFIX = `smoke-${Date.now().toString(36)}`;
const RIDES_DIR = path.resolve(__dirname, '../..');
const REPO = path.resolve(RIDES_DIR, '..');
const CITY_CENTER = { lat: 12.9716, lng: 77.5946, label: 'City Center' };
const PARK_GATE = { lat: 12.981, lng: 77.606, label: 'Park Gate' };

const names = {
  rides: `${PREFIX}-rides`,
  marketplace: `${PREFIX}-marketplace`,
  payments: `${PREFIX}-payments`,
  bucket: `${PREFIX}-trip-events`,
  queue: `${PREFIX}-trip-events`,
  dlq: `${PREFIX}-trip-events-dlq`,
  check: `${PREFIX}-notify-check`,
};

interface Result {
  scenario: string;
  check: string;
  ok: boolean;
  detail?: string;
}
const results: Result[] = [];
let currentScenario = '';

function check(condition: boolean, label: string, detail?: unknown): void {
  results.push({ scenario: currentScenario, check: label, ok: condition, detail: condition ? undefined : JSON.stringify(detail)?.slice(0, 400) });
  process.stdout.write(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${condition ? '' : `  -> ${JSON.stringify(detail)?.slice(0, 400)}`}\n`);
}

function scenario(name: string): void {
  currentScenario = name;
  process.stdout.write(`\n== ${name}\n`);
}

async function waitFor<T>(label: string, fn: () => Promise<T | undefined | null | false>, timeoutMs = 30_000): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value as T;
      last = value;
    } catch (err) {
      last = (err as Error).message;
    }
    await sleep(400);
  }
  check(false, `timed out waiting for: ${label}`, last);
  return null;
}

async function freePort(start: number): Promise<number> {
  const canListen = (port: number, host: string) =>
    new Promise<boolean>((resolve) => {
      const srv = net.createServer();
      srv.once('error', (err: NodeJS.ErrnoException) => resolve(err.code === 'EAFNOSUPPORT' || err.code === 'EADDRNOTAVAIL'));
      srv.listen({ port, host, exclusive: true }, () => srv.close(() => resolve(true)));
    });
  for (let port = start; port < start + 200; port += 1) {
    if ((await canListen(port, '127.0.0.1')) && (await canListen(port, '::'))) return port;
  }
  throw new Error(`no free port from ${start}`);
}

// ------------------------------------------------------------------ processes

interface ServiceDef {
  name: string;
  script: string;
  cwd: string;
  env: Record<string, string>;
  healthUrl?: string;
}

const services = new Map<string, { def: ServiceDef; child: ChildProcess | null }>();
let baseEnv: Record<string, string> = {};

function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', ...baseEnv, ...extra };
}

function runScript(script: string, cwd: string, extraEnv: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], { cwd, env: childEnv(extraEnv), windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function startService(name: string): Promise<void> {
  const entry = services.get(name)!;
  const child = spawn(process.execPath, [entry.def.script], { cwd: entry.def.cwd, env: childEnv(entry.def.env), windowsHide: true });
  entry.child = child;
  const logs: string[] = [];
  child.stdout?.on('data', (d) => logs.push(String(d)));
  child.stderr?.on('data', (d) => {
    logs.push(String(d));
    if (process.env.SMOKE_VERBOSE) process.stderr.write(`[${name}] ${d}`);
  });
  child.on('exit', (code, signal) => {
    if (entry.child === child) entry.child = null;
    if (code && code !== 0 && signal !== 'SIGTERM') process.stderr.write(`[${name}] exited ${code}\n${logs.join('').slice(-2000)}\n`);
  });
  if (entry.def.healthUrl) {
    await waitFor(`${name} healthy`, async () => (await fetch(entry.def.healthUrl!).catch(() => null))?.status === 200, 20_000);
  } else {
    await waitFor(`${name} started`, async () => logs.join('').includes('"worker started"'), 20_000);
  }
}

async function stopService(name: string): Promise<void> {
  const entry = services.get(name)!;
  const child = entry.child;
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), sleep(15_000)]);
  entry.child = null;
}

// ------------------------------------------------------------------ HTTP

let RIDES = '';
let SIM = '';

interface HttpResult {
  status: number;
  json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  headers: Headers;
  ms: number;
}

async function api(method: string, urlPath: string, opts: { body?: unknown; key?: string } = {}): Promise<HttpResult> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.key) headers['Idempotency-Key'] = opts.key;
  const started = Date.now();
  const res = await fetch(`${RIDES}${urlPath}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers, ms: Date.now() - started };
}

let keyCounter = 0;
const newKey = (label: string) => `${label}-${Date.now().toString(36)}-${(keyCounter += 1)}`;

const booking = (paymentMethodId: string, destination = PARK_GATE) => ({
  riderId: 'demo-rider',
  pickup: CITY_CENTER,
  destination,
  paymentMethodId,
});

const book = (paymentMethodId: string, key = newKey('book')) => api('POST', '/rides', { body: booking(paymentMethodId), key });
const getRide = (rideId: string) => api('GET', `/rides/${rideId}`);
const analytics = async () => (await api('GET', '/analytics/summary')).json as { completedTrips: number; updatedAt: string | null };

// ------------------------------------------------------------------ AWS inspection

let doc: DynamoDBDocumentClient;
let ddb: DynamoDBClient;
let s3: S3Client;
let sqs: SQSClient;
let queueUrl = '';
let dlqUrl = '';

async function driverRide(driverId: string): Promise<string | null> {
  const out = await doc.send(new GetCommand({ TableName: names.marketplace, Key: { pk: `DRIVER#${driverId}` }, ConsistentRead: true }));
  return (out.Item?.currentRideId as string | undefined) ?? null;
}

async function busyDrivers(): Promise<Record<string, string>> {
  const busy: Record<string, string> = {};
  for (const id of ['driver-01', 'driver-02', 'driver-03']) {
    const ride = await driverRide(id);
    if (ride) busy[id] = ride;
  }
  return busy;
}

async function scanAll(table: string, filter: string, values: Record<string, unknown>, attrNames?: Record<string, string>): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let key: Record<string, unknown> | undefined;
  do {
    const page = await doc.send(
      new ScanCommand({ TableName: table, FilterExpression: filter, ExpressionAttributeValues: values, ExpressionAttributeNames: attrNames, ExclusiveStartKey: key, ConsistentRead: true }),
    );
    items.push(...(page.Items ?? []));
    key = page.LastEvaluatedKey;
  } while (key);
  return items;
}

const attemptsForRide = (rideId: string) => scanAll(names.payments, 'begins_with(pk, :p) AND rideId = :r', { ':p': 'ATTEMPT#', ':r': rideId });
const jobsForRide = (rideId: string) => scanAll(names.rides, "begins_with(pk, :p) AND #input.rideId = :r", { ":p": "JOB#", ":r": rideId }, { "#input": "input" });

async function eventObject(rideId: string): Promise<string | null> {
  try {
    const out = await s3.send(new GetObjectCommand({ Bucket: names.bucket, Key: `ride-completed/${rideId}.json` }));
    return (await out.Body?.transformToString()) ?? null;
  } catch {
    return null;
  }
}

async function archivedKeys(): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: names.bucket, Prefix: 'ride-completed/', ContinuationToken: token }));
    keys.push(...(page.Contents ?? []).map((o) => o.Key!));
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

async function archivedKeysUnder(prefix: string): Promise<string[]> {
  const out = await s3.send(new ListObjectsV2Command({ Bucket: names.bucket, Prefix: prefix }));
  return (out.Contents ?? []).map((o) => o.Key!);
}

async function queueDepth(url: string): Promise<number> {
  const out = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'] }),
  );
  return Number(out.Attributes?.ApproximateNumberOfMessages ?? 0) + Number(out.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0);
}

async function waitQueueDrained(): Promise<void> {
  await waitFor('event queue drained', async () => (await queueDepth(queueUrl)) === 0, 30_000);
}

async function waitDriversFree(): Promise<void> {
  await waitFor('all drivers released', async () => Object.keys(await busyDrivers()).length === 0, 30_000);
}

async function waitPayment(rideId: string, status: string, timeoutMs = 30_000) {
  return waitFor(`payment ${status} for ${rideId}`, async () => {
    const r = await getRide(rideId);
    return r.json?.payment?.status === status ? r.json : null;
  }, timeoutMs);
}

async function waitCount(expected: number, timeoutMs = 30_000) {
  return waitFor(`analytics completedTrips == ${expected}`, async () => (await analytics()).completedTrips === expected, timeoutMs);
}

// ------------------------------------------------------------------ main

async function main(): Promise<void> {
  process.stdout.write(`Smoke run with isolated prefix ${PREFIX}\n`);
  const discovery = await discoverEndpoint();
  for (const step of discovery.steps) process.stdout.write(`  discovery: ${step.source} ${step.candidate ?? ''} ${step.ok ? 'ok' : 'no'} - ${step.detail}\n`);
  if (!discovery.endpoint) throw new Error('No verified LocalStack endpoint; see discovery steps above.');
  const endpoint = discovery.endpoint;
  const region = process.env.AWS_REGION || 'us-east-1';
  const awsCfg = { endpoint, region, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } };
  ddb = new DynamoDBClient(awsCfg);
  doc = DynamoDBDocumentClient.from(ddb);
  s3 = new S3Client({ ...awsCfg, forcePathStyle: true });
  sqs = new SQSClient({ ...awsCfg, useQueueUrlAsEndpoint: false });

  const ridesPort = await freePort(4300);
  const mPort = await freePort(ridesPort + 1);
  const pPort = await freePort(mPort + 1);
  const simPort = await freePort(pPort + 1);
  SIM = `http://127.0.0.1:${simPort}`;
  RIDES = `http://127.0.0.1:${ridesPort}`;
  baseEnv = {
    LOCALSTACK_ENDPOINT_URL: endpoint,
    AWS_REGION: region,
    DEMO_RESOURCE_PREFIX: PREFIX,
    BIND_HOST: '127.0.0.1',
    MARKETPLACE_API_BASE_URL: `http://127.0.0.1:${mPort}`,
    PAYMENTS_API_BASE_URL: `http://127.0.0.1:${pPort}`,
    CORS_ORIGINS: 'http://localhost:3000',
  };

  try {
    // ---------------------------------------------------------------- bootstrap
    scenario('Clean bootstrap and bootstrap again');
    const boot1 = await runScript('dist/scripts/bootstrap.js', RIDES_DIR);
    const b1 = JSON.parse(boot1.stdout.trim().split('\n').pop() || '{}');
    check(boot1.code === 0 && b1.ok === true, 'first bootstrap succeeded', boot1.stderr.slice(-800));
    check(Object.values(b1.tables ?? {}).every((s) => s === 'created'), 'tables created on clean run', b1.tables);
    check(b1.checks?.dynamoConditionalAndTransaction === true, 'DynamoDB conditional write + transaction verified', b1.checks);
    check(typeof b1.checks?.notificationLatencyMs === 'number', 'S3 object-created notification reached SQS', b1.checks);
    queueUrl = b1.queueUrl;
    dlqUrl = (await sqs.send(new GetQueueUrlCommand({ QueueName: names.dlq }))).QueueUrl!;
    const qAttrs = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['All'] }));
    const redrive = JSON.parse(qAttrs.Attributes?.RedrivePolicy ?? '{}');
    check(String(redrive.maxReceiveCount) === '5' && String(redrive.deadLetterTargetArn).endsWith(names.dlq), 'finite redrive policy to DLQ', redrive);
    const policy = JSON.parse(qAttrs.Attributes?.Policy ?? '{}');
    check(
      policy.Statement?.[0]?.Action === 'sqs:SendMessage' &&
        policy.Statement?.[0]?.Condition?.ArnEquals?.['aws:SourceArn'] === `arn:aws:s3:::${names.bucket}`,
      'queue policy grants S3 SendMessage scoped to the archive bucket',
      policy,
    );
    const notif = await s3.send(new GetBucketNotificationConfigurationCommand({ Bucket: names.bucket }));
    const rule = notif.QueueConfigurations?.find((q) => q.Id === 'ride-completed-to-sqs');
    check(rule?.Filter?.Key?.FilterRules?.some((r) => r.Value === 'ride-completed/') === true, 'object-created notification on ride-completed/ prefix', notif);
    const seed1 = await runScript('dist/scripts/seed.js', path.join(REPO, 'marketplace-api'));
    check(seed1.code === 0 && seed1.stdout.includes('"inserted":["driver-01","driver-02","driver-03"]'), 'three drivers seeded', seed1.stdout + seed1.stderr);

    services.set('marketplace', { def: { name: 'marketplace', script: 'dist/server.js', cwd: path.join(REPO, 'marketplace-api'), env: { PORT: String(mPort) }, healthUrl: `http://127.0.0.1:${mPort}/api/health` }, child: null });
    services.set('payments', { def: { name: 'payments', script: 'dist/server.js', cwd: path.join(REPO, 'payments-api'), env: { PORT: String(pPort) }, healthUrl: `http://127.0.0.1:${pPort}/api/health` }, child: null });
    services.set('rides', { def: { name: 'rides', script: 'dist/server.js', cwd: RIDES_DIR, env: { PORT: String(ridesPort) }, healthUrl: `${RIDES}/api/health` }, child: null });
    services.set('simulator', { def: { name: 'simulator', script: 'dist/server.js', cwd: path.join(REPO, 'load-simulator'), env: { PORT: String(simPort), RIDES_API_BASE_URL: RIDES }, healthUrl: `${SIM}/api/health` }, child: null });
    services.set('worker', { def: { name: 'worker', script: 'dist/worker.js', cwd: RIDES_DIR, env: { TRIP_EVENTS_QUEUE_URL: queueUrl } }, child: null });
    for (const name of ['marketplace', 'payments', 'rides', 'worker', 'simulator']) await startService(name);

    const fresh = await analytics();
    check(fresh.completedTrips === 0 && fresh.updatedAt === null, 'fresh projection returns 0 and updatedAt null', fresh);
    let expectedCount = 0;

    // ---------------------------------------------------------------- approve
    scenario('Book and pay with demo_approve');
    const a = await book('demo_approve');
    check(a.status === 201, 'booking returns 201', a.json);
    check(a.headers.get('location') === `/rides/${a.json?.rideId}`, 'Location header points at the ride', a.headers.get('location'));
    check(a.json?.status === 'ASSIGNED' && a.json?.driver?.driverId === 'driver-01', 'assigned to nearest driver (driver-01)', a.json?.driver);
    check(
      a.json?.fare?.distanceMeters === 1618 && a.json?.fare?.amountMinor === 443 && a.json?.fare?.currency === 'USD',
      'fixed fare: 1618 m -> 443 USD minor units',
      a.json?.fare,
    );
    check(a.json?.payment?.status === 'NOT_STARTED' && a.json?.payment?.attemptId === null, 'payment NOT_STARTED before completion', a.json?.payment);
    const rideA = a.json.rideId as string;
    const aDone = await api('POST', `/rides/${rideA}/complete`);
    check(aDone.status === 200 && aDone.json?.status === 'COMPLETED', 'completion returns 200 COMPLETED', aDone.json);
    check(aDone.ms < 1_000, `completion returns promptly (${aDone.ms} ms)`, aDone.ms);
    check(aDone.json?.payment?.status === 'PENDING' && typeof aDone.json?.payment?.attemptId === 'string', 'completion response has PENDING payment and attempt ID', aDone.json?.payment);
    const aPaid = await waitPayment(rideA, 'PAID');
    check(aPaid?.payment?.attemptId === aDone.json?.payment?.attemptId, 'payment PAID with the initial attempt ID', aPaid?.payment);
    expectedCount += 1;
    await waitCount(expectedCount);
    check((await analytics()).completedTrips === expectedCount, 'analytics increased by one');
    await waitFor('driver-01 released', async () => (await driverRide('driver-01')) === null);
    const body = await eventObject(rideA);
    const durationSeconds = Math.max(0, Math.round((Date.parse(aDone.json.completedAt) - Date.parse(aDone.json.assignedAt)) / 1000));
    check(
      body ===
        JSON.stringify({
          schemaVersion: 2, eventType: 'RideCompleted', eventId: `ride-completed:${rideA}`, rideId: rideA, occurredAt: aDone.json.completedAt,
          fareAmountMinor: 443, currency: 'USD', distanceMeters: 1618, durationSeconds,
        }),
      'archived RideCompleted v2 payload is exact (fare, distance, duration; no rider/payment/location data)',
      body,
    );
    check(
      (await waitFor('payment-settled event archived', async () => (await s3.send(new ListObjectsV2Command({ Bucket: names.bucket, Prefix: 'payment-settled/' }))).KeyCount === 1)) === true,
      'PaymentSettled event archived for the charge',
    );
    check(!/demo-rider|demo_approve|lat|lng/.test(body ?? ''), 'event contains no rider, payment method or coordinates', body);

    // ---------------------------------------------------------------- bootstrap again
    scenario('Bootstrap again preserves data and reservations');
    const b = await book('demo_approve');
    const rideB = b.json?.rideId as string;
    check(b.status === 201 && b.json?.driver?.driverId === 'driver-01', 'ride B holds driver-01', b.json);
    const boot2 = await runScript('dist/scripts/bootstrap.js', RIDES_DIR);
    const b2 = JSON.parse(boot2.stdout.trim().split('\n').pop() || '{}');
    check(boot2.code === 0 && Object.values(b2.tables ?? {}).every((s) => s === 'exists') && b2.bucket?.status === 'exists', 'second bootstrap reports existing resources', b2);
    const seed2 = await runScript('dist/scripts/seed.js', path.join(REPO, 'marketplace-api'));
    check(seed2.stdout.includes('"inserted":[]'), 'second seed inserts nothing', seed2.stdout);
    check((await driverRide('driver-01')) === rideB, 'driver-01 reservation for ride B preserved', await driverRide('driver-01'));
    check((await getRide(rideB)).json?.status === 'ASSIGNED', 'ride B still ASSIGNED');
    check((await getRide(rideA)).json?.payment?.status === 'PAID', 'ride A data preserved');
    check((await analytics()).completedTrips === expectedCount, 'analytics preserved by re-bootstrap');

    // ---------------------------------------------------------------- cancel
    scenario('Cancellation and conflicting actions');
    const cancelB = await api('POST', `/rides/${rideB}/cancel`);
    check(cancelB.status === 200 && cancelB.json?.status === 'CANCELLED' && typeof cancelB.json?.cancelledAt === 'string', 'cancel returns 200 CANCELLED', cancelB.json);
    check(cancelB.json?.payment?.status === 'NOT_STARTED', 'cancelled ride payment stays NOT_STARTED', cancelB.json?.payment);
    check(cancelB.json?.driver?.driverId === 'driver-01', 'driver snapshot kept on terminal ride', cancelB.json?.driver);
    check((await api('POST', `/rides/${rideB}/cancel`)).status === 200, 'repeated cancel returns 200');
    const completeCancelled = await api('POST', `/rides/${rideB}/complete`);
    check(completeCancelled.status === 409 && completeCancelled.json?.error?.code === 'INVALID_RIDE_STATE', 'complete after cancel -> 409 INVALID_RIDE_STATE', completeCancelled.json);
    await waitFor('driver-01 released after cancel', async () => (await driverRide('driver-01')) === null);

    const e = await book('demo_approve');
    const rideE = e.json?.rideId as string;
    const [c1, c2] = await Promise.all([api('POST', `/rides/${rideE}/complete`), api('POST', `/rides/${rideE}/cancel`)]);
    const winners = [c1, c2].filter((r) => r.status === 200);
    const losers = [c1, c2].filter((r) => r.status === 409 && r.json?.error?.code === 'INVALID_RIDE_STATE');
    check(winners.length === 1 && losers.length === 1, 'concurrent complete + cancel: exactly one terminal transition wins', [c1.status, c2.status, c1.json?.error, c2.json?.error]);
    const finalE = (await getRide(rideE)).json;
    check(finalE?.status === winners[0]?.json?.status, `ride E final state matches the winner (${finalE?.status})`, finalE?.status);
    if (finalE?.status === 'COMPLETED') {
      expectedCount += 1;
      await waitPayment(rideE, 'PAID');
    }
    await waitDriversFree();
    await waitQueueDrained();
    await sleep(1_500);
    check(await eventObject(rideB) === null, 'cancelled ride B produced no completion event');
    check((await archivedKeysUnder('ride-cancelled/')).includes(`ride-cancelled/${rideB}.json`), 'cancelled ride B produced a RideCancelled event');
    check((await attemptsForRide(rideB)).length === 0, 'cancelled ride B produced no charge');
    check((await jobsForRide(rideB)).length === 0, 'no jobs left for ride B');
    check((await analytics()).completedTrips === expectedCount, 'cancellation left the counter unchanged', await analytics());

    // ---------------------------------------------------------------- decline/retry
    scenario('Decline and retry');
    const c = await book('demo_decline');
    const rideC = c.json?.rideId as string;
    const cDone = await api('POST', `/rides/${rideC}/complete`);
    const firstAttempt = cDone.json?.payment?.attemptId;
    const declined = await waitPayment(rideC, 'DECLINED');
    check(declined?.status === 'COMPLETED' && declined?.payment?.declineCode === 'DEMO_DECLINED', 'demo_decline -> COMPLETED + DECLINED (DEMO_DECLINED)', declined?.payment);
    expectedCount += 1;
    await waitCount(expectedCount);
    const retryKey = newKey('retry');
    const r1 = await api('POST', `/rides/${rideC}/payment/retry`, { body: { paymentMethodId: 'demo_approve' }, key: retryKey });
    check(r1.status === 202 && r1.json?.payment?.status === 'PENDING', 'retry accepted with 202 and PENDING', r1.json);
    check(r1.json?.payment?.attemptId && r1.json.payment.attemptId !== firstAttempt, 'retry uses a new attempt ID', [firstAttempt, r1.json?.payment]);
    const r1again = await api('POST', `/rides/${rideC}/payment/retry`, { body: { paymentMethodId: 'demo_approve' }, key: retryKey });
    check(r1again.status === 200 && r1again.json?.payment?.attemptId === r1.json?.payment?.attemptId, 'same-key retry returns 200 with the same attempt', r1again.json?.payment);
    const r1conflict = await api('POST', `/rides/${rideC}/payment/retry`, { body: { paymentMethodId: 'demo_decline' }, key: retryKey });
    check(r1conflict.status === 409 && r1conflict.json?.error?.code === 'IDEMPOTENCY_CONFLICT', 'same key, different method -> 409 IDEMPOTENCY_CONFLICT', r1conflict.json);
    const cPaid = await waitPayment(rideC, 'PAID');
    check(
      cPaid?.status === 'COMPLETED' && cPaid?.completedAt === cDone.json?.completedAt && cPaid?.fare?.amountMinor === c.json?.fare?.amountMinor &&
        cPaid?.payment?.attemptId === r1.json?.payment?.attemptId,
      'retry changed only the payment outcome',
      cPaid,
    );
    const replayAfterPaid = await api('POST', `/rides/${rideC}/payment/retry`, { body: { paymentMethodId: 'demo_approve' }, key: retryKey });
    check(replayAfterPaid.status === 200 && replayAfterPaid.json?.payment?.status === 'PAID', 'retry replay after success still returns 200', replayAfterPaid.json?.payment);
    const freshRetry = await api('POST', `/rides/${rideC}/payment/retry`, { body: { paymentMethodId: 'demo_approve' }, key: newKey('retry') });
    check(freshRetry.status === 409 && freshRetry.json?.error?.code === 'PAYMENT_ALREADY_PAID', 'fresh retry after success -> 409 PAYMENT_ALREADY_PAID', freshRetry.json);
    check(
      cPaid?.payment?.attempts?.map((a: { status: string }) => a.status).join(',') === 'DECLINED,PAID',
      'ride keeps its full payment history (declined, then paid)',
      cPaid?.payment?.attempts,
    );
    const attemptsC = await attemptsForRide(rideC);
    check(attemptsC.length === 2 && attemptsC.filter((x) => x.status === 'APPROVED').length === 1, 'two attempts recorded, exactly one approved', attemptsC.map((x) => x.status));
    await sleep(1_500);
    check((await analytics()).completedTrips === expectedCount, 'retry did not increase the counter');

    // ---------------------------------------------------------------- idempotency
    scenario('Idempotency');
    const dKey = newKey('book');
    const d1 = await api('POST', '/rides', { body: booking('demo_approve'), key: dKey });
    const d2 = await api('POST', '/rides', { body: booking('demo_approve'), key: dKey });
    check(d1.status === 201 && d2.status === 200 && d1.json?.rideId === d2.json?.rideId, 'same-key booking returns the original ride (201 then 200)', [d1.status, d2.status]);
    const d3 = await api('POST', '/rides', { body: booking('demo_approve', { lat: 12.99, lng: 77.61, label: 'Elsewhere' }), key: dKey });
    check(d3.status === 409 && d3.json?.error?.code === 'IDEMPOTENCY_CONFLICT', 'same key, changed payload -> 409 IDEMPOTENCY_CONFLICT', d3.json);
    const otherRider = await api('POST', '/rides', { body: { ...booking('demo_approve'), riderId: 'other-rider' }, key: dKey });
    check(otherRider.status !== 409 || otherRider.json?.error?.code !== 'IDEMPOTENCY_CONFLICT', 'keys are scoped per rider', otherRider.json);
    if (otherRider.status === 201) await api('POST', `/rides/${otherRider.json.rideId}/cancel`);
    const rideD = d1.json?.rideId as string;
    const [dc1, dc2] = await Promise.all([api('POST', `/rides/${rideD}/complete`), api('POST', `/rides/${rideD}/complete`)]);
    check(dc1.status === 200 && dc2.status === 200, 'concurrent repeated completion both return 200', [dc1.status, dc2.status]);
    const dc3 = await api('POST', `/rides/${rideD}/complete`);
    check(
      dc1.json?.payment?.attemptId === dc2.json?.payment?.attemptId && dc3.json?.payment?.attemptId === dc1.json?.payment?.attemptId,
      'repeated completion keeps one initial attempt ID',
      [dc1.json?.payment, dc2.json?.payment, dc3.json?.payment],
    );
    expectedCount += 1;
    await waitPayment(rideD, 'PAID');
    await waitCount(expectedCount);
    check((await attemptsForRide(rideD)).length === 1, 'exactly one payment attempt for the ride', (await attemptsForRide(rideD)).length);
    check((await archivedKeys()).filter((k) => k.includes(rideD)).length === 1, 'exactly one archived completion event');
    const noKey = await api('POST', '/rides', { body: booking('demo_approve') });
    check(noKey.status === 400 && noKey.json?.error?.code === 'IDEMPOTENCY_KEY_REQUIRED', 'missing Idempotency-Key -> 400', noKey.json);
    const longKey = await api('POST', '/rides', { body: booking('demo_approve'), key: 'k'.repeat(200) });
    check(longKey.status === 400 && longKey.json?.error?.code === 'INVALID_IDEMPOTENCY_KEY', 'over-long Idempotency-Key -> 400', longKey.json);

    // ---------------------------------------------------------------- contention
    scenario('Contended drivers and no-driver path');
    await waitDriversFree();
    const contenders = await Promise.all(Array.from({ length: 5 }, () => book('demo_approve')));
    const assigned = contenders.filter((r) => r.status === 201);
    const rejected = contenders.filter((r) => r.status === 409 && r.json?.error?.code === 'NO_DRIVERS_AVAILABLE');
    const driverIds = assigned.map((r) => r.json?.driver?.driverId);
    check(assigned.length === 3 && new Set(driverIds).size === 3, 'five concurrent bookings: three assigned to distinct drivers', driverIds);
    check(rejected.length === 2 && rejected.every((r) => typeof r.json?.error?.details?.rideId === 'string'), 'two confirmed NO_DRIVERS_AVAILABLE with rideId', rejected.map((r) => r.json));
    const busy = await busyDrivers();
    check(Object.keys(busy).length === 3 && new Set(Object.values(busy)).size === 3, 'each busy driver holds a different ride', busy);
    const noDriverKey = newKey('nodriver');
    const nd1 = await api('POST', '/rides', { body: booking('demo_approve'), key: noDriverKey });
    const nd2 = await api('POST', '/rides', { body: booking('demo_approve'), key: noDriverKey });
    check(
      nd1.status === 409 && nd2.status === 409 && nd1.json?.error?.details?.rideId === nd2.json?.error?.details?.rideId,
      'no-driver result is preserved for replay with the same ride ID',
      [nd1.json, nd2.json],
    );
    check((await getRide(nd1.json?.error?.details?.rideId)).json?.status === 'NO_DRIVER', 'no-driver ride readable with status NO_DRIVER');
    for (const r of assigned) await api('POST', `/rides/${r.json.rideId}/cancel`);
    await waitDriversFree();

    // ---------------------------------------------------------------- marketplace down
    scenario('Marketplace unavailable');
    await stopService('marketplace');
    const fKey = newKey('book');
    const f1 = await api('POST', '/rides', { body: booking('demo_approve'), key: fKey });
    const rideF = f1.json?.error?.details?.rideId as string;
    check(f1.status === 503 && f1.json?.error?.code === 'MARKETPLACE_UNAVAILABLE' && typeof rideF === 'string', '503 MARKETPLACE_UNAVAILABLE with details.rideId', f1.json);
    check(f1.headers.get('location') === `/rides/${rideF}`, 'Location header for the pending ride', f1.headers.get('location'));
    check(f1.ms < 5_000, `unresolved booking answered within the request deadline (${f1.ms} ms)`, f1.ms);
    const fGet = await getRide(rideF);
    check(fGet.status === 200 && fGet.json?.status === 'PENDING_MATCH' && fGet.json?.driver === null, 'pending ride readable as PENDING_MATCH', fGet.json);
    check((await api('GET', '/api/health')).status === 200, 'rides health stays 200 without Marketplace');
    check((await getRide(rideA)).status === 200, 'existing rides still readable');
    const f2 = await api('POST', '/rides', { body: booking('demo_approve'), key: fKey });
    check(f2.status === 503 && f2.json?.error?.details?.rideId === rideF, 'replay while unresolved -> 503 with the same ride ID', f2.json);
    await startService('marketplace');
    const fAssigned = await waitFor('worker settles the pending match', async () => {
      const r = await getRide(rideF);
      return r.json?.status === 'ASSIGNED' ? r.json : null;
    }, 60_000);
    check(fAssigned?.status === 'ASSIGNED', 'recovery assigned the same ride', fAssigned?.status);
    const f3 = await api('POST', '/rides', { body: booking('demo_approve'), key: fKey });
    check(f3.status === 200 && f3.json?.rideId === rideF, 'replay after recovery -> 200 with the same ride', f3.json?.rideId);
    const heldF = Object.entries(await busyDrivers()).filter(([, ride]) => ride === rideF);
    check(heldF.length === 1, 'the recovered ride holds exactly one reservation', heldF);
    check((await jobsForRide(rideF)).length === 0, 'match job retired after settlement');
    await api('POST', `/rides/${rideF}/cancel`);
    await waitDriversFree();

    // ---------------------------------------------------------------- payments down
    scenario('Payments unavailable');
    await stopService('payments');
    const g = await book('demo_approve');
    const rideG = g.json?.rideId as string;
    const gDone = await api('POST', `/rides/${rideG}/complete`);
    check(gDone.status === 200 && gDone.ms < 1_000, `completion succeeds promptly without Payments (${gDone.ms} ms)`, gDone.json);
    const gAttempt = gDone.json?.payment?.attemptId;
    expectedCount += 1;
    await waitFor('driver released without Payments', async () => Object.values(await busyDrivers()).every((r) => r !== rideG));
    await waitCount(expectedCount);
    check((await analytics()).completedTrips === expectedCount, 'analytics proceeds without Payments');
    await sleep(2_000);
    const gPending = (await getRide(rideG)).json;
    check(gPending?.status === 'COMPLETED' && gPending?.payment?.status === 'PENDING', 'payment stays PENDING while Payments is down', gPending?.payment);
    await startService('payments');
    const gPaid = await waitPayment(rideG, 'PAID', 60_000);
    check(gPaid?.payment?.attemptId === gAttempt, 'payment settles on recovery with the original attempt ID', [gAttempt, gPaid?.payment]);
    check((await attemptsForRide(rideG)).length === 1, 'settled exactly once (one attempt stored)');

    // ---------------------------------------------------------------- worker restart
    scenario('Worker restart and duplicate delivery');
    await stopService('worker');
    const h = await book('demo_approve');
    const rideH = h.json?.rideId as string;
    check(h.status === 201, 'booking works while the worker is stopped', h.json);
    const hDone = await api('POST', `/rides/${rideH}/complete`);
    check(hDone.status === 200, 'completion works while the worker is stopped');
    await sleep(2_500);
    check((await jobsForRide(rideH)).length === 3, 'three durable jobs queued (release, charge, publish)', (await jobsForRide(rideH)).map((j) => j.kind));
    check((await getRide(rideH)).json?.payment?.status === 'PENDING', 'payment pending while worker stopped');
    check((await analytics()).completedTrips === expectedCount, 'counter unchanged while worker stopped');
    await startService('worker');
    expectedCount += 1;
    await waitPayment(rideH, 'PAID');
    await waitCount(expectedCount);
    await waitFor('jobs for ride H retired', async () => (await jobsForRide(rideH)).length === 0);
    check((await analytics()).completedTrips === expectedCount, 'restart resumed queued work exactly once');

    await waitQueueDrained();
    const aEvent = (await eventObject(rideA))!;
    await s3.send(new PutObjectCommand({ Bucket: names.bucket, Key: `ride-completed/${rideA}.json`, Body: aEvent, ContentType: 'application/json' }));
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify({
          Records: [
            {
              eventVersion: '2.1', eventSource: 'aws:s3', awsRegion: region, eventTime: new Date().toISOString(), eventName: 'ObjectCreated:Put',
              s3: { s3SchemaVersion: '1.0', configurationId: 'ride-completed-to-sqs', bucket: { name: names.bucket, arn: `arn:aws:s3:::${names.bucket}` }, object: { key: `ride-completed/${rideA}.json` } },
            },
          ],
        }),
      }),
    );
    await sleep(1_000);
    await waitQueueDrained();
    await sleep(1_000);
    check((await analytics()).completedTrips === expectedCount, 're-delivered notifications (S3 re-put + duplicate message) leave the counter unchanged', await analytics());
    await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: '{"Records":[{"eventSource":"aws:s3","eventName":"ObjectCreated:Put","s3":{"bucket":{"name":"someone-else"},"object":{"key":"x"}}}]}' }));
    await waitFor('malformed message moved to the DLQ', async () => (await queueDepth(dlqUrl)) >= 1, 45_000);
    check((await queueDepth(dlqUrl)) >= 1, 'malformed message reached the dead-letter queue');
    check((await analytics()).completedTrips === expectedCount, 'malformed message did not change the counter');

    // ---------------------------------------------------------------- new features
    scenario('Fare quotes, nearby cars, cards, metrics and load simulation');
    const q = await api('POST', '/fare-quotes', { body: { pickup: CITY_CENTER, destination: PARK_GATE } });
    check(q.status === 200 && q.json?.fare?.amountMinor === 443 && q.json?.fare?.baseMinor === 200 && q.json?.fare?.distanceMinor === 243 && q.json?.estimatedDurationSeconds > 0, 'upfront fare quote with breakdown', q.json);
    const near = await api('GET', `/drivers/nearby?lat=${CITY_CENTER.lat}&lng=${CITY_CENTER.lng}`);
    check(near.status === 200 && near.json?.drivers?.length === 3 && near.json?.drivers?.every((d: Record<string, unknown>) => !('name' in d) && !('driverId' in d)), 'nearby cars: positions only, no driver identity', near.json);
    const badCard = await api('POST', '/rides', { body: booking('card_visa_12'), key: newKey('bad') });
    check(badCard.status === 400 && badCard.json?.error?.code === 'INVALID_PAYMENT_METHOD', 'malformed card token rejected', badCard.json);
    const cardRide = await book('card_mastercard_4444');
    check(cardRide.status === 201 && cardRide.json?.payment?.method?.brand === 'mastercard' && cardRide.json?.payment?.method?.last4 === '4444', 'card token accepted; only brand and last 4 exposed', cardRide.json?.payment);
    check(cardRide.json?.driver?.plate && typeof cardRide.json?.driver?.rating === 'number' && cardRide.json?.pickupEtaSeconds >= 60, 'driver plate, rating and pickup ETA included', cardRide.json?.driver);
    await api('POST', `/rides/${cardRide.json?.rideId}/complete`);
    expectedCount += 1;
    const settled = await waitFor('random card outcome settled', async () => {
      const r = await getRide(cardRide.json?.rideId);
      return r.json?.payment?.status !== 'PENDING' ? r.json : null;
    });
    check(['PAID', 'DECLINED'].includes(settled?.payment?.status) && settled?.payment?.attempts?.length === 1, `random bank decision recorded once (${settled?.payment?.status})`, settled?.payment);
    await waitCount(expectedCount);
    const metrics = (await api('GET', '/analytics/summary')).json;
    check(metrics.cancelledTrips >= 1 && metrics.collectedMinor > 0 && metrics.paymentsDeclined >= 1 && typeof metrics.approvalRate === 'number' && metrics.averageFareMinor > 0, 'extended analytics metrics populated from events', metrics);
    const ops = await api('GET', '/ops/pipeline');
    check(ops.status === 200 && typeof ops.json?.jobs?.total === 'number' && ops.json?.eventQueue !== null && ops.json?.worker?.state === 'RUNNING', 'pipeline status endpoint', ops.json);
    check(b1.indexes?.['jobs-due'] === 'created' && b1.indexes?.drivers === 'created', 'job and driver indexes created by bootstrap', b1.indexes);

    const sim = await fetch(`${SIM}/simulations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ratePerSecond: 4, durationSeconds: 6, fleetSize: 12, cancelRate: 0.2, tripSeconds: 1, retryDeclined: true }) });
    check(sim.status === 202, 'load simulation accepted');
    const busySim = await fetch(`${SIM}/simulations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    check(busySim.status === 409, 'only one simulation at a time');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const simDone = await waitFor<any>('simulation finished', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r: any = await (await fetch(`${SIM}/simulations/current`)).json();
      return r.status === 'finished' && r.fleet?.cleanup ? r : null;
    }, 120_000);
    check(simDone?.totals?.requested >= 20 && simDone?.totals?.assigned + simDone?.totals?.noDriver === simDone?.totals?.requested, 'simulated riders were all answered', simDone?.totals);
    check(simDone?.fleet?.setup?.inserted === 12 && simDone?.fleet?.cleanup?.removed === 12, 'simulated fleet added and removed', simDone?.fleet);
    expectedCount += simDone?.totals?.completed ?? 0;
    await waitCount(expectedCount, 60_000);
    check((await analytics()).completedTrips === expectedCount, 'every simulated completion counted exactly once');
    await waitDriversFree();

    // ---------------------------------------------------------------- replay
    scenario('Replay');
    const archived = await archivedKeys();
    check(archived.length === expectedCount, `archive holds one object per completed ride (${archived.length})`, archived.length);
    await waitQueueDrained();
    const summaryBeforeReplay = (await api('GET', '/analytics/summary')).json;
    const replay = await runScript('dist/scripts/replay.js', RIDES_DIR);
    const rep = JSON.parse(replay.stdout.trim().split('\n').pop() || '{}');
    check(replay.code === 0 && rep.ok === true, 'replay succeeded (worker paused and resumed)', replay.stderr.slice(-800));
    const allArchived = (await archivedKeysUnder('ride-completed/')).length + (await archivedKeysUnder('ride-cancelled/')).length + (await archivedKeysUnder('payment-settled/')).length;
    check(rep.previousGeneration !== rep.generation && rep.applied === allArchived && rep.completedTrips === expectedCount, 'fresh generation rebuilt from every archived event', rep);
    const beforeReplay = summaryBeforeReplay;
    check(
      rep.cancelledTrips === beforeReplay?.cancelledTrips && rep.collectedMinor === beforeReplay?.collectedMinor && rep.paymentsDeclined === beforeReplay?.paymentsDeclined,
      'replay rebuilt every metric (cancellations, revenue, declines) identically',
      { rep, beforeReplay },
    );
    check((await analytics()).completedTrips === expectedCount, 'rebuilt count matches the expected completed trips', await analytics());
    await s3.send(new PutObjectCommand({ Bucket: names.bucket, Key: `ride-completed/${rideA}.json`, Body: aEvent, ContentType: 'application/json' }));
    await sleep(1_000);
    await waitQueueDrained();
    await sleep(1_000);
    check((await analytics()).completedTrips === expectedCount, 'queued archive notification deduplicates against the rebuilt generation');
    const i = await book('demo_approve');
    await api('POST', `/rides/${i.json?.rideId}/complete`);
    expectedCount += 1;
    await waitCount(expectedCount);
    check((await analytics()).completedTrips === expectedCount, 'worker resumed: new completion counted once in the new generation');
  } finally {
    for (const name of ['simulator', 'worker', 'rides', 'payments', 'marketplace']) if (services.has(name)) await stopService(name);
    if (!KEEP) await cleanup();
    else process.stdout.write(`\nKept resources under prefix ${PREFIX}\n`);
  }
}

async function cleanup(): Promise<void> {
  for (const t of [names.rides, names.marketplace, names.payments]) await ddb.send(new DeleteTableCommand({ TableName: t })).catch(() => undefined);
  try {
    let token: string | undefined;
    do {
      const page = await s3.send(new ListObjectsV2Command({ Bucket: names.bucket, ContinuationToken: token }));
      const objects = (page.Contents ?? []).map((o) => ({ Key: o.Key! }));
      if (objects.length) await s3.send(new DeleteObjectsCommand({ Bucket: names.bucket, Delete: { Objects: objects } }));
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    await s3.send(new DeleteBucketCommand({ Bucket: names.bucket }));
  } catch {
    /* already gone */
  }
  for (const q of [names.queue, names.dlq, names.check]) {
    try {
      const url = (await sqs.send(new GetQueueUrlCommand({ QueueName: q }))).QueueUrl!;
      await sqs.send(new DeleteQueueCommand({ QueueUrl: url }));
    } catch {
      /* already gone */
    }
  }
  process.stdout.write(`\nRemoved smoke resources under prefix ${PREFIX}\n`);
}

main()
  .catch((err) => {
    check(false, 'smoke run aborted', (err as Error).stack);
  })
  .finally(() => {
    const failed = results.filter((r) => !r.ok);
    process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
    for (const f of failed) process.stdout.write(`  FAILED [${f.scenario}] ${f.check} ${f.detail ?? ''}\n`);
    process.exit(failed.length ? 1 : 0);
  });
