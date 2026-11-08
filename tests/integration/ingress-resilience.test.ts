import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DEFAULT_CADDY_IMAGE, renderCaddyfile } from '../../src/ingress.ts';

// Runs the stock Caddy image against the Caddyfile Tug renders, with the upstream on the Docker host, to
// check the behavior the directives are there for rather than that Caddy parses them.

const docker = (...args: string[]) => spawnSync('docker', args, { encoding: 'utf8' });
const HAVE_DOCKER = docker('info').status === 0;
const HOST = 'resilience.test';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

function caddyfile(
  upstreamPort: number | null,
  mutate: (text: string) => string = (t) => t,
  accessLog = false,
): string {
  return mutate(
    renderCaddyfile(
      [
        {
          project: 'p',
          service: 's',
          host: HOST,
          tls: 'off',
          upstreams: upstreamPort === null ? [] : [`host.docker.internal:${upstreamPort}`],
        },
      ],
      { accessLog },
    ),
  );
}

interface Edge {
  port: number;
  name: string;
  reload(text: string): Promise<void>;
  stop(): void;
}

async function startCaddy(dir: string, text: string): Promise<Edge> {
  await fs.writeFile(path.join(dir, 'Caddyfile'), text);
  const port = await freePort();
  const name = `tug-resilience-${process.pid}-${port}`;
  const run = docker(
    'run',
    '-d',
    '--rm',
    '--name',
    name,
    '--add-host',
    'host.docker.internal:host-gateway',
    '-p',
    `127.0.0.1:${port}:80`,
    '-v',
    `${dir}:/etc/caddy`,
    process.env.TUG_CADDY_IMAGE || DEFAULT_CADDY_IMAGE,
  );
  assert.equal(run.status, 0, `caddy container starts: ${run.stderr}`);
  // Docker accepts the published port before Caddy listens, so wait for an HTTP answer to an unrouted host.
  for (let i = 0; i < 100; i++) {
    if ((await get(port, '/', 'ready.test')).status !== undefined) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    port,
    name,
    async reload(next) {
      // Same container, new file: Caddy swaps to a fresh config exactly as the agent's reload does.
      await fs.writeFile(path.join(dir, 'Caddyfile'), next);
      const r = docker('exec', name, 'caddy', 'reload', '--config', '/etc/caddy/Caddyfile');
      assert.equal(r.status, 0, `caddy reload succeeds: ${r.stderr}`);
    },
    stop() {
      docker('rm', '-f', name);
    },
  };
}

/** One GET through the edge for `HOST`; resolves with the status and body, or the transport error. */
function get(
  port: number,
  url: string,
  host = HOST,
): Promise<{
  status?: number;
  body: string;
  error?: string;
  headers?: http.IncomingHttpHeaders;
}> {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: url, headers: { host } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
      res.on('aborted', () => resolve({ status: res.statusCode, body, error: 'aborted' }));
      res.on('error', (e) => resolve({ status: res.statusCode, body, error: e.message }));
    });
    req.on('error', (e) => resolve({ body: '', error: e.message }));
    req.end();
  });
}

test(
  'a request that arrives while the upstream is down waits for it instead of failing with a 502',
  { skip: !HAVE_DOCKER && 'Docker is not available', timeout: 60000 },
  async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-resilience-'));
    const upstreamPort = await freePort();
    const edge = await startCaddy(dir, caddyfile(upstreamPort));
    const upstream = http.createServer((_req, res) => res.end('hello'));
    t.after(async () => {
      edge.stop();
      upstream.closeAllConnections();
      upstream.close();
      await fs.rm(dir, { recursive: true, force: true });
    });

    // The service restarts: nothing listens for the first second, then it comes up.
    setTimeout(() => upstream.listen(upstreamPort, '0.0.0.0'), 1000);
    const res = await get(edge.port, '/');
    assert.equal(
      res.status,
      200,
      `a request during a short upstream outage is retried and served: ${JSON.stringify(res)}`,
    );
    assert.equal(res.body, 'hello', 'the retried request reaches the upstream that came back');

    const noRetryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-resilience-'));
    const noRetry = await startCaddy(
      noRetryDir,
      caddyfile(await freePort(), (text) => text.replace(/\t\tlb_try_duration .*\n/, '')),
    );
    t.after(async () => {
      noRetry.stop();
      await fs.rm(noRetryDir, { recursive: true, force: true });
    });
    const failed = await get(noRetry.port, '/');
    assert.equal(
      failed.status,
      502,
      'without lb_try_duration the same outage is an immediate 502, so the retry test above proves the directive works',
    );
  },
);

