import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DynamoDBClient, ListTablesCommand } from '@aws-sdk/client-dynamodb';
import { ListBucketsCommand, S3Client } from '@aws-sdk/client-s3';
import { ListQueuesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { awsRegion } from '../lib/aws-config';

const execFileAsync = promisify(execFile);
const REQUIRED_SERVICES = ['dynamodb', 's3', 'sqs'] as const;

export interface DiscoveryStep {
  source: string;
  candidate?: string;
  ok: boolean;
  detail: string;
}

export interface DiscoveryResult {
  endpoint: string | null;
  source: string | null;
  steps: DiscoveryStep[];
}

/** Host-published LocalStack gateways from `docker ps` (any container whose image mentions localstack). */
async function dockerCandidates(steps: DiscoveryStep[]): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('docker', ['ps', '--format', '{{.Names}}\t{{.Image}}\t{{.Ports}}'], {
      timeout: 5_000,
      windowsHide: true,
    });
    const found: string[] = [];
    for (const line of stdout.split(/\r?\n/)) {
      const [name, image, ports] = line.split('\t');
      if (!image || !/localstack/i.test(image)) continue;
      // e.g. "0.0.0.0:4566->4566/tcp, [::]:4566->4566/tcp"
      for (const m of (ports ?? '').matchAll(/(?:(\d+\.\d+\.\d+\.\d+|\[::\]):)?(\d+)->4566\/tcp/g)) {
        const hostIp = m[1] && m[1] !== '0.0.0.0' && m[1] !== '[::]' ? m[1] : '127.0.0.1';
        const url = `http://${hostIp}:${m[2]}`;
        if (!found.includes(url)) found.push(url);
      }
      steps.push({ source: 'docker', ok: found.length > 0, detail: `container ${name} (${image}) publishes ${ports || 'no ports'}` });
    }
    if (!stdout.trim() || found.length === 0) {
      steps.push({ source: 'docker', ok: false, detail: 'no running container publishes the LocalStack gateway port 4566' });
    }
    return found;
  } catch (err) {
    steps.push({ source: 'docker', ok: false, detail: `docker ps unavailable: ${(err as Error).message.split('\n')[0]}` });
    return [];
  }
}

/** Validate a gateway: health endpoint reports the services, and SDK calls succeed. */
export async function validateEndpoint(endpoint: string): Promise<{ ok: boolean; detail: string }> {
  let health: { services?: Record<string, string>; version?: string; edition?: string };
  try {
    const res = await fetch(`${endpoint}/_localstack/health`, { signal: AbortSignal.timeout(3_000) });
    if (!res.ok) return { ok: false, detail: `/_localstack/health returned HTTP ${res.status}` };
    health = (await res.json()) as typeof health;
  } catch (err) {
    return { ok: false, detail: `/_localstack/health unreachable: ${(err as Error).message}` };
  }
  const missing = REQUIRED_SERVICES.filter((s) => !['running', 'available'].includes(health.services?.[s] ?? ''));
  if (missing.length > 0) return { ok: false, detail: `services not enabled: ${missing.join(', ')}` };

  const cfg = {
    endpoint,
    region: awsRegion(),
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    maxAttempts: 1,
    requestHandler: { connectionTimeout: 2_000, requestTimeout: 5_000 },
  };
  try {
    await new DynamoDBClient(cfg).send(new ListTablesCommand({ Limit: 1 }));
    await new S3Client({ ...cfg, forcePathStyle: true }).send(new ListBucketsCommand({}));
    await new SQSClient({ ...cfg, useQueueUrlAsEndpoint: false }).send(new ListQueuesCommand({ MaxResults: 1 }));
  } catch (err) {
    return { ok: false, detail: `SDK call failed: ${(err as Error).name}: ${(err as Error).message}` };
  }
  return { ok: true, detail: `LocalStack ${health.edition ?? ''} ${health.version ?? ''}`.trim() };
}

/**
 * Resolve the LocalStack gateway: an explicit LOCALSTACK_ENDPOINT_URL is
 * authoritative; otherwise inspect running Docker containers, then try the
 * conventional local gateway addresses. Every candidate must validate.
 */
export async function discoverEndpoint(): Promise<DiscoveryResult> {
  const steps: DiscoveryStep[] = [];
  const explicit = process.env.LOCALSTACK_ENDPOINT_URL?.replace(/\/+$/, '');
  if (explicit) {
    const v = await validateEndpoint(explicit);
    steps.push({ source: 'LOCALSTACK_ENDPOINT_URL', candidate: explicit, ...v });
    return { endpoint: v.ok ? explicit : null, source: v.ok ? 'LOCALSTACK_ENDPOINT_URL' : null, steps };
  }
  steps.push({ source: 'LOCALSTACK_ENDPOINT_URL', ok: false, detail: 'not set' });

  const candidates: Array<{ source: string; url: string }> = [];
  for (const url of await dockerCandidates(steps)) candidates.push({ source: 'docker', url });
  for (const url of ['http://localhost:4566', 'http://127.0.0.1:4566']) {
    if (!candidates.some((c) => c.url === url)) candidates.push({ source: 'default', url });
  }
  for (const c of candidates) {
    const v = await validateEndpoint(c.url);
    steps.push({ source: c.source, candidate: c.url, ...v });
    if (v.ok) return { endpoint: c.url, source: c.source, steps };
  }
  return { endpoint: null, source: null, steps };
}
