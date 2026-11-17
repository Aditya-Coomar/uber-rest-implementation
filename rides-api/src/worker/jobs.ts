import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { errorFields, logger } from '../lib/log';
import { TripEvent, buildCancelled, buildCompleted, buildPaymentSettled, keyForEvent, serializeEvent } from '../analytics/events';
import type {
  ChargeJobInput, JobRecord, MatchJobInput, PublishCancelledInput, PublishCompletedInput, PublishPaymentInput, ReleaseJobInput,
} from '../domain/types';
import { charge, getAttempt } from '../clients/payments';
import { releaseDriver } from '../clients/marketplace';
import { attemptMatch } from '../services/matching';
import { backoffJob, deleteJob, getRide, queryDueJobs, scanDueJobs, settleCharge } from '../store/rides-repo';

type JobOutcome = { done: true } | { done: false; reason: string };
const DONE: JobOutcome = { done: true };
const retry = (reason: string): JobOutcome => ({ done: false, reason });

const MAX_BACKOFF_MS = 30_000;
const DUE_PER_SHARD = 100;
const CONCURRENCY = 16;
const LEGACY_SWEEP_EVERY_MS = 5 * 60_000;

export function backoffDelay(attempts: number): number {
  const base = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** Math.min(attempts, 5));
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

