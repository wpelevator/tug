import https from 'node:https';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const MAX_BODY_BYTES = 4 * 1024 * 1024;

export function summarize(latencies, elapsedMs, errors, connections) {
  const sorted = [...latencies].sort((a, b) => a - b);
  const percentile = (p) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? null;
  return {
    requests: sorted.length,
    errors,
    connections,
    elapsedMs,
    requestsPerSecond: sorted.length / (elapsedMs / 1000),
    meanMs: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
  };
}

function validator(expectation) {
  if (!expectation || typeof expectation !== 'object')
    throw new Error('A valid expectation is required');
  const { type, id, name, body, title, marker } = expectation;
  if (
    type === 'file-list' &&
    (typeof id === 'string' || typeof id === 'number') &&
    typeof name === 'string'
  ) {
    return (bytes) => {
      try {
        const files = JSON.parse(bytes.toString('utf8'));
        return (
          Array.isArray(files) && files.some((file) => file && file.id === id && file.name === name)
        );
      } catch {
        return false;
      }
    };
  }
  if (type === 'download' && typeof body === 'string') {
    const expected = Buffer.from(body);
    return (bytes) => bytes.equals(expected);
  }
  if (
    type === 'wordpress' &&
    typeof title === 'string' &&
    title &&
    typeof marker === 'string' &&
    marker
  ) {
    return (bytes) => {
      const html = bytes.toString('utf8');
      return html.includes(title) && html.includes(marker);
    };
  }
  throw new Error('Invalid workload expectation');
}

export async function runLoad(url, concurrency, seconds, expectation) {
  let target;
  try {
    target = new URL(url);
  } catch {
    throw new Error('URL must be a valid HTTPS URL');
  }
  if (target.protocol !== 'https:') throw new Error('URL must be a valid HTTPS URL');
  if (
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    !Number.isFinite(seconds) ||
    seconds <= 0
  ) {
    throw new Error(
      'Concurrency must be a positive integer and duration must be positive and finite',
    );
  }
  const validate = validator(expectation);
  const timeoutMs = expectation.timeoutMs ?? 5000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error('Timeout must be positive and finite');
  const agent = new https.Agent({
    keepAlive: true,
    maxSockets: concurrency,
    maxFreeSockets: concurrency,
    rejectUnauthorized: false,
    minVersion: 'TLSv1.3',
    maxVersion: 'TLSv1.3',
  });
  const latencies = [];
  let errors = 0;
  let connections = 0;
  const started = performance.now();
  const cpuStarted = process.cpuUsage();
  const deadline = started + seconds * 1000;
  async function worker() {
    while (performance.now() < deadline) {
      const start = performance.now();
      await new Promise((resolve) => {
        let settled = false;
        let timer;
        const finish = (ok) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (ok) latencies.push(performance.now() - start);
          else errors++;
          resolve();
        };
        const request = https.get(target, { agent }, (response) => {
          let size = 0;
          const chunks = [];
          response.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
              finish(false);
              response.destroy();
              request.destroy();
            } else chunks.push(chunk);
          });
          response.on('aborted', () => finish(false));
          response.on('error', () => finish(false));
          response.on('close', () => {
            if (!response.complete) finish(false);
          });
          response.on('end', () =>
            finish(response.statusCode === 200 && validate(Buffer.concat(chunks))),
          );
        });
        request.on('socket', (socket) => {
          if (socket.connecting) connections++;
        });
        request.on('error', () => finish(false));
        timer = setTimeout(() => {
          finish(false);
          request.destroy();
        }, timeoutMs);
      });
    }
  }
  try {
    await Promise.all(Array.from({ length: concurrency }, worker));
    const elapsedMs = performance.now() - started;
    const cpu = process.cpuUsage(cpuStarted);
    return {
      ...summarize(latencies, elapsedMs, errors, connections),
      clientCpuPercent: (cpu.user + cpu.system) / (elapsedMs * 10),
    };
  } finally {
    agent.destroy();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await runLoad(
      process.argv[2],
      Number(process.argv[3] ?? 1),
      Number(process.argv[4] ?? 10),
      JSON.parse(process.argv[5] ?? 'null'),
    );
    console.log(JSON.stringify(result));
    if (result.errors || !result.requests) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
