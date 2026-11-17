import { S3Client } from '@aws-sdk/client-s3';
import { SQSClient } from '@aws-sdk/client-sqs';
import { awsClientConfig } from '../lib/aws-config';

/** S3 against LocalStack: path-style addressing, explicit endpoint and dummy credentials. */
export function createS3Client(): S3Client {
  return new S3Client({
    ...awsClientConfig(),
    forcePathStyle: true,
    maxAttempts: 2,
    requestHandler: { connectionTimeout: 1_000, requestTimeout: 5_000 },
  });
}

/**
 * SQS against LocalStack. LocalStack may advertise queue URLs on a hostname the
 * app cannot resolve (e.g. *.localhost.localstack.cloud). With an explicit
 * endpoint and useQueueUrlAsEndpoint=false, requests travel to the verified
 * gateway while the QueueUrl still identifies the queue.
 */
export function createSqsClient(): SQSClient {
  return new SQSClient({
    ...awsClientConfig(),
    useQueueUrlAsEndpoint: false,
    maxAttempts: 2,
    requestHandler: { connectionTimeout: 1_000, requestTimeout: 25_000 },
  });
}
