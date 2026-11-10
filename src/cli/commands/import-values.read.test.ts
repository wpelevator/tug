import test from 'node:test';
import assert from 'node:assert/strict';
import { loadExistingNames } from './import-values.ts';
import type { request } from './context.ts';

test('import reads secret and variable names one request after the other, never both in flight', async () => {
  const routes: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const get = (async (_method: string, route: string) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    routes.push(route.split('?')[0]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight--;
    if (route.startsWith('/api/v1/secrets')) return { secrets: [{ name: 'API_KEY' }] };
    return { vars: [{ name: 'GREETING' }] };
  }) as unknown as typeof request;

  const names = await loadExistingNames(get, 'site');

  assert.equal(maxInFlight, 1, 'at most one control request may be in flight from an import');
  assert.deepEqual(
    routes,
    ['/api/v1/secrets', '/api/v1/vars'],
    'the variables are requested after the secrets, in that order',
  );
  assert.deepEqual(names.secrets, [{ name: 'API_KEY' }], 'the secret names are returned');
  assert.deepEqual(names.vars, [{ name: 'GREETING' }], 'the variable names are returned');
});
