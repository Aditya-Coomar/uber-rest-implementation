#!/usr/bin/env node
/**
 * One command to run the backend locally (macOS, Linux, Windows):
 *
 *   1. validate configuration (Node version, builds, prefix, ports, origins)
 *   2. bootstrap LocalStack resources (discovers and verifies the endpoint)
 *   3. seed missing drivers
 *   4. start Marketplace, Payments, Rides and the Rides worker
 *   5. wait for health and print each process's status
 *
 * Usage:
 *   node scripts/start.mjs                 start everything
 *   node scripts/start.mjs --bootstrap-only
 *
 * While running, type "status" + Enter to re-check every process; Ctrl+C stops all.
 * Uses no shell and no dependencies: every child is `node <script>`.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BOOTSTRAP_ONLY = process.argv.includes('--bootstrap-only');
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
const COLORS = { marketplace: 35, payments: 33, rides: 36, worker: 32, simulator: 94, bootstrap: 34, seed: 34 };

function fail(message) {
  console.error(paint(31, `\n✖ ${message}`));
  process.exit(1);
}

// ------------------------------------------------------------------ configuration

const envFile = path.join(ROOT, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 24) fail(`Node.js 24 or newer is required (found ${process.versions.node}).`);

const prefix = process.env.DEMO_RESOURCE_PREFIX || 'ridedemo';
if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(prefix)) fail('DEMO_RESOURCE_PREFIX must be 2-40 lowercase letters, digits or hyphens.');
const region = process.env.AWS_REGION || 'us-east-1';
const host = '127.0.0.1';

const builds = {
  marketplace: path.join(ROOT, 'marketplace-api', 'dist', 'server.js'),
  payments: path.join(ROOT, 'payments-api', 'dist', 'server.js'),
  rides: path.join(ROOT, 'rides-api', 'dist', 'server.js'),
  worker: path.join(ROOT, 'rides-api', 'dist', 'worker.js'),
  simulator: path.join(ROOT, 'load-simulator', 'dist', 'server.js'),
  bootstrap: path.join(ROOT, 'rides-api', 'dist', 'scripts', 'bootstrap.js'),
  seed: path.join(ROOT, 'marketplace-api', 'dist', 'scripts', 'seed.js'),
};
for (const [name, file] of Object.entries(builds)) {
  if (!existsSync(file)) fail(`Missing build for ${name} (${path.relative(ROOT, file)}). Run: npm run build`);
}

function parsePort(name) {
  const raw = process.env[name];
  if (!raw) return null;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`${name} must be a TCP port number.`);
  return port;
}

const frontendOrigins = (process.env.FRONTEND_ORIGIN || 'http://localhost:3000')
  .split(',')
  .map((s) => s.trim().replace(/\/+$/, ''))
  .filter(Boolean);
for (const origin of frontendOrigins) {
  try {
    const u = new URL(origin);
    if (u.origin !== origin) throw new Error();
  } catch {
    fail(`FRONTEND_ORIGIN entries must be origins like http://localhost:3000 (got "${origin}").`);
  }
}
// The same dev server is reachable as localhost and 127.0.0.1.
const corsOrigins = [...new Set(frontendOrigins.flatMap((o) => [o, o.replace('//localhost:', '//127.0.0.1:'), o.replace('//127.0.0.1:', '//localhost:')]))];

/** Free on both the IPv4 loopback and the IPv6 wildcard (avoids "localhost" reaching another app). */
function portFree(port) {
  const tryListen = (h) =>
    new Promise((resolve) => {
      const srv = net.createServer();
      srv.once('error', (err) => resolve(err.code === 'EAFNOSUPPORT' || err.code === 'EADDRNOTAVAIL'));
      srv.listen({ port, host: h, exclusive: true }, () => srv.close(() => resolve(true)));
    });
  return tryListen(host).then((ok) => ok && tryListen('::'));
}

async function resolvePort(envName, preferred, taken) {
  const explicit = parsePort(envName);
  if (explicit) {
    if (!(await portFree(explicit))) fail(`${envName}=${explicit} is already in use.`);
    return explicit;
  }
  for (let port = preferred; port < preferred + 100; port += 1) {
    if (!taken.includes(port) && (await portFree(port))) return port;
  }
  fail(`No free port found near ${preferred} for ${envName}.`);
}

// ------------------------------------------------------------------ process helpers

function formatLine(name, line) {
  let text = line;
  try {
    const { ts, level, service: _service, msg, ...rest } = JSON.parse(line);
    const fields = Object.entries(rest)
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join(' ');
    const lvl = level === 'error' ? paint(31, 'ERROR') : level === 'warn' ? paint(33, 'WARN ') : 'info ';
    text = `${String(ts).slice(11, 23)} ${lvl} ${msg}${fields ? `  ${paint(2, fields)}` : ''}`;
  } catch {
    /* not JSON; print as-is */
  }
  return `${paint(COLORS[name] ?? 37, `[${name.padEnd(11)}]`)} ${text}`;
}

