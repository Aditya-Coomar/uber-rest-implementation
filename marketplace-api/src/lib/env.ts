/** Read an integer TCP port from the environment. */
export function portFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${name} must be a TCP port number.`);
  return port;
}

export function bindHost(): string {
  return process.env.BIND_HOST || '127.0.0.1';
}
