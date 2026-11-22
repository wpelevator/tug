import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { EdgeChecks, probeUpstream, runProbes } from './edge-check.ts';

test('probeUpstream passes for a listening port and names the failure for a closed one', async () => {
  const server = net.createServer((s) => s.destroy());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  try {
    assert.deepEqual(
      await probeUpstream('127.0.0.1', port),
      { ok: true },
      'an open port is reachable',
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  const closed = await probeUpstream('127.0.0.1', port);
  assert.equal(closed.ok, false, 'a closed port is not reachable');
  assert.match(
    closed.error ?? '',
    /ECONNREFUSED dialing 127\.0\.0\.1/,
    'the error names the cause and target',
  );
});

test('runProbes answers every probe and keeps going past a failure', async () => {
  const results = await runProbes(
    [
      { id: 'a', host: 'h1', port: 1 },
      { id: 'b', host: 'h2', port: 2 },
    ],
    async (host) => (host === 'h1' ? { ok: false, error: 'nope' } : { ok: true }),
  );
  assert.deepEqual(
    results,
    [
      { id: 'a', ok: false, error: 'nope' },
      { id: 'b', ok: true },
    ],
    'each probe keeps its id and outcome',
  );
});

test('a check with no ingress nodes passes at once and asks nobody', async () => {
  const checks = new EdgeChecks();
  const woken: string[] = [];
  const result = await checks.run(new Map(), 20000, 1000, (n) => woken.push(n));
  assert.deepEqual([result.ok, woken], [true, []], 'nothing to ask means nothing to wait for');
});

test('a check waits for every node and sorts the answers into reached, failed and unchecked', async () => {
  const checks = new EdgeChecks();
  const woken: string[] = [];
  const run = checks.run(
    new Map([
      ['e1', '10.0.0.2'],
      ['e2', '10.0.0.2'],
      ['e3', '10.0.0.2'],
    ]),
    20001,
    80,
    (n) => woken.push(n),
  );
  assert.deepEqual(woken, ['e1', 'e2', 'e3'], 'every ingress node is woken to fetch its probe');
  const probe = checks.pendingFor('e1')[0];
  assert.deepEqual(
    [probe.host, probe.port],
    ['10.0.0.2', 20001],
    'the probe names the app address and port',
  );
  checks.onResults('e1', [{ id: probe.id, ok: true }]);
  assert.equal(checks.pendingFor('e1').length, 0, 'an answered node has nothing pending');
  checks.onResults('e2', [{ id: checks.pendingFor('e2')[0].id, ok: false, error: 'refused' }]);
  const result = await run;
  assert.deepEqual(
    [result.ok, result.reached, result.failed, result.unchecked],
    [false, ['e1'], [{ node: 'e2', error: 'refused' }], ['e3']],
    'the silent node is unchecked and only the failure closes the gate',
  );
  assert.equal(checks.pendingFor('e3').length, 0, 'a finished check leaves nothing pending');
});