function pipeLines(name, stream, sink, onLine) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      onLine?.(line);
      if (sink) sink.write(`${formatLine(name, line)}\n`);
    }
  });
}

/** Package directory that owns a built script (…/<pkg>/dist/…). */
const packageDir = (script) => path.join(ROOT, path.relative(ROOT, script).split(path.sep)[0]);

function runOnce(name, script, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], { cwd: packageDir(script), env, windowsHide: true });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    pipeLines(name, child.stderr, process.stdout);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout }));
  });
}

const baseEnv = {
  ...process.env,
  AWS_REGION: region,
  DEMO_RESOURCE_PREFIX: prefix,
  BIND_HOST: host,
};

// ------------------------------------------------------------------ bootstrap

console.log(paint(1, `\nRide-booking SOA demo — prefix "${prefix}", region ${region}\n`));
console.log('▸ Bootstrapping LocalStack resources …');
const boot = await runOnce('bootstrap', builds.bootstrap, baseEnv);
let bootResult;
try {
  bootResult = JSON.parse(boot.stdout.trim().split(/\r?\n/).pop());
} catch {
  bootResult = { ok: false, error: 'bootstrap produced no result' };
}
if (boot.code !== 0 || !bootResult.ok) {
  if (bootResult.discovery) {
    console.error('\nLocalStack discovery steps:');
    for (const s of bootResult.discovery) console.error(`  ${s.ok ? '✔' : '✖'} ${s.source} ${s.candidate ?? ''} — ${s.detail}`);
  }
  fail(`Bootstrap failed: ${bootResult.error}. Set LOCALSTACK_ENDPOINT_URL if LocalStack is not on the default gateway.`);
}
const endpoint = bootResult.endpoint;
console.log(`  LocalStack: ${endpoint} (via ${bootResult.endpointSource}); notification check ${bootResult.checks.notificationLatencyMs} ms`);

console.log('▸ Seeding drivers (missing only) …');
const seed = await runOnce('seed', builds.seed, { ...baseEnv, LOCALSTACK_ENDPOINT_URL: endpoint });
if (seed.code !== 0) fail('Driver seed failed.');

if (BOOTSTRAP_ONLY) {
  console.log(paint(32, '\n✔ Bootstrap complete.\n'));
  console.log(`  LOCALSTACK_ENDPOINT_URL=${endpoint}`);
  process.exit(0);
}

// ------------------------------------------------------------------ ports and URLs

const taken = [];
const marketplacePort = await resolvePort('MARKETPLACE_API_PORT', 4101, taken);
taken.push(marketplacePort);
const paymentsPort = await resolvePort('PAYMENTS_API_PORT', 4102, taken);
taken.push(paymentsPort);
const ridesPort = await resolvePort('RIDES_API_PORT', 4100, taken);
taken.push(ridesPort);
const simulatorPort = await resolvePort('SIMULATOR_PORT', 4103, taken);

const urls = {
  marketplace: `http://${host}:${marketplacePort}`,
  payments: `http://${host}:${paymentsPort}`,
  rides: `http://${host}:${ridesPort}`,
  simulator: `http://${host}:${simulatorPort}`,
};

const serviceEnv = {
  ...baseEnv,
  LOCALSTACK_ENDPOINT_URL: endpoint,
  MARKETPLACE_API_BASE_URL: urls.marketplace,
  PAYMENTS_API_BASE_URL: urls.payments,
  CORS_ORIGINS: corsOrigins.join(','),
  TRIP_EVENTS_QUEUE_URL: bootResult.queueUrl,
};

const processes = [
  { name: 'marketplace', script: builds.marketplace, env: { PORT: String(marketplacePort) }, health: `${urls.marketplace}/api/health`, url: urls.marketplace },
  { name: 'payments', script: builds.payments, env: { PORT: String(paymentsPort) }, health: `${urls.payments}/api/health`, url: urls.payments },
  { name: 'rides', script: builds.rides, env: { PORT: String(ridesPort) }, health: `${urls.rides}/api/health`, url: urls.rides },
  { name: 'worker', script: builds.worker, env: {}, health: null, url: '—' },
  {
    name: 'simulator',
    script: builds.simulator,
    env: { PORT: String(simulatorPort), RIDES_API_BASE_URL: urls.rides },
    health: `${urls.simulator}/api/health`,
    url: urls.simulator,
  },
];

