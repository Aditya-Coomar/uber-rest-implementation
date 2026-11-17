import { GetObjectCommand, NoSuchKey, S3Client } from '@aws-sdk/client-s3';
import {
  ChangeMessageVisibilityCommand, DeleteMessageCommand, Message, ReceiveMessageCommand, SQSClient,
} from '@aws-sdk/client-sqs';
import { errorFields, logger } from '../lib/log';
import { isPlainObject } from '../lib/validate';
import { PermanentEventError, TripEvent, parseEvent, subjectFromKey } from '../analytics/events';
import { applyEvent, ensureActiveGeneration } from '../analytics/projection';

/** Retry a transient failure after this many seconds. */
const TRANSIENT_VISIBILITY_S = 10;
/** Bounce a malformed message quickly so the redrive policy moves it to the DLQ. */
const POISON_VISIBILITY_S = 1;

export async function fetchEvent(s3: S3Client, bucket: string, key: string): Promise<TripEvent> {
  const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: AbortSignal.timeout(5_000) });
  const text = (await out.Body?.transformToString('utf-8')) ?? '';
  return parseEvent(text, key);
}

/** S3 URL-encodes keys in notifications, with '+' for spaces. */
export function decodeS3Key(raw: string): string {
  return decodeURIComponent(raw.replace(/\+/g, ' '));
}

/** Extract the archived object keys a notification refers to, or throw if it is not ours. */
export function parseNotification(body: string, bucket: string): { test: true } | { test: false; keys: string[] } {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new PermanentEventError('message body is not JSON');
  }
  if (!isPlainObject(value)) throw new PermanentEventError('message body is not a JSON object');
  if (value.Event === 's3:TestEvent') return { test: true };
  if (!Array.isArray(value.Records) || value.Records.length === 0) throw new PermanentEventError('message has no Records');
  const keys: string[] = [];
  for (const record of value.Records as unknown[]) {
    const r = record as { eventSource?: unknown; eventName?: unknown; s3?: { bucket?: { name?: unknown }; object?: { key?: unknown } } };
    if (r?.eventSource !== 'aws:s3') throw new PermanentEventError('record is not from S3');
    if (typeof r.eventName !== 'string' || !r.eventName.startsWith('ObjectCreated:')) {
      throw new PermanentEventError(`unexpected eventName ${String(r.eventName)}`);
    }
    if (r.s3?.bucket?.name !== bucket) throw new PermanentEventError(`unexpected bucket ${String(r.s3?.bucket?.name)}`);
    const rawKey = r.s3?.object?.key;
    if (typeof rawKey !== 'string') throw new PermanentEventError('record has no object key');
    let key: string;
    try {
      key = decodeS3Key(rawKey);
    } catch {
      throw new PermanentEventError('object key is not valid URL encoding');
    }
    if (!subjectFromKey(key)) throw new PermanentEventError(`unexpected object key ${key}`);
    keys.push(key);
  }
  return { test: false, keys };
}

export class NotificationConsumer {
  constructor(
    private readonly sqs: SQSClient,
    private readonly s3: S3Client,
    private readonly queueUrl: string,
    private readonly bucket: string,
  ) {}

  /** One long poll. Returns the number of messages received. */
  async poll(abortSignal: AbortSignal): Promise<number> {
    const out = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 5,
        VisibilityTimeout: 30,
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      }),
      { abortSignal },
    );
    const messages = out.Messages ?? [];
    // Messages are independent (each event is deduplicated on its own), so handle them in parallel.
    await Promise.all(messages.map((m) => this.handle(m)));
    return messages.length;
  }

  private async handle(message: Message): Promise<void> {
    const ctx = {
      messageId: message.MessageId,
      receiveCount: Number(message.Attributes?.ApproximateReceiveCount ?? 0),
    };
    try {
      const parsed = parseNotification(message.Body ?? '', this.bucket);
      if (parsed.test) {
        logger.info('s3 test event acknowledged', ctx);
      } else {
        const generation = await ensureActiveGeneration();
        for (const key of parsed.keys) {
          let event: TripEvent;
          try {
            event = await fetchEvent(this.s3, this.bucket, key);
          } catch (err) {
            if (err instanceof NoSuchKey) throw new Error(`archived object ${key} not found yet`);
            throw err;
          }
          const result = await applyEvent(generation, event);
          logger.info('event projected', { ...ctx, key, eventType: event.eventType, eventId: event.eventId, generation, result });
        }
      }
      await this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: message.ReceiptHandle }));
    } catch (err) {
      const poison = err instanceof PermanentEventError;
      if (poison) {
        logger.error('malformed notification; leaving for dead-letter queue', {
          ...ctx,
          reason: (err as Error).message,
          body: (message.Body ?? '').slice(0, 500),
        });
      } else {
        logger.warn('notification processing failed; will retry', { ...ctx, ...errorFields(err) });
      }
      await this.sqs
        .send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: this.queueUrl,
            ReceiptHandle: message.ReceiptHandle,
            VisibilityTimeout: poison ? POISON_VISIBILITY_S : TRANSIENT_VISIBILITY_S,
          }),
        )
        .catch((e) => logger.warn('visibility change failed', { ...ctx, ...errorFields(e) }));
    }
  }
}
