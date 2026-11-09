import test from 'node:test';
import assert from 'node:assert/strict';
import { healthyStatus, staleBackup } from '../../../tests/tui-fixtures.ts';
import type { Api } from './actions.ts';
import { Poller } from './poller.ts';
import { emptySnapshot } from './types.ts';

/** An API that answers from a table and records every route asked, so a test can say what was and was not requested. */
function fakeApi(routes: Record<string, (route: string) => unknown>) {
  const asked: string[] = [];
  const api: Api = {
    async request<T>(method: string, route: string): Promise<T> {
      asked.push(`${method} ${route}`);
      const handler = Object.entries(routes).find(([prefix]) => route.startsWith(prefix))?.[1];
      if (!handler) throw new Error(`${method} ${route}: 404 not found`);
      const value = handler(route);
      if (value instanceof Error) throw value;
      return value as T;
    },
    sleep: async () => {},
  };
  return { api, asked };
}
const admin = { name: 'root', role: 'admin', projects: null };
const baseRoutes = (): Record<string, () => unknown> => ({
  '/api/v1/whoami': () => admin,
  '/api/v1/version': () => ({ v: '1.2.0' }),
  '/api/v1/status': () => healthyStatus(),
  '/api/v1/events': () => ({ events: [] }),
  '/api/v1/backups': () => staleBackup,
  '/api/v1/restores': () => ({ restores: [] }),
  '/api/v1/nodes': () => ({ nodes: [] }),
  '/api/v1/diagnostics': () => ({ ok: true, checks: [] }),
});

test('one pass fills every feed, asking for backups and restores per project', async () => {
  const { api, asked } = fakeApi(baseRoutes());
  const snapshot = emptySnapshot();
  await new Poller(api, snapshot, () => {}).pollOnce();
  assert.equal(snapshot.whoami.data?.role, 'admin', 'whoami is recorded');
  assert.equal(snapshot.version.data, '1.2.0', 'the control version is recorded');
  assert.equal(snapshot.status.data?.projects.length, 2, 'status is recorded');
  assert.deepEqual(
    Object.keys(snapshot.backups.data ?? {}).sort(),
    ['blog', 'site'],
    'backups are fetched for each project',
  );
  assert.ok(
    asked.some((route) => route.includes('/api/v1/backups?project=site')),
    'the project is a query parameter',
  );
  assert.ok(snapshot.status.fetchedAt, 'every feed records when it was fetched');
});

test('a failed poll keeps the last data and records the error beside it', async () => {
  let fail = false;
  const routes = baseRoutes();
  routes['/api/v1/status'] = () =>
    fail ? new Error('GET /api/v1/status: could not reach control') : healthyStatus();
  const { api } = fakeApi(routes);
  const snapshot = emptySnapshot();
  const poller = new Poller(api, snapshot, () => {});
  await poller.pollOnce();
  const before = snapshot.status.data;
  fail = true;
  await poller.refresh();
  assert.equal(snapshot.status.data, before, 'the last good data stays available');
  assert.match(
    snapshot.status.error ?? '',
    /could not reach control/,
    'the error is recorded so the screen can say the data is old',
  );
  fail = false;
  await poller.refresh();
  assert.equal(snapshot.status.error, undefined, 'recovery clears the error');
});

test('the first poll rejects when control never answered, so --once can fail', async () => {
  const routes = baseRoutes();
  routes['/api/v1/status'] = () => new Error('GET /api/v1/status: could not reach control');
  const { api } = fakeApi(routes);
  await assert.rejects(
    new Poller(api, emptySnapshot(), () => {}).pollOnce(),
    /could not reach control/,
    'no data at all is an error, not an empty fleet',
  );
});

test('a credential below admin never asks for nodes or diagnostics', async () => {
  const routes = baseRoutes();
  routes['/api/v1/whoami'] = () => ({ name: 'viewer', role: 'read', projects: ['site'] });
  const { api, asked } = fakeApi(routes);
  await new Poller(api, emptySnapshot(), () => {}).pollOnce();
  assert.ok(
    !asked.some((route) => route.includes('/nodes') || route.includes('/diagnostics')),
    'admin-only routes are not requested by a read credential',
  );
});

test('an admin-only feed that answers 403 is switched off for good', async () => {
  const routes = baseRoutes();
  routes['/api/v1/whoami'] = () => new Error('GET /api/v1/whoami: 404 not found');
  routes['/api/v1/nodes'] = () =>
    new Error('GET /api/v1/nodes: 403 {"error":"requires the admin role"}');
  const { api, asked } = fakeApi(routes);
  const poller = new Poller(api, emptySnapshot(), () => {});
  await poller.pollOnce();
  await poller.refresh();
  assert.equal(
    asked.filter((route) => route.endsWith('/api/v1/nodes')).length,
    1,
    'after a 403 the nodes route is not asked again',
  );
});

test('on-demand lists load into the snapshot under their view and project', async () => {
  const routes = baseRoutes();
  routes['/api/v1/domains'] = () => ({ domains: [{ host: 'a.example.com', service: 'web' }] });
  const { api, asked } = fakeApi(routes);
  const snapshot = emptySnapshot();
  const poller = new Poller(api, snapshot, () => {}, {
    status: 1e6,
    events: 1e6,
    slow: 1e6,
    diagnostics: 1e6,
    lists: 1e6,
  });
  await poller.load({ name: 'domains', project: 'blog' });
  poller.stop();
  assert.deepEqual(
    snapshot.lists['domains:blog'].data,
    [{ host: 'a.example.com', service: 'web' }],
    'the rows are stored under view:project',
  );
  assert.ok(asked.includes('GET /api/v1/domains?project=blog'), 'the project is sent as a query');
});

test('starting and stopping leaves no timers behind', async () => {
  const { api } = fakeApi(baseRoutes());
  const snapshot = emptySnapshot();
  let changes = 0;
  const poller = new Poller(api, snapshot, () => changes++, {
    status: 20,
    events: 20,
    slow: 20,
    diagnostics: 20,
    lists: 20,
  });
  poller.start();
  await new Promise((resolve) => setTimeout(resolve, 120));
  poller.stop();
  const after = changes;
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(after > 3, 'polling repeats while started');
  assert.equal(changes, after, 'nothing is fetched after stop');
});