// Keep the frontend pointed at the actual backend URLs (only touches a file this script owns).
// The browser calls same-origin paths that Next proxies, so the app also works behind one public URL.
// Setting NEXT_PUBLIC_API_BASE_URL to the absolute Rides URL instead is supported (Rides CORS allows FRONTEND_ORIGIN).
const MARKER = '# managed by scripts/start.mjs';
const frontendEnv = path.join(ROOT, 'frontend', '.env.local');
const desiredFrontendEnv = [
  MARKER,
  `RIDES_API_PROXY_TARGET=${urls.rides}`,
  `SIM_API_PROXY_TARGET=${urls.simulator}`,
  'NEXT_PUBLIC_API_BASE_URL=/rides-api',
  'NEXT_PUBLIC_SIM_API_BASE_URL=/sim-api',
  '',
].join('\n');
let frontendEnvNote;
if (!existsSync(frontendEnv) || readFileSync(frontendEnv, 'utf8').startsWith(MARKER)) {
  if (!existsSync(frontendEnv) || readFileSync(frontendEnv, 'utf8') !== desiredFrontendEnv) writeFileSync(frontendEnv, desiredFrontendEnv);
  frontendEnvNote = `wrote frontend/.env.local (proxies /rides-api → ${urls.rides}, /sim-api → ${urls.simulator})`;
} else {
  frontendEnvNote = `frontend/.env.local is user-managed; set RIDES_API_PROXY_TARGET=${urls.rides} and SIM_API_PROXY_TARGET=${urls.simulator}`;
}

// ------------------------------------------------------------------ start

let stopping = false;
for (const p of processes) {
  p.state = 'starting';
  p.child = spawn(process.execPath, [p.script], {
    cwd: packageDir(p.script),
    env: { ...serviceEnv, ...p.env },
    windowsHide: true,
  });
  const onLine = (line) => {
    if (p.name === 'worker' && line.includes('"worker started"')) p.state = 'running';
  };
  pipeLines(p.name, p.child.stdout, process.stdout, onLine);
  pipeLines(p.name, p.child.stderr, process.stdout, onLine);
  p.child.on('exit', (code, signal) => {
    p.state = `exited (${signal ?? code})`;
    if (!stopping) console.log(paint(31, `\n✖ ${p.name} exited (${signal ?? code}). Other processes keep running; restart with npm start.\n`));
  });
}

async function healthOf(p) {
  if (!p.child || p.child.exitCode !== null) return p.state;
  if (!p.health) return p.state;
  try {
    const res = await fetch(p.health, { signal: AbortSignal.timeout(2_000) });
    return res.status === 200 ? 'healthy' : `unhealthy (HTTP ${res.status})`;
  } catch {
    return 'starting';
  }
}

async function printStatus() {
  const rows = [];
  for (const p of processes) rows.push([p.name, String(p.child?.pid ?? '—'), p.url, await healthOf(p)]);
  const widths = [11, 7, 26, 20];
  const line = (cols) => cols.map((c, i) => c.padEnd(widths[i])).join('  ');
  console.log(`\n${paint(1, line(['process', 'pid', 'url', 'status']))}`);
  for (const r of rows) {
    const ok = r[3] === 'healthy' || r[3] === 'running';
    console.log(line(r.slice(0, 3)) + '  ' + paint(ok ? 32 : 33, r[3]));
  }
  return rows.every((r) => r[3] === 'healthy' || r[3] === 'running');
}

const deadline = Date.now() + 30_000;
let ready = false;
while (Date.now() < deadline && !ready) {
  await new Promise((r) => setTimeout(r, 500));
  ready = (await Promise.all(processes.map(healthOf))).every((s) => s === 'healthy' || s === 'running');
}
await printStatus();
if (ready) {
  console.log(paint(32, '\n✔ Backend ready.'));
} else {
  console.log(paint(33, '\n! Some processes are not healthy yet; see the logs above. Type "status" to re-check.'));
}
console.log(`
  Rides API (public):   ${urls.rides}
  Load simulator:       ${urls.simulator}
  Frontend origin(s):   ${corsOrigins.join(', ')}
  Frontend env:         ${frontendEnvNote}

  Next: in another terminal run  npm run frontend:dev   then open ${frontendOrigins[0]}
  Type "status" + Enter to re-check processes. Ctrl+C stops everything.
`);

// ------------------------------------------------------------------ interaction and shutdown

if (process.stdin.isTTY || process.stdin.readable) {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (input) => {
    if (input.trim() === 'status') void printStatus();
  });
}

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`\n${signal} received — stopping all processes …`);
  const alive = processes.filter((p) => p.child && p.child.exitCode === null);
  // Worker first so it stops polling before the APIs disappear.
  for (const p of [...alive].sort((a) => (a.name === 'worker' ? -1 : 1))) p.child.kill('SIGTERM');
  const force = setTimeout(() => {
    for (const p of alive) if (p.child.exitCode === null) p.child.kill('SIGKILL');
    process.exit(1);
  }, 15_000);
  Promise.all(alive.map((p) => new Promise((r) => (p.child.exitCode !== null ? r() : p.child.once('exit', r))))).then(() => {
    clearTimeout(force);
    console.log('All processes stopped.');
    process.exit(0);
  });
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
if (process.platform === 'win32') process.on('SIGBREAK', () => shutdown('SIGBREAK'));
