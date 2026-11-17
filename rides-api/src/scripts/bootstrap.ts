import { randomUUID } from 'node:crypto';
import {
  CreateTableCommand, DescribeTableCommand, DynamoDBClient, ResourceNotFoundException, UpdateTableCommand, waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, PutCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import {
  CreateBucketCommand, DeleteObjectCommand, GetBucketNotificationConfigurationCommand, HeadBucketCommand,
  PutBucketNotificationConfigurationCommand, PutObjectCommand, S3Client,
} from '@aws-sdk/client-s3';
import {
  CreateQueueCommand, DeleteMessageCommand, GetQueueAttributesCommand, GetQueueUrlCommand, QueueDoesNotExist,
  ReceiveMessageCommand, SQSClient, SetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';
import { errorFields, logToStderr, logger, setServiceName } from '../lib/log';
setServiceName('bootstrap');
logToStderr();
import { awsClientConfig, awsRegion, resourcePrefix } from '../lib/aws-config';
import { cancellationCodes, isConditionalCheckFailed, isTransactionCanceled } from '../lib/dynamo';
import { resourceNames } from '../config';
import { EVENT_PREFIXES } from '../analytics/events';
import { JOBS_INDEX } from '../store/db';
import { discoverEndpoint } from '../aws/endpoint';

/**
 * Create or reconcile every demo resource under DEMO_RESOURCE_PREFIX inside the
 * existing LocalStack, then prove the capabilities the demo relies on.
 * Existing rides, reservations and archived events are never touched.
 * Logs go to stderr; a JSON summary is the only thing printed to stdout.
 */
const CHECK_PREFIX = '_bootstrap-check/';
const MAX_RECEIVE_COUNT = 5;

const log = (msg: string, fields?: Record<string, unknown>) => logger.info(msg, fields);

async function ensureTable(ddb: DynamoDBClient, name: string): Promise<'created' | 'exists'> {
  try {
    await ddb.send(new DescribeTableCommand({ TableName: name }));
    await waitUntilTableExists({ client: ddb, maxWaitTime: 60 }, { TableName: name });
    return 'exists';
  } catch (err) {
    if (!(err instanceof ResourceNotFoundException)) throw err;
  }
  try {
    await ddb.send(
      new CreateTableCommand({
        TableName: name,
        BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
      }),
    );
  } catch (err) {
    if ((err as Error).name !== 'ResourceInUseException') throw err;
  }
  await waitUntilTableExists({ client: ddb, maxWaitTime: 60 }, { TableName: name });
  return 'created';
}

/** Create a GSI in place if missing (existing data is kept) and wait until it is ACTIVE. */
async function ensureIndex(
  ddb: DynamoDBClient,
  name: string,
  indexName: string,
  hashKey: string,
  rangeKey: string | null,
  projection: 'ALL' | 'KEYS_ONLY',
): Promise<'created' | 'exists'> {
  const describe = async () => (await ddb.send(new DescribeTableCommand({ TableName: name }))).Table;
  const index = (await describe())?.GlobalSecondaryIndexes?.find((i) => i.IndexName === indexName);
  let status: 'created' | 'exists' = 'exists';
  if (!index) {
    await ddb.send(
      new UpdateTableCommand({
        TableName: name,
        AttributeDefinitions: [hashKey, ...(rangeKey ? [rangeKey] : [])].map((a) => ({ AttributeName: a, AttributeType: 'S' as const })),
        GlobalSecondaryIndexUpdates: [
          {
            Create: {
              IndexName: indexName,
              KeySchema: [
                { AttributeName: hashKey, KeyType: 'HASH' as const },
                ...(rangeKey ? [{ AttributeName: rangeKey, KeyType: 'RANGE' as const }] : []),
              ],
              Projection: { ProjectionType: projection },
            },
          },
        ],
      }),
    );
    status = 'created';
  }
  for (let i = 0; i < 120; i += 1) {
    const table = await describe();
    const gsi = table?.GlobalSecondaryIndexes?.find((g) => g.IndexName === indexName);
    if (table?.TableStatus === 'ACTIVE' && gsi?.IndexStatus === 'ACTIVE') return status;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`index ${indexName} on ${name} did not become ACTIVE`);
}

/** Step-1 capability proof: conditional writes and transactions behave as the services expect. */
async function verifyDynamo(doc: DynamoDBDocumentClient, tableName: string): Promise<void> {
  const a = `BOOTSTRAP#check#${randomUUID()}`;
  const b = `BOOTSTRAP#check#${randomUUID()}`;
  try {
    await doc.send(new PutCommand({ TableName: tableName, Item: { pk: a }, ConditionExpression: 'attribute_not_exists(pk)' }));
    let conditionalRejected = false;
    try {
      await doc.send(new PutCommand({ TableName: tableName, Item: { pk: a }, ConditionExpression: 'attribute_not_exists(pk)' }));
    } catch (err) {
      conditionalRejected = isConditionalCheckFailed(err);
    }
    if (!conditionalRejected) throw new Error('DynamoDB did not reject a failing conditional write');

    let codes: string[] = [];
    try {
      await doc.send(
        new TransactWriteCommand({
          TransactItems: [
            { Put: { TableName: tableName, Item: { pk: b }, ConditionExpression: 'attribute_not_exists(pk)' } },
            { Put: { TableName: tableName, Item: { pk: a }, ConditionExpression: 'attribute_not_exists(pk)' } },
          ],
        }),
      );
    } catch (err) {
      if (isTransactionCanceled(err)) codes = cancellationCodes(err);
      else throw err;
    }
    if (codes[1] !== 'ConditionalCheckFailed') throw new Error(`transaction cancellation reasons unusable: ${JSON.stringify(codes)}`);
    await doc.send(
      new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName: tableName, Item: { pk: b }, ConditionExpression: 'attribute_not_exists(pk)' } },
          { Delete: { TableName: tableName, Key: { pk: a }, ConditionExpression: 'attribute_exists(pk)' } },
        ],
      }),
    );
  } finally {
    await doc.send(new DeleteCommand({ TableName: tableName, Key: { pk: a } })).catch(() => undefined);
    await doc.send(new DeleteCommand({ TableName: tableName, Key: { pk: b } })).catch(() => undefined);
  }
}

