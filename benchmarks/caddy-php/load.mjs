import https from 'node:https';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

export function summarize(latencies, elapsedMs, errors, connections) {
  latencies.sort((a, b) => a - b);
  const percentile = (p) => latencies[Math.max(0, Math.ceil(latencies.length * p) - 1)] ?? null;
  return {
    requests: latencies.length,
    errors,
    connections,
    elapsedMs,
    requestsPerSecond: latencies.length / (elapsedMs / 1000),
    meanMs: latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
  };
}

export async function runLoad(url, concurrency, seconds) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || !(seconds > 0)) {
    throw new Error('Concurrency must be a positive integer and duration must be positive');
  }
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
        const request = https.get(
          url,
          { agent, servername: 'benchmark', headers: { Host: 'benchmark' } },
          (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => (body += chunk));
            response.on('error', fail);
            response.on('end', () => {
              if (
                response.statusCode === 200 &&
                /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z\n$/.test(body)
              ) {
                latencies.push(performance.now() - start);
              } else {
                errors++;
              }
              resolve();
            });
          },
        );
        let failed = false;
        function fail() {
          if (!failed) errors++;
          failed = true;
          resolve();
        }
        request.on('socket', (socket) => {
          if (socket.connecting) connections++;
        });
        request.setTimeout(5000, () => request.destroy(new Error('Request timed out')));
        request.on('error', fail);
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
  const result = await runLoad(
    process.argv[2],
    Number(process.argv[3] ?? 1),
    Number(process.argv[4] ?? 10),
  );
  console.log(JSON.stringify(result));
  if (result.errors || !result.requests) process.exitCode = 1;
}
