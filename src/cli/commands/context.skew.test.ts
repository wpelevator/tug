import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { createServer } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Pki, serverNames, identityUri } from '../../pki.ts';
import type { Credential } from '../../pki.ts';
import { serverTlsOptions } from '../../control/tls-server.ts';
import { request } from './context.ts';
import { testRuntime } from '../../../tests/cli-runtime.ts';
import type { ResolvedCliConfig } from '../config.ts';

/**
 * The skew check rides ordinary traffic: a stamping control answers reads without a dedicated probe, while a mutating
 * first request still gets the explicit probe because the refusal must arrive before the mutation is received.
 */
interface Scenario {
  /** Value stamped on every response (and returned as `{ v }` by the version route); undefined = a legacy control. */
  stamp: string | undefined;
  noDeploymentRoute?: boolean;
  /** The control decides the skew itself on every request, the way the real middleware refuses a newer client. */
  refuseAll?: string;
}

interface Fixture {
  hits: { route: string; method: string; clientVersion: string | undefined }[];
  url: string;
  credential: Credential;
  close: () => Promise<void>;
}

function serve(
  scenario: Scenario,
  hits: Fixture['hits'],
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const route = req.url ?? '';
    hits.push({
      route,
      method: req.method ?? '',
      clientVersion: (req.headers['x-tug-client-version'] as string) || undefined,
    });
    const send = (status: number, kind: 'json' | 'text', body: string) => {
      res.statusCode = status;
      if (scenario.stamp !== undefined) res.setHeader('x-tug-version', scenario.stamp);
      res.setHeader('content-type', kind === 'json' ? 'application/json' : 'text/plain');
      res.end(body);
    };
    if (scenario.refuseAll)
      return send(400, 'json', JSON.stringify({ error: scenario.refuseAll, skew: 'client-newer' }));
    if (route === '/api/v1/version') {
      if (scenario.stamp === undefined) return send(404, 'text', 'Cannot GET /api/v1/version');
      return send(200, 'json', JSON.stringify({ v: scenario.stamp }));
    }
    if (route.startsWith('/api/v1/deployments')) {
      if (scenario.noDeploymentRoute) return send(404, 'text', 'Cannot POST /api/v1/deployments');
      return send(200, 'json', JSON.stringify({ deployment: { id: 'd1', state: 'succeeded' } }));
    }
    return send(200, 'json', JSON.stringify({ deployment: { id: 'd0', state: 'succeeded' } }));
  };
}

async function startFixture(scenario: Scenario): Promise<Fixture> {
  const hits: Fixture['hits'] = [];
  const pki = await Pki.load(await fs.mkdtemp(path.join(os.tmpdir(), 'tug-skew-')), true);
  const issued = await pki.issueServer(serverNames('https://localhost:8443'));
  const https = createServer(
    serverTlsOptions({ cert: issued.cert, key: issued.key, ca: pki.caPem }),
    serve(scenario, hits),
  );
  https.listen(0, '127.0.0.1');
  await once(https, 'listening');
  const url = `https://127.0.0.1:${(https.address() as { port: number }).port}`;
  const client = await pki.issueClient(
    identityUri('operator', 'o1'),
    86_400_000,
    'https://localhost:8443',
  );
  return {
    hits,
    url,
    credential: client.credential,
    close: async () => {
      https.closeAllConnections();
      await new Promise<void>((resolve) => https.close(() => resolve()));
    },
  };
}

/** A runtime that reports `CLI_VERSION` and talks to the fixture; it remembers nothing of any other run. */
function configure(f: Fixture) {
  const run = testRuntime({ version: CLI_VERSION });
  run.rt.state.config = {
    file: '/dev/null',
    localFile: '/dev/null',
    fileExists: false,
    controlUrl: f.url,
    credential: f.credential,
    credentialFile: '/dev/null',
    commandDefaults: {},
    nodeDefaults: {},
    nodes: {},
    project: 'site',
  } as unknown as ResolvedCliConfig;
  return run;
}

// Fixed versions, independent of the package's real one: the verdicts depend only on how these relate under the
// skew rule (a different major is breaking from 1.0; an older minor or patch of the same major is compatible).
const CLI_VERSION = '1.4.2';
const OLDER_MAJOR = '0.9.0';
const NEWER_PATCH = '1.4.3';