async function ensureBucket(s3: S3Client, bucket: string): Promise<'created' | 'exists'> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    return 'exists';
  } catch (err) {
    const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status !== 404 && (err as Error).name !== 'NotFound') throw err;
  }
  const region = awsRegion();
  await s3.send(
    new CreateBucketCommand({
      Bucket: bucket,
      ...(region !== 'us-east-1' && { CreateBucketConfiguration: { LocationConstraint: region as never } }),
    }),
  );
  for (let i = 0; i < 20; i += 1) {
    try {
      await s3.send(new HeadBucketCommand({ Bucket: bucket }));
      return 'created';
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(`bucket ${bucket} did not become available`);
}

async function ensureQueue(sqs: SQSClient, name: string): Promise<{ url: string; arn: string; status: 'created' | 'exists' }> {
  let status: 'created' | 'exists' = 'exists';
  let url: string;
  try {
    url = (await sqs.send(new GetQueueUrlCommand({ QueueName: name }))).QueueUrl!;
  } catch (err) {
    if (!(err instanceof QueueDoesNotExist) && (err as Error).name !== 'AWS.SimpleQueueService.NonExistentQueue') throw err;
    url = (await sqs.send(new CreateQueueCommand({ QueueName: name }))).QueueUrl!;
    status = 'created';
  }
  for (let i = 0; i < 20; i += 1) {
    try {
      const attrs = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['QueueArn'] }));
      const arn = attrs.Attributes?.QueueArn;
      if (arn) return { url, arn, status };
    } catch {
      /* not ready yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`queue ${name} did not become available`);
}

function s3SendPolicy(queueArn: string, bucketArn: string): string {
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'AllowArchiveBucketNotifications',
        Effect: 'Allow',
        Principal: { Service: 's3.amazonaws.com' },
        Action: 'sqs:SendMessage',
        Resource: queueArn,
        Condition: { ArnEquals: { 'aws:SourceArn': bucketArn } },
      },
    ],
  });
}

/** Put a probe object under the check prefix and wait for its notification on the check queue. */
async function verifyNotificationPath(s3: S3Client, sqs: SQSClient, bucket: string, checkQueueUrl: string): Promise<number> {
  const key = `${CHECK_PREFIX}${randomUUID()}.json`;
  const started = Date.now();
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: '{"probe":true}', ContentType: 'application/json' }));
  try {
    while (Date.now() - started < 20_000) {
      const out = await sqs.send(
        new ReceiveMessageCommand({ QueueUrl: checkQueueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 2 }),
      );
      for (const m of out.Messages ?? []) {
        // Clear everything on the private check queue (test events, stale probes).
        await sqs.send(new DeleteMessageCommand({ QueueUrl: checkQueueUrl, ReceiptHandle: m.ReceiptHandle }));
        const body = JSON.parse(m.Body ?? '{}') as { Records?: Array<{ s3?: { object?: { key?: string } } }> };
        const keys = (body.Records ?? []).map((r) => decodeURIComponent((r.s3?.object?.key ?? '').replace(/\+/g, ' ')));
        if (keys.includes(key)) return Date.now() - started;
      }
    }
    throw new Error('object-created notification did not reach SQS within 20s');
  } finally {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })).catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const discovery = await discoverEndpoint();
  for (const step of discovery.steps) log('endpoint discovery', { ...step });
  if (!discovery.endpoint) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: 'No verified LocalStack endpoint', discovery: discovery.steps })}\n`);
    process.exitCode = 2;
    return;
  }
  process.env.LOCALSTACK_ENDPOINT_URL = discovery.endpoint;
  const prefix = resourcePrefix();
  const names = resourceNames(prefix);
  log('using LocalStack', { endpoint: discovery.endpoint, source: discovery.source, prefix, region: awsRegion() });

  const ddb = new DynamoDBClient({ ...awsClientConfig(), maxAttempts: 3 });
  const doc = DynamoDBDocumentClient.from(ddb);
  const s3 = new S3Client({ ...awsClientConfig(), forcePathStyle: true });
  const sqs = new SQSClient({ ...awsClientConfig(), useQueueUrlAsEndpoint: false });

  const tables: Record<string, string> = {};
  for (const t of [names.ridesTable, names.marketplaceTable, names.paymentsTable]) {
    tables[t] = await ensureTable(ddb, t);
    log('table ready', { table: t, status: tables[t] });
  }
  // Sparse indexes keep the hot paths off full-table scans as volume grows.
  const jobsIndex = await ensureIndex(ddb, names.ridesTable, JOBS_INDEX, 'gsiJobPk', 'gsiJobSk', 'ALL');
  log('jobs index ready', { table: names.ridesTable, index: JOBS_INDEX, status: jobsIndex });
  const driversIndex = await ensureIndex(ddb, names.marketplaceTable, 'drivers', 'gsiDriverPk', null, 'KEYS_ONLY');
  log('drivers index ready', { table: names.marketplaceTable, index: 'drivers', status: driversIndex });
  await verifyDynamo(doc, names.ridesTable);
  log('dynamodb conditional write and transaction verified');

  // Analytics pointer: create once, never reset.
  await doc
    .send(
      new PutCommand({
        TableName: names.ridesTable,
        Item: { pk: 'ANALYTICS#ACTIVE', generation: 'g0', activatedAt: new Date().toISOString() },
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    )
    .catch((err) => {
      if (!isConditionalCheckFailed(err)) throw err;
    });

  const bucketStatus = await ensureBucket(s3, names.bucket);
  const bucketArn = `arn:aws:s3:::${names.bucket}`;
  log('bucket ready', { bucket: names.bucket, status: bucketStatus });

  const dlq = await ensureQueue(sqs, names.deadLetterQueue);
  const queue = await ensureQueue(sqs, names.queue);
  const check = await ensureQueue(sqs, names.notifyCheckQueue);
  await sqs.send(
    new SetQueueAttributesCommand({
      QueueUrl: queue.url,
      Attributes: {
        VisibilityTimeout: '30',
        MessageRetentionPeriod: '1209600',
        Policy: s3SendPolicy(queue.arn, bucketArn),
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlq.arn, maxReceiveCount: String(MAX_RECEIVE_COUNT) }),
      },
    }),
  );
  await sqs.send(new SetQueueAttributesCommand({ QueueUrl: dlq.url, Attributes: { MessageRetentionPeriod: '1209600' } }));
  await sqs.send(new SetQueueAttributesCommand({ QueueUrl: check.url, Attributes: { Policy: s3SendPolicy(check.arn, bucketArn), MessageRetentionPeriod: '300' } }));
  log('queues ready', { queue: queue.url, dlq: dlq.url, maxReceiveCount: MAX_RECEIVE_COUNT });

  // The bucket is dedicated to the demo, so its notification config is ours to reconcile.
  const eventRule = (id: string, prefix: string) => ({
    Id: id,
    QueueArn: queue.arn,
    Events: ['s3:ObjectCreated:*' as const],
    Filter: { Key: { FilterRules: [{ Name: 'prefix' as const, Value: prefix }, { Name: 'suffix' as const, Value: '.json' }] } },
  });
  const desired = [
    eventRule('ride-completed-to-sqs', EVENT_PREFIXES.RideCompleted),
    eventRule('ride-cancelled-to-sqs', EVENT_PREFIXES.RideCancelled),
    eventRule('payment-settled-to-sqs', EVENT_PREFIXES.PaymentSettled),
    {
      Id: 'bootstrap-check-to-sqs',
      QueueArn: check.arn,
      Events: ['s3:ObjectCreated:*' as const],
      Filter: { Key: { FilterRules: [{ Name: 'prefix' as const, Value: CHECK_PREFIX }] } },
    },
  ];
  const current = await s3.send(new GetBucketNotificationConfigurationCommand({ Bucket: names.bucket }));
  const currentIds = (current.QueueConfigurations ?? []).map((q) => `${q.Id}:${q.QueueArn}`).sort().join(',');
  const desiredIds = desired.map((q) => `${q.Id}:${q.QueueArn}`).sort().join(',');
  if (currentIds !== desiredIds) {
    await s3.send(
      new PutBucketNotificationConfigurationCommand({ Bucket: names.bucket, NotificationConfiguration: { QueueConfigurations: desired } }),
    );
    log('bucket notifications configured', { prefixes: Object.values(EVENT_PREFIXES) });
  } else {
    log('bucket notifications already configured');
  }

  const latencyMs = await verifyNotificationPath(s3, sqs, names.bucket, check.url);
  log('s3 object-created notification reached sqs', { latencyMs });

  const summary = {
    ok: true,
    endpoint: discovery.endpoint,
    endpointSource: discovery.source,
    region: awsRegion(),
    prefix,
    tables,
    indexes: { [JOBS_INDEX]: jobsIndex, drivers: driversIndex },
    bucket: { name: names.bucket, status: bucketStatus },
    queueUrl: queue.url,
    deadLetterQueueUrl: dlq.url,
    checks: { dynamoConditionalAndTransaction: true, notificationLatencyMs: latencyMs },
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

main().catch((err) => {
  logger.error('bootstrap failed', { ...errorFields(err), stack: (err as Error).stack });
  process.stdout.write(`${JSON.stringify({ ok: false, error: (err as Error).message })}\n`);
  process.exitCode = 1;
});
