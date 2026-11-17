import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { GetQueueUrlCommand } from '@aws-sdk/client-sqs';
import { errorFields, logger, setServiceName } from './lib/log';
setServiceName('rides-worker');
import { config, resourceNames } from './config';
import { createS3Client, createSqsClient } from './aws/clients';
import { NotificationConsumer } from './worker/consumer';
import { HEARTBEAT_INTERVAL_MS, readControl, writeHeartbeat } from './worker/control';
import { JobRunner } from './worker/jobs';

/**
 * Rides worker: two independent loops (durable jobs, SQS notifications) plus a
 * heartbeat/control loop that lets the analytics replay pause both.
 */
const workerId = `worker_${randomUUID().slice(0, 8)}`;
const names = resourceNames();
const shutdown = new AbortController();
let paused = false;
let pauseRequestId: string | null = null;
const idle = { jobs: false, sqs: false };

async function waitWhilePaused(loop: keyof typeof idle): Promise<void> {
  while (paused && !shutdown.signal.aborted) {
    idle[loop] = true;
    await sleep(500).catch(() => undefined);
  }
  idle[loop] = false;
}

async function jobLoop(runner: JobRunner): Promise<void> {
  while (!shutdown.signal.aborted) {
    await waitWhilePaused('jobs');
    if (shutdown.signal.aborted) break;
    let ran = 0;
    try {
      ran = await runner.tick(() => shutdown.signal.aborted || paused);
    } catch (err) {
      logger.warn('job loop error', errorFields(err));
      await sleep(2_000).catch(() => undefined);
    }
    if (ran === 0) await sleep(500).catch(() => undefined);
  }
}

async function sqsLoop(consumer: NotificationConsumer): Promise<void> {
  while (!shutdown.signal.aborted) {
    await waitWhilePaused('sqs');
    if (shutdown.signal.aborted) break;
    try {
      // Never abort an in-flight long poll on shutdown: the server would still hand
      // messages to the abandoned receive and hide them for the visibility timeout.
      // The poll is bounded (5 s); let it finish and process what it returns.
      await consumer.poll(AbortSignal.timeout(20_000));
    } catch (err) {
      if (shutdown.signal.aborted) break;
      logger.warn('sqs loop error', errorFields(err));
      await sleep(2_000).catch(() => undefined);
    }
  }
}

async function controlLoop(): Promise<void> {
  while (!shutdown.signal.aborted) {
    try {
      const control = await readControl();
      if (control.paused !== paused) logger.info(control.paused ? 'pausing for replay' : 'resuming', { requestId: control.requestId });
      paused = control.paused;
      const quiescent = paused && idle.jobs && idle.sqs;
      pauseRequestId = quiescent ? control.requestId : null;
      await writeHeartbeat({
        workerId,
        state: quiescent ? 'PAUSED' : 'RUNNING',
        pausedRequestId: pauseRequestId,
        heartbeatAt: new Date().toISOString(),
      });
    } catch (err) {
      logger.warn('control loop error', errorFields(err));
    }
    await sleep(paused ? 500 : HEARTBEAT_INTERVAL_MS).catch(() => undefined);
  }
}

async function main(): Promise<void> {
  // Validate configuration up front.
  void config.marketplaceBaseUrl;
  void config.paymentsBaseUrl;

  const s3 = createS3Client();
  const sqs = createSqsClient();
  const queueUrl = process.env.TRIP_EVENTS_QUEUE_URL || (await sqs.send(new GetQueueUrlCommand({ QueueName: names.queue }))).QueueUrl!;

  const runner = new JobRunner(s3, names.bucket, config.workerOperationDeadlineMs);
  const consumer = new NotificationConsumer(sqs, s3, queueUrl, names.bucket);

  logger.info('worker started', { workerId, table: config.tableName, bucket: names.bucket, queueUrl });
  const loops = Promise.all([jobLoop(runner), sqsLoop(consumer), controlLoop()]);

  const stop = (signal: string) => {
    if (shutdown.signal.aborted) return;
    logger.info('worker stopping: no new polling; letting bounded calls finish', { signal });
    shutdown.abort();
    setTimeout(() => process.exit(1), 25_000).unref();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));

  await loops;
  await writeHeartbeat({ workerId, state: 'STOPPED', pausedRequestId: null, heartbeatAt: new Date(0).toISOString() }).catch(() => undefined);
  logger.info('worker stopped', { workerId });
}

main().catch((err) => {
  logger.error('worker failed to start', errorFields(err));
  process.exit(1);
});
