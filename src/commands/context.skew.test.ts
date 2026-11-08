import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { createServer } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Pki, serverNames, identityUri } from '../pki.ts';
import type { Credential } from '../pki.ts';
import { serverTlsOptions } from '../tls-server.ts';
import { packageVersion } from '../image.ts';
import { compareCompat, majorMinor } from '../protocol.ts';
import { resetVersionChecks, request, setResolvedConfig } from './context.ts';
import type { ResolvedCliConfig } from '../cli-config.ts';

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

async function configure(f: Fixture): Promise<void> {
  setResolvedConfig({
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
  } as unknown as ResolvedCliConfig);
  resetVersionChecks();
}

const warnings: string[] = [];
const unmutatedWarning = console.error;
const speak = (): void => {
  console.error = unmutatedWarning;
};
const quiet = (): void => {
  console.error = (message?: unknown) => {
    warnings.push(String(message));
  };
};

/**
 * A version the current CLI must treat as an older, incompatible control. Only a different compatibility key is
 * breaking (the major from 1.0, `0.minor` before it), so a stale stamp is the previous major once the package is 1.x:
 * an older minor of the same major is compatible and would not be refused.
 */
const staleVersion = (): string => {
  const [major, minor] = packageVersion().split('.').map(Number);
  if (major > 0) return `${major - 1}.0.0`;
  if (minor > 0) return `0.${minor - 1}.0`;
  throw new Error('no older compatibility key exists below 0.0');
};

test('the stale version used by these tests is older than the current CLI under the skew rule', () => {
  const stale = majorMinor(staleVersion());
  const current = majorMinor(packageVersion());
  assert.ok(stale && current, 'both versions parse');
  assert.equal(
    compareCompat(stale, current),
    -1,
    'the helper stays incompatible across minor and patch releases, so the refusal tests keep testing a refusal',
  );
});

test('a read-first command gets its skew judged off the response stamp, with no extra probe', async () => {
  const f = await startFixture({ stamp: packageVersion() });
  await configure(f);
  quiet();
  try {
    await request('GET', '/api/v1/status');
    assert.deepEqual(
      f.hits.map((h) => h.route),
      ['/api/v1/status'],
      'the stamped response removes the dedicated version request read commands used to pay',
    );
    assert.deepEqual(
      f.hits.map((h) => h.clientVersion),
      [packageVersion()],
      'every request declares the calling CLI version for the control-side guard',
    );
    assert.deepEqual(warnings, [], 'matching versions stay silent');
    // The agreement is remembered for the process; a later mutation pays no probe either.
    await request('POST', '/api/v1/deployments', { project: 'site' });
    assert.deepEqual(
      f.hits.map((h) => h.route),
      ['/api/v1/status', '/api/v1/deployments'],
      'a mutation that follows a judged read skips the probe',
    );
  } finally {
    speak();
    await f.close();
    resetVersionChecks();
  }
});

test('a stale stamp or stampless control refuses the read-first command with the upgrade command', async () => {
  for (const stamp of [undefined, staleVersion()]) {
    const label = stamp === undefined ? 'a stampless control' : `a stale stamp (${stamp})`;
    const f = await startFixture({ stamp });
    await configure(f);
    try {
      await assert.rejects(
        request('GET', '/api/v1/status'),
        /tug control setup <control host> --yes/,
        `${label} is refused, from the response the read already paid for`,
      );
      assert.deepEqual(
        f.hits.map((h) => h.route),
        ['/api/v1/status'],
        'no version route was probed: the verdict came from the read itself',
      );
    } finally {
      await f.close();
      resetVersionChecks();
    }
  }
});

test('a control on a newer patch is compatible and stays silent', async () => {
  const [major, minor, patch] = packageVersion().split('.').map(Number);
  const f = await startFixture({ stamp: `${major}.${minor}.${(patch || 0) + 1}` });
  await configure(f);
  quiet();
  try {
    await request('GET', '/api/v1/status');
    await request('GET', '/api/v1/status');
    assert.deepEqual(warnings, [], 'a patch never changes the wire, so no pin warning is printed');
  } finally {
    speak();
    await f.close();
    resetVersionChecks();
  }
});

test('a mutating first request is probed against the version route before it is sent', async () => {
  // Equal: probe then deploy succeeds. Stale and stampless: probe refuses, the deployment route never sees the POST.
  for (const scenario of [
    { stamp: packageVersion(), expected: ['/api/v1/version', '/api/v1/deployments'] },
    { stamp: staleVersion(), expected: ['/api/v1/version'] },
    { stamp: undefined, noDeploymentRoute: true, expected: ['/api/v1/version'] },
  ]) {
    const f = await startFixture(scenario);
    await configure(f);
    try {
      if (scenario.expected.length === 2)
        await assert.doesNotReject(
          request('POST', '/api/v1/deployments', { project: 'site' }),
          'a compatible control receives the mutation',
        );
      else
        await assert.rejects(
          request('POST', '/api/v1/deployments', { project: 'site' }),
          /tug control setup <control host> --yes/,
          'an older control is refused before it received the mutation',
        );
      assert.deepEqual(
        f.hits.map((h) => h.route),
        scenario.expected,
        'the probe judged the mutation request first; a refusing control never received it',
      );
    } finally {
      await f.close();
      resetVersionChecks();
    }
  }
});

test("the control's own skew refusal is surfaced verbatim, on read and mutation alike", async () => {
  // The real middleware refuses every request from a newer client with `skew: 'client-newer'`; whichever path sees
  // the refusal first must carry the control's wording to the operator, not replace it with a synthesized one.
  const controlError = 'this client (test) is newer than the control running own: fix it now';
  const refusal = await (async () => {
    const f = await startFixture({ stamp: packageVersion(), refuseAll: controlError });
    await configure(f);
    try {
      return await request('GET', '/api/v1/status').then(
        () => null,
        (e) => String((e as Error).message),
      );
    } finally {
      await f.close();
      resetVersionChecks();
    }
  })();
  const mutationRefusal = await (async () => {
    const f = await startFixture({ stamp: packageVersion(), refuseAll: controlError });
    await configure(f);
    try {
      return await request('POST', '/api/v1/deployments', { project: 'site' }).then(
        () => null,
        (e) => String((e as Error).message),
      );
    } finally {
      await f.close();
      resetVersionChecks();
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
  const f = await startFixture({ stamp: staleVersion() });
  await configure(f);
  try {
    for (const attempt of [1, 2])
      await assert.rejects(
        request('GET', '/api/v1/status'),
        /tug control setup <control host> --yes/,
        `attempt ${attempt} against a stale control is refused: a refusal must not be remembered as agreement`,
      );
  } finally {
    await f.close();
    resetVersionChecks();
  }
});