test(
  'a WebSocket stays open when the config is reloaded because stream_close_delay holds it',
  { skip: !HAVE_DOCKER && 'Docker is not available', timeout: 90000 },
  async (t) => {
    const upstreamPort = await freePort();
    const upstream = http.createServer();
    // A minimal upgrade endpoint: after the 101 Caddy only tunnels bytes, so raw lines stand in for frames.
    upstream.on('upgrade', (_req, socket) => {
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
      );
      let n = 0;
      const timer = setInterval(() => {
        socket.write(`chunk${++n}\n`);
        if (n === 20) {
          clearInterval(timer);
          socket.end('done\n');
        }
      }, 200);
      socket.on('close', () => clearInterval(timer));
      socket.on('error', () => {});
    });
    await new Promise<void>((r) => upstream.listen(upstreamPort, '0.0.0.0', r));
    t.after(() => {
      upstream.closeAllConnections();
      upstream.close();
    });

    const websocketAcrossReload = async (mutate: (text: string) => string) => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-resilience-'));
      const edge = await startCaddy(dir, caddyfile(upstreamPort, mutate));
      t.after(async () => {
        edge.stop();
        await fs.rm(dir, { recursive: true, force: true });
      });
      const received = new Promise<string>((resolve) => {
        const req = http.request({
          host: '127.0.0.1',
          port: edge.port,
          path: '/',
          headers: { host: HOST, connection: 'Upgrade', upgrade: 'websocket' },
        });
        req.on('upgrade', (_res, socket) => {
          let body = '';
          socket.on('data', (c) => (body += c));
          socket.on('close', () => resolve(body));
          socket.on('error', () => resolve(body));
        });
        req.on('error', () => resolve(''));
        req.end();
      });
      await new Promise((r) => setTimeout(r, 1000));
      // An unrelated site changing: the new Caddyfile has an extra route, as after another project's deploy.
      await edge.reload(
        `${caddyfile(upstreamPort, mutate)}\nhttp://other.test {\n\trespond "other"\n}\n`,
      );
      return received;
    };

    const held = await websocketAcrossReload((text) => text);
    assert.match(
      held,
      /done\n$/,
      `the WebSocket survives a reload and finishes: ${JSON.stringify(held)}`,
    );

    const cut = await websocketAcrossReload((text) =>
      text.replace(/\t\tstream_close_delay .*\n/, ''),
    );
    assert.match(cut, /chunk1\n/, 'the control connection did open and stream before the reload');
    assert.doesNotMatch(
      cut,
      /done\n$/,
      'without stream_close_delay the reload cuts the WebSocket, which is the problem the directive solves',
    );
  },
);

test(
  'a host without an upstream answers 503 with Retry-After, logs JSON access lines and serves per-host metrics',
  { skip: !HAVE_DOCKER && 'Docker is not available', timeout: 60000 },
  async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-resilience-'));
    const edge = await startCaddy(
      dir,
      caddyfile(null, (text) => text, true),
    );
    t.after(async () => {
      edge.stop();
      await fs.rm(dir, { recursive: true, force: true });
    });

    const res = await get(edge.port, '/anything?token=secret');
    assert.equal(
      res.status,
      503,
      'a host with no serving upstream answers 503, not a connection failure',
    );
    assert.equal(res.headers?.['retry-after'], '5', 'clients are told when to retry');
    assert.equal(res.headers?.['cache-control'], 'no-store', 'a CDN does not cache the outage');
    assert.match(res.body, /temporarily unavailable/, 'the body is the fixed unavailable text');

    const logs = docker('logs', edge.name);
    const access = (logs.stdout + logs.stderr)
      .split('\n')
      .filter((l) => l.startsWith('{') && l.includes('http.log.access'))
      .map((l) => JSON.parse(l));
    const line = access.find((l) => l.request?.host === HOST);
    assert.ok(line, 'the request produced a JSON access log line on the container output');
    assert.equal(line.status, 503, 'the access log records the response status');

    const metrics = docker('exec', edge.name, 'wget', '-qO-', 'http://127.0.0.1:2019/metrics');
    assert.equal(metrics.status, 0, `the admin endpoint serves metrics: ${metrics.stderr}`);
    assert.match(
      metrics.stdout,
      new RegExp(`caddy_http_requests_total\\{[^}]*host="${HOST.replace('.', '\\.')}"`),
      'request metrics carry a host label',
    );
  },
);