test('a read-first command gets its skew judged off the response stamp, with no extra probe', async () => {
  const f = await startFixture({ stamp: CLI_VERSION });
  const h = configure(f);
  try {
    await request(h.rt, 'GET', '/api/v1/status');
    assert.deepEqual(
      f.hits.map((h) => h.route),
      ['/api/v1/status'],
      'the stamped response removes the dedicated version request read commands used to pay',
    );
    assert.deepEqual(
      f.hits.map((h) => h.clientVersion),
      [CLI_VERSION],
      'every request declares the calling CLI version for the control-side guard',
    );
    assert.equal(h.stderr(), '', 'matching versions stay silent');
    // The agreement is remembered for the process; a later mutation pays no probe either.
    await request(h.rt, 'POST', '/api/v1/deployments', { project: 'site' });
    assert.deepEqual(
      f.hits.map((h) => h.route),
      ['/api/v1/status', '/api/v1/deployments'],
      'a mutation that follows a judged read skips the probe',
    );
  } finally {
    await f.close();
  }
});

test('a stale stamp or stampless control refuses the read-first command with the upgrade command', async () => {
  for (const stamp of [undefined, OLDER_MAJOR]) {
    const label = stamp === undefined ? 'a stampless control' : `a stale stamp (${stamp})`;
    const f = await startFixture({ stamp });
    const h = configure(f);
    try {
      await assert.rejects(
        request(h.rt, 'GET', '/api/v1/status'),
        /tug control upgrade <control host> --yes/,
        `${label} is refused, from the response the read already paid for`,
      );
      assert.deepEqual(
        f.hits.map((h) => h.route),
        ['/api/v1/status'],
        'no version route was probed: the verdict came from the read itself',
      );
    } finally {
      await f.close();
    }
  }
});

test('a control on a newer patch is compatible and stays silent', async () => {
  const f = await startFixture({ stamp: NEWER_PATCH });
  const h = configure(f);
  try {
    await request(h.rt, 'GET', '/api/v1/status');
    await request(h.rt, 'GET', '/api/v1/status');
    assert.equal(h.stderr(), '', 'a patch never changes the wire, so no pin warning is printed');
  } finally {
    await f.close();
  }
});

test('a mutating first request is probed against the version route before it is sent', async () => {
  // Equal: probe then deploy succeeds. Stale and stampless: probe refuses, the deployment route never sees the POST.
  for (const scenario of [
    { stamp: CLI_VERSION, expected: ['/api/v1/version', '/api/v1/deployments'] },
    { stamp: OLDER_MAJOR, expected: ['/api/v1/version'] },
    { stamp: undefined, noDeploymentRoute: true, expected: ['/api/v1/version'] },
  ]) {
    const f = await startFixture(scenario);
    const h = configure(f);
    try {
      if (scenario.expected.length === 2)
        await assert.doesNotReject(
          request(h.rt, 'POST', '/api/v1/deployments', { project: 'site' }),
          'a compatible control receives the mutation',
        );
      else
        await assert.rejects(
          request(h.rt, 'POST', '/api/v1/deployments', { project: 'site' }),
          /tug control upgrade <control host> --yes/,
          'an older control is refused before it received the mutation',
        );
      assert.deepEqual(
        f.hits.map((h) => h.route),
        scenario.expected,
        'the probe judged the mutation request first; a refusing control never received it',
      );
    } finally {
      await f.close();
    }
  }
});

test("the control's own skew refusal is surfaced verbatim, on read and mutation alike", async () => {
  // The real middleware refuses every request from a newer client with `skew: 'client-newer'`; whichever path sees
  // the refusal first must carry the control's wording to the operator, not replace it with a synthesized one.
  const controlError = 'this client (test) is newer than the control running own: fix it now';
  const refusal = await (async () => {
    const f = await startFixture({ stamp: CLI_VERSION, refuseAll: controlError });
    const h = configure(f);
    try {
      return await request(h.rt, 'GET', '/api/v1/status').then(
        () => null,
        (e) => String((e as Error).message),
      );
    } finally {
      await f.close();
    }
  })();
  const mutationRefusal = await (async () => {
    const f = await startFixture({ stamp: CLI_VERSION, refuseAll: controlError });
    const h = configure(f);
    try {
      return await request(h.rt, 'POST', '/api/v1/deployments', { project: 'site' }).then(
        () => null,
        (e) => String((e as Error).message),
      );
    } finally {
      await f.close();
    }
  })();
  assert.equal(
    refusal,
    controlError,
    'a read answered by the control-side refusal surfaces its exact message',
  );
  assert.equal(
    mutationRefusal,
    controlError,
    "a mutation refused by the probe surfaces the control's exact message too",
  );
});

test('a refused control is judged again on the next request, never waved through', async () => {
  const f = await startFixture({ stamp: OLDER_MAJOR });
  const h = configure(f);
  try {
    for (const attempt of [1, 2])
      await assert.rejects(
        request(h.rt, 'GET', '/api/v1/status'),
        /tug control upgrade <control host> --yes/,
        `attempt ${attempt} against a stale control is refused: a refusal must not be remembered as agreement`,
      );
  } finally {
    await f.close();
  }
});
