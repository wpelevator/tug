import test from 'node:test';
import assert from 'node:assert/strict';
import { loadDeployValues } from './deploy.ts';
import type { request } from './context.ts';

test('deploy reads secrets and variables one request after the other, never both in flight', async () => {
  const events: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const get = (async (_method: string, route: string) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    events.push(`start ${route}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    events.push(`end ${route}`);
    inFlight--;
    if (route.startsWith('/api/v1/secrets')) return { secrets: [{ name: 'API_KEY' }] };
    return { vars: [{ name: 'GREETING', version: 1, value: 'hi' }] };
  }) as unknown as typeof request;

  const values = await loadDeployValues(get, 'site');

  assert.equal(maxInFlight, 1, 'at most one control request may be in flight from a deploy');
  assert.deepEqual(
    events.map((e) => e.split(' ')[0] + ' ' + e.split(' ')[1].split('?')[0]),
    [
      'start /api/v1/secrets',
      'end /api/v1/secrets',
      'start /api/v1/vars/values',
      'end /api/v1/vars/values',
    ],
    'the variables are requested only after the secrets have come back',
  );
  assert.deepEqual(values.secrets, [{ name: 'API_KEY' }], 'the secrets are returned');
  assert.deepEqual(
    values.vars,
    [{ name: 'GREETING', version: 1, value: 'hi' }],
    'the variable values are returned',
  );
});
