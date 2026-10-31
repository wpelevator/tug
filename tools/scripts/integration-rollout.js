#!/usr/bin/env node
// End-to-end check of rolling deploys and automatic rollback on one privileged fake VPS that runs
// the app and the Caddy ingress. Requests hit the ingress continuously from inside the VPS while:
//   1. v1 is deployed, 2. v2 is rolled out (zero failed requests, an unrelated service is not restarted),
//   3. v3, whose health check fails, is rejected (v2 keeps serving) and rolled back automatically.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const project = process.env.COMPOSE_PROJECT_NAME || 'tug-it-rollout';
const control = process.env.TUG_CONTROL_URL || 'http://localhost:18080';
const token = process.env.TUG_TOKEN || 'integration-token';
const files = [
  '-f',
  'docker-compose.integration.yml',
  '-f',
  'docker-compose.integration-rollout.yml',
];
const composeArgs = ['compose', '-p', project, ...files];
const PROJECT = 'rolldemo';

function docker(args, input) {
  const r = spawnSync('docker', [...composeArgs, ...args], { encoding: 'utf8', input });
  return { ok: r.status === 0, out: (r.stdout || '') + (r.stderr || '') };
}
const vps = (script) => docker(['exec', '-T', 'vps-a', 'sh', '-c', script]);
async function api(route, body) {
  const res = await fetch(`${control}${route}`, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${route}: ${res.status} ${await res.text()}`);
  return res.json();
}
async function until(label, fn, timeoutMs = 180000) {
  const started = Date.now();
  let last = '';
  while (Date.now() - started < timeoutMs) {
    const r = await fn();
    if (r.ok) {
      console.log(`ok: ${label}`);
      return r.out;
    }
    last = r.out;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`FAILED: ${label}\n${last}`);
}

function appCompose(version, { healthPort = 80 } = {}) {
  return {
    'x-tug': { rollback: 'auto' },
    services: {
      web: {
        image: 'nginx:1.27-alpine',
        command: [
          'sh',
          '-c',
          `echo ${version} > /usr/share/nginx/html/index.html && exec nginx -g 'daemon off;'`,
        ],
        ports: ['8080:80'],
        'x-tug': {
          placement: { nodes: ['vps-a'] },
          health: { type: 'http', port: healthPort, path: '/', retries: 4, interval: '1s' },
          ingress: { host: 'rollout.test', port: 80, tls: 'off' },
          rollout: { strategy: 'rolling', drain: '8s' },
        },
      },
      // Not rolling and never changed: its container must survive every rollout untouched.
      cache: {
        image: 'busybox:1.36',
        command: ['sh', '-c', 'while true; do sleep 30; done'],
        'x-tug': { placement: { nodes: ['vps-a'] } },
      },
    },
  };
}
async function deploy(version, options) {
  const out = await api('/api/v1/deployments', {
    project: PROJECT,
    version,
    compose: appCompose(version, options),
  });
  console.log(`deployed ${version} as ${out.deployment.id}`);
  return out.deployment.id;
}
async function waitState(id, wanted) {
  return until(`deployment ${id} is ${wanted}`, async () => {
    const d = await api(`/api/v1/deployments/${id}`);
    if (
      d.state !== wanted &&
      ['succeeded', 'failed', 'cancelled', 'build_failed'].includes(d.state)
    )
      throw new Error(`deployment ${id} ended ${d.state}: ${d.error_message}`);
    return { ok: d.state === wanted, out: JSON.stringify(d) };
  });
}
const webContainers = () =>
  vps(`docker ps --filter label=tug.service=web --format '{{.ID}} {{.Image}} {{.Ports}}'`)
    .out.trim()
    .split('\n')
    .filter(Boolean);
const cacheId = () => vps(`docker ps -q --filter label=tug.service=cache`).out.trim();

// Continuous client: one request every ~50 ms through the Caddy ingress, logged as "<status> <body>".
function startLoad() {
  vps('rm -f /tmp/stop /tmp/requests.log');
  const script = `while [ ! -f /tmp/stop ]; do c=$(curl -s -m 3 -o /tmp/body -w '%{http_code}' -H 'Host: rollout.test' http://127.0.0.1/); echo "$c $(tr -d '\\n' < /tmp/body 2>/dev/null)" >> /tmp/requests.log; sleep 0.05; done`;
  docker(['exec', '-T', '-d', 'vps-a', 'sh', '-c', script]);
}
function stopLoad() {
  vps('touch /tmp/stop');
  return vps('sleep 1; cat /tmp/requests.log').out.trim().split('\n').filter(Boolean);
}
const bodies = (lines) => new Set(lines.map((l) => l.split(' ').slice(1).join(' ')));

// CI prebuilds the images with a layer cache and sets TUG_COMPOSE_BUILD="" to skip the rebuild.
docker([
  'up',
  '-d',
  ...(process.env.TUG_COMPOSE_BUILD ?? '--build').split(' ').filter(Boolean),
  'control',
  'registry',
  'provisioner',
  'vps-a',
]);
try {
  await until('control is healthy', async () => ({
    ok: await fetch(`${control}/healthz`).then(
      (r) => r.ok,
      () => false,
    ),
    out: 'not ready',
  }));
  await until('vps-a registered and polling', async () => {
    const nodes = (await api('/api/v1/nodes')).nodes;
    return {
      ok: nodes.some((n) => n.name === 'vps-a' && n.status === 'online'),
      out: JSON.stringify(nodes),
    };
  });

  // ---- v1 ---------------------------------------------------------------------------------------
  await waitState(await deploy('v1'), 'succeeded');
  await until('ingress serves v1', async () => {
    const r = vps(`curl -fsS -m 5 -H 'Host: rollout.test' http://127.0.0.1/`);
    return { ok: r.ok && r.out.trim() === 'v1', out: r.out };
  });
  const cache = cacheId();
  assert.ok(cache, 'the recreated cache service runs');
  assert.equal(webContainers().length, 1, 'exactly one web container after the first deploy');

  // ---- v2: zero-downtime rollout ----------------------------------------------------------------
  startLoad();
  await until('requests are flowing', async () => {
    const r = vps('wc -l < /tmp/requests.log');
    return { ok: Number(r.out.trim()) > 20, out: r.out };
  });
  await waitState(await deploy('v2'), 'succeeded');
  await until('ingress serves v2', async () => ({
    ok: vps(`tail -n 5 /tmp/requests.log`)
      .out.split('\n')
      .filter(Boolean)
      .every((l) => l.endsWith(' v2')),
    out: vps('tail -n 5 /tmp/requests.log').out,
  }));
  await until('the old revision is removed after the drain', async () => {
    const c = webContainers();
    return { ok: c.length === 1, out: c.join('\n') };
  });
  const rollout = stopLoad();
  const failed = rollout.filter((l) => !l.startsWith('200 '));
  assert.ok(
    rollout.length > 100,
    `enough requests were made during the rollout (${rollout.length})`,
  );
  assert.deepEqual(failed, [], 'no request failed while v2 rolled out');
  assert.deepEqual([...bodies(rollout)].sort(), ['v1', 'v2'], 'traffic moved from v1 to v2');
  assert.equal(cacheId(), cache, 'the unrelated recreate service was not restarted by the rollout');
  console.log(`ok: ${rollout.length} requests during the v2 rollout, none failed`);

  // ---- v3: failing health check, automatic rollback ---------------------------------------------
  const before = webContainers();
  startLoad();
  await until('requests are flowing again', async () => {
    const r = vps('wc -l < /tmp/requests.log');
    return { ok: Number(r.out.trim()) > 20, out: r.out };
  });
  const v3 = await deploy('v3', { healthPort: 9999 });
  await waitState(v3, 'failed');
  await until('control recorded the automatic rollback', async () => {
    const events = (await api(`/api/v1/events?project=${PROJECT}&limit=100`)).events;
    const e = events.find((ev) => ev.type === 'deployment.auto_rollback');
    return { ok: Boolean(e), out: JSON.stringify(events.map((ev) => ev.type)) };
  });
  const status = await api('/api/v1/status');
  const current = status.deployments.find(
    (d) => d.project_id === PROJECT && d.version.startsWith('rollback-v2-'),
  );
  assert.ok(current, 'a rollback deployment to v2 exists');
  await waitState(current.id, 'succeeded');
  await until('only the v2 web container remains', async () => {
    const c = webContainers();
    return {
      ok: c.length === 1 && c[0].split(' ')[0] === before[0].split(' ')[0],
      out: c.join('\n'),
    };
  });
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const rejected = stopLoad();
  assert.deepEqual(
    rejected.filter((l) => !l.startsWith('200 ')),
    [],
    'no request failed while v3 was rejected and rolled back',
  );
  assert.deepEqual(
    [...bodies(rejected)],
    ['v2'],
    'v3 never received traffic; v2 served throughout',
  );
  assert.equal(cacheId(), cache, 'the unrelated recreate service was still not restarted');
  console.log(`ok: ${rejected.length} requests while v3 was rejected, all served by v2`);
  console.log('rollout integration test passed');
} catch (error) {
  console.error(error);
  console.error(docker(['logs', '--no-color', '--tail', '200', 'vps-a', 'control']).out);
  process.exitCode = 1;
} finally {
  if (process.env.KEEP_INTEGRATION_STACK !== 'true') docker(['down', '-v', '--remove-orphans']);
}
