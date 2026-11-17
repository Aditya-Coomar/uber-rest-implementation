import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { errorFields, logToStderr, logger, setServiceName } from '../lib/log';
setServiceName('analytics-replay');
logToStderr();
import { resourceNames } from '../config';
import { ALL_EVENT_PREFIXES } from '../analytics/events';
import { discoverEndpoint } from '../aws/endpoint';

// Modules that create AWS clients at import time are loaded after the endpoint is known.
type Deps = typeof import('../analytics/projection') &
  typeof import('../aws/clients') &
  typeof import('../worker/consumer') &
  typeof import('../worker/control');
let deps: Deps;

async function loadDeps(): Promise<void> {
  if (!process.env.LOCALSTACK_ENDPOINT_URL) {
    const discovery = await discoverEndpoint();
    if (!discovery.endpoint) {
      for (const step of discovery.steps) logger.warn('endpoint discovery', { ...step });
      throw new Error('No verified LocalStack endpoint; set LOCALSTACK_ENDPOINT_URL.');
    }
    process.env.LOCALSTACK_ENDPOINT_URL = discovery.endpoint;
    logger.info('using LocalStack', { endpoint: discovery.endpoint, source: discovery.source });
  }
  deps = {
    ...(await import('../analytics/projection')),
    ...(await import('../aws/clients')),
    ...(await import('../worker/consumer')),
    ...(await import('../worker/control')),
  };
}

/**
 * Rebuild the completed-trip projection from the S3 archive into a fresh
 * generation, then swap it in. The worker is paused for the duration so that
 * neither archive publication nor projection writes happen mid-rebuild.
 */
async function pauseWorker(requestId: string): Promise<'paused' | 'not-running'> {
  const { HEARTBEAT_STALE_MS, readHeartbeat, writeControl } = deps;
  await writeControl({ paused: true, requestId, requestedBy: 'analytics-replay', requestedAt: new Date().toISOString() });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const hb = await readHeartbeat();
    if (!hb || Date.now() - Date.parse(hb.heartbeatAt) > HEARTBEAT_STALE_MS) return 'not-running';
    if (hb.state === 'PAUSED' && hb.pausedRequestId === requestId) return 'paused';
    await sleep(500);
  }
  throw new Error('worker did not acknowledge the pause within 60s');
}

async function resumeWorker(): Promise<void> {
  await deps.writeControl({ paused: false, requestId: null, requestedBy: null, requestedAt: null });
}

async function main(): Promise<void> {
  await loadDeps();
  const { applyEvent, createS3Client, ensureActiveGeneration, fetchEvent, getSummary, initGeneration, newGenerationId, swapActiveGeneration } = deps;
  const names = resourceNames();
  const s3 = createS3Client();
  const requestId = randomUUID();

  const workerState = await pauseWorker(requestId);
  logger.info('worker quiesced', { workerState });
  try {
    const previous = await ensureActiveGeneration();
    const generation = newGenerationId();
    await initGeneration(generation);
    logger.info('replaying archive', { bucket: names.bucket, prefixes: ALL_EVENT_PREFIXES, previous, generation });

    let objects = 0;
    let applied = 0;
    let duplicates = 0;
    for (const prefix of ALL_EVENT_PREFIXES) {
    let token: string | undefined;
    do {
      const page = await s3.send(
        new ListObjectsV2Command({ Bucket: names.bucket, Prefix: prefix, ContinuationToken: token, MaxKeys: 500 }),
      );
      const keysOnPage = (page.Contents ?? []).map((o) => o.Key).filter((k): k is string => Boolean(k));
      // Events are independent and deduplicated individually, so apply a page in parallel batches.
      for (let i = 0; i < keysOnPage.length; i += 16) {
        await Promise.all(
          keysOnPage.slice(i, i + 16).map(async (key) => {
            objects += 1;
            const event = await fetchEvent(s3, names.bucket, key); // same validation as the consumer
            if ((await applyEvent(generation, event)) === 'APPLIED') applied += 1;
            else duplicates += 1;
          }),
        );
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    }

    await swapActiveGeneration(previous, generation);
    const summary = await getSummary();
    const result = { ok: true, previousGeneration: previous, objects, applied, duplicates, ...summary, generation };
    logger.info('replay complete', result);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await resumeWorker();
    logger.info('worker resumed');
  }
}

main().catch((err) => {
  logger.error('replay failed; previous projection left active', errorFields(err));
  process.stdout.write(`${JSON.stringify({ ok: false, error: (err as Error).message })}\n`);
  process.exitCode = 1;
});