test(
  'the ask endpoint approves exactly one label under a wildcard zone and nothing else',
  { skip: !HAVE_DOCKER && 'Docker is not available', timeout: 60000 },
  async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-resilience-'));
    // Internal CA only: the test must never ask a public ACME server to validate these names.
    const text = renderCaddyfile([
      {
        project: 'p',
        service: 's',
        host: '*.network.example.com',
        tls: 'auto',
        upstreams: ['host.docker.internal:9'],
        aliases: ['mapped.example.org'],
      },
    ]).replace(/^\{\n/, '{\n\tlocal_certs\n\tskip_install_trust\n');
    const edge = await startCaddy(dir, text);
    t.after(async () => {
      edge.stop();
      await fs.rm(dir, { recursive: true, force: true });
    });
    const ask = (domain: string) => {
      const r = docker(
        'exec',
        edge.name,
        'wget',
        '-S',
        '-qO-',
        `http://127.0.0.1:2021/ask?domain=${domain}`,
      );
      return /HTTP\/1\.1 (\d+)/.exec(r.stderr)?.[1];
    };
    for (const [domain, expected, why] of [
      ['site1.network.example.com', '200', 'one label under the zone is approved'],
      ['a-b-2.network.example.com', '200', 'hyphens and digits are valid labels'],
      ['a.b.network.example.com', '403', 'a deeper name is not covered by a single-label wildcard'],
      ['network.example.com', '403', 'the bare zone is not approved'],
      ['evil.com', '403', 'an unrelated domain is refused'],
      ['site1.network.example.com.evil.com', '403', 'a suffix trick is refused'],
      ['xnetwork.example.com', '403', 'the dot before the zone is not optional'],
      [
        'mapped.example.org',
        '403',
        'a mapped domain is an explicit site and never needs the ask endpoint',
      ],
    ] as const)
      assert.equal(ask(domain), expected, `${domain}: ${why}`);
  },
);

test(
  'a mapped domain is served from the same upstream as the route it is attached to',
  { skip: !HAVE_DOCKER && 'Docker is not available', timeout: 60000 },
  async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-resilience-'));
    const upstreamPort = await freePort();
    const upstream = http.createServer((req, res) => res.end(`upstream saw ${req.headers.host}`));
    await new Promise<void>((r) => upstream.listen(upstreamPort, '0.0.0.0', r));
    const edge = await startCaddy(
      dir,
      renderCaddyfile([
        {
          project: 'p',
          service: 's',
          host: HOST,
          tls: 'off',
          upstreams: [`host.docker.internal:${upstreamPort}`],
          aliases: ['mapped.example.org'],
        },
      ]),
    );
    t.after(async () => {
      edge.stop();
      upstream.closeAllConnections();
      upstream.close();
      await fs.rm(dir, { recursive: true, force: true });
    });
    for (const host of [HOST, 'mapped.example.org'])
      assert.equal(
        (await get(edge.port, '/', host)).body,
        `upstream saw ${host}`,
        `${host} reaches the route's upstream with its own Host header`,
      );
    assert.notEqual(
      (await get(edge.port, '/', 'unmapped.example.org')).body,
      'upstream saw unmapped.example.org',
      'a name that is not mapped does not reach the upstream',
    );
  },
);
