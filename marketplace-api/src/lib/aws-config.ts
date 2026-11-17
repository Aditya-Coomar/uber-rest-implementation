/**
 * Connection settings shared by every AWS SDK client. The endpoint must be an
 * explicitly configured LocalStack gateway; credentials are fixed dummy values
 * so real AWS credentials in the environment are never picked up.
 */
export function localstackEndpoint(): string {
  const endpoint = process.env.LOCALSTACK_ENDPOINT_URL;
  if (!endpoint) {
    throw new Error('LOCALSTACK_ENDPOINT_URL is not set. Run the bootstrap (npm run bootstrap) or set it explicitly.');
  }
  return endpoint.replace(/\/+$/, '');
}

export function awsRegion(): string {
  return process.env.AWS_REGION || 'us-east-1';
}

export function awsClientConfig() {
  return {
    endpoint: localstackEndpoint(),
    region: awsRegion(),
    credentials: {
      accessKeyId: process.env.LOCALSTACK_ACCESS_KEY_ID || 'test',
      secretAccessKey: process.env.LOCALSTACK_SECRET_ACCESS_KEY || 'test',
    },
  };
}

/** One prefix namespaces every demo resource inside the shared LocalStack. */
export function resourcePrefix(): string {
  const prefix = process.env.DEMO_RESOURCE_PREFIX || 'ridedemo';
  if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(prefix)) {
    throw new Error('DEMO_RESOURCE_PREFIX must be 2-40 lowercase letters, digits or hyphens.');
  }
  return prefix;
}