/** Run `fn` over `items` with at most `limit` in flight. */
async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>, shouldStop: () => boolean): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length && !shouldStop()) {
      const item = items[next];
      next += 1;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/**
 * Durable job execution. Each handler reuses the job's stable identifiers, so a
 * repeat after an unseen success is harmless, and retires the job only after
 * its side effect is durable.
 */
export class JobRunner {
  private lastLegacySweep = 0;

  constructor(
    private readonly s3: S3Client,
    private readonly bucket: string,
    private readonly deadlineMs: number,
  ) {}

  /** Process one bounded batch of due jobs. Returns how many ran. */
  async tick(shouldStop: () => boolean): Promise<number> {
    const now = new Date().toISOString();
    let jobs = await queryDueJobs(now, DUE_PER_SHARD);
    if (Date.now() - this.lastLegacySweep > LEGACY_SWEEP_EVERY_MS) {
      // Jobs written before the index existed are only reachable by a scan.
      this.lastLegacySweep = Date.now();
      let cursor: Record<string, unknown> | undefined;
      do {
        const page = await scanDueJobs(cursor, now, 500);
        jobs = jobs.concat(page.jobs);
        cursor = page.cursor;
      } while (cursor && !shouldStop());
    }
    // The index is eventually consistent; drop accidental duplicates within the batch.
    const unique = [...new Map(jobs.map((j) => [j.pk, j])).values()];
    await pool(unique, CONCURRENCY, (job) => this.run(job), shouldStop);
    return unique.length;
  }

  private async run(job: JobRecord): Promise<void> {
    const started = Date.now();
    let outcome: JobOutcome;
    try {
      outcome = await this.handle(job);
    } catch (err) {
      const fields = errorFields(err);
      outcome = retry(String(fields.errorMessage ?? 'error'));
    }
    const elapsedMs = Date.now() - started;
    if (outcome.done) {
      logger.info('job done', { job: job.pk, kind: job.kind, attempts: job.attempts, elapsedMs });
      return;
    }
    const delay = backoffDelay(job.attempts);
    logger.warn('job retry scheduled', { job: job.pk, kind: job.kind, attempts: job.attempts + 1, delayMs: delay, reason: outcome.reason, elapsedMs });
    try {
      await backoffJob(job, delay, outcome.reason);
    } catch (err) {
      logger.warn('job backoff write failed', { job: job.pk, ...errorFields(err) });
    }
  }

  private handle(job: JobRecord): Promise<JobOutcome> {
    switch (job.kind) {
      case 'MATCH':
        return this.match(job, job.input as MatchJobInput);
      case 'RELEASE_DRIVER':
        return this.release(job, job.input as ReleaseJobInput);
      case 'CHARGE':
        return this.charge(job, job.input as ChargeJobInput);
      case 'PUBLISH_RIDE_COMPLETED':
        return this.publish(job, buildCompleted(job.input as PublishCompletedInput));
      case 'PUBLISH_RIDE_CANCELLED': {
        const input = job.input as PublishCancelledInput;
        return this.publish(job, buildCancelled(input.rideId, input.occurredAt));
      }
      case 'PUBLISH_PAYMENT_SETTLED':
        return this.publish(job, buildPaymentSettled(job.input as PublishPaymentInput));
      default:
        logger.error('unknown job kind', { job: job.pk });
        return Promise.resolve(retry('unknown job kind'));
    }
  }

  private async match(job: JobRecord, input: MatchJobInput): Promise<JobOutcome> {
    const ride = await getRide(input.rideId);
    if (!ride || ride.status !== 'PENDING_MATCH') {
      await deleteJob(job.pk);
      return DONE;
    }
    const result = await attemptMatch(ride, this.deadlineMs);
    return 'ride' in result ? DONE : retry(`marketplace: ${result.unresolved}`);
  }

  private async release(job: JobRecord, input: ReleaseJobInput): Promise<JobOutcome> {
    const result = await releaseDriver(input.rideId, this.deadlineMs);
    if (!result.ok) return retry(`marketplace: ${result.reason}`);
    await deleteJob(job.pk);
    logger.info('driver released', { rideId: input.rideId });
    return DONE;
  }

  private async charge(job: JobRecord, input: ChargeJobInput): Promise<JobOutcome> {
    const ride = await getRide(input.rideId);
    if (!ride || ride.payment.attemptId !== input.attemptId || ride.payment.status !== 'PENDING') {
      await deleteJob(job.pk); // settled or superseded
      return DONE;
    }
    const result = await charge(input, this.deadlineMs);
    const ctx = { rideId: input.rideId, attemptId: input.attemptId };
    switch (result.kind) {
      case 'RESULT': {
        const a = result.attempt;
        if (a.rideId !== input.rideId || a.amountMinor !== input.amountMinor || a.currency !== input.currency) {
          logger.error('payment result does not match attempt', { ...ctx, resultRideId: a.rideId });
          return retry('payment result mismatch');
        }
        await settleCharge(ride, input.attemptId, {
          status: a.status === 'APPROVED' ? 'PAID' : 'DECLINED',
          declineCode: a.declineCode,
          settledAttemptId: input.attemptId,
        });
        logger.info('payment settled', { ...ctx, status: a.status, declineCode: a.declineCode });
        return DONE;
      }
      case 'ALREADY_PAID': {
        // Reconcile with the durable approval if it belongs to this ride and fare.
        const lookup = await getAttempt(result.approvedAttemptId, this.deadlineMs);
        if (lookup.kind !== 'FOUND') return retry(`approved attempt lookup: ${lookup.kind}`);
        const a = lookup.attempt;
        if (a.status !== 'APPROVED' || a.rideId !== ride.rideId || a.amountMinor !== ride.fare.amountMinor || a.currency !== ride.fare.currency) {
          logger.error('approved attempt does not match ride', { ...ctx, approvedAttemptId: a.attemptId });
          return retry('approved attempt mismatch');
        }
        await settleCharge(ride, input.attemptId, { status: 'PAID', declineCode: null, settledAttemptId: a.attemptId });
        logger.info('payment reconciled with existing approval', { ...ctx, approvedAttemptId: a.attemptId });
        return DONE;
      }
      case 'REJECTED':
        if (result.code === 'INVALID_PAYMENT_METHOD') {
          await settleCharge(ride, input.attemptId, {
            status: 'DECLINED',
            declineCode: 'INVALID_PAYMENT_METHOD',
            settledAttemptId: input.attemptId,
          });
          return DONE;
        }
        logger.error('payment request rejected', { ...ctx, code: result.code });
        return retry(`payments rejected: ${result.code}`);
      case 'UNAVAILABLE':
        return retry(`payments: ${result.reason}`);
    }
  }

  private async publish(job: JobRecord, event: TripEvent): Promise<JobOutcome> {
    const key = keyForEvent(event);
    await this.s3.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: serializeEvent(event), ContentType: 'application/json' }),
      { abortSignal: AbortSignal.timeout(this.deadlineMs) },
    );
    await deleteJob(job.pk);
    logger.info('event published', { eventType: event.eventType, rideId: event.rideId, key });
    return DONE;
  }
}
