import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTIONS, actionByKey, roleAllows, runAction } from './actions.ts';
import type { Api } from './actions.ts';

function fakeApi(responses: Record<string, unknown[] | ((body: unknown) => unknown)>) {
  const calls: { method: string; route: string; body?: unknown }[] = [];
  const api: Api = {
    async request<T>(method: string, route: string, body?: unknown): Promise<T> {
      calls.push({ method, route, body });
      const next = responses[`${method} ${route}`];
      if (!next) throw new Error(`${method} ${route}: 404 not found`);
      const value =
        typeof next === 'function' ? next(body) : next.length > 1 ? next.shift() : next[0];
      if (value instanceof Error) throw value;
      return value as T;
    },
    sleep: async () => {},
  };
  return { api, calls };
}
const action = (key: string) => actionByKey(key)!;

test('roles are cumulative and an unknown role may try', () => {
  assert.equal(roleAllows('read', 'deploy'), false, 'read cannot deploy');
  assert.equal(roleAllows('deploy', 'deploy'), true, 'deploy can deploy');
  assert.equal(roleAllows('admin', 'deploy'), true, 'admin includes deploy');
  assert.equal(roleAllows(undefined, 'admin'), true, 'without a known role the control decides');
});

test('every action has a distinct key and needs the deploy role, like the routes behind them', () => {
  assert.deepEqual(
    new Set(ACTIONS.map((item) => item.key)).size,
    ACTIONS.length,
    'keys must not collide',
  );
  assert.ok(
    ACTIONS.every((item) => item.role === 'deploy'),
    'restart, rollback, cancel and backup are deploy-role routes',
  );
});

test('restart posts the project and service, then waits for the command to succeed', async () => {
  const { api, calls } = fakeApi({
    'POST /api/v1/restart': [{ commandId: 'cmd_1' }],
    'GET /api/v1/commands/cmd_1': [{ state: 'running' }, { state: 'succeeded' }],
  });
  const result = await runAction(action('r'), api, { project: 'site', service: 'web' });
  assert.deepEqual(
    result,
    { ok: true, message: 'restarted site/web' },
    'a restart that succeeds says so',
  );
  assert.deepEqual(
    calls[0].body,
    { project: 'site', service: 'web' },
    'the request names the project and service as the CLI does',
  );
  assert.equal(calls.length, 3, 'the command is polled until it finishes');
});

test('a restart that fails reports the agent’s error instead of throwing', async () => {
  const { api } = fakeApi({
    'POST /api/v1/restart': [{ commandId: 'cmd_1' }],
    'GET /api/v1/commands/cmd_1': [
      { state: 'failed', result_json: JSON.stringify({ error: 'no such container' }) },
    ],
  });
  const result = await runAction(action('r'), api, { project: 'site', service: 'web' });
  assert.deepEqual(
    result,
    { ok: false, message: 'restart failed: no such container' },
    'the failure is returned as a message',
  );
});

test('rollback never forces, so it refuses while a deployment is active exactly as the CLI does', async () => {
  const { api, calls } = fakeApi({
    'POST /api/v1/rollback': [{ deployment: { id: 'dep_9', state: 'rolling_out' } }],
  });
  const result = await runAction(action('R'), api, { project: 'site' });
  assert.equal(
    result.message,
    'rollback of site started as deployment dep_9',
    'the new deployment is named',
  );
  assert.deepEqual(
    calls[0].body,
    { project: 'site', force: false },
    'force is never sent from the screen',
  );
});

test('cancel is offered only for a deployment that has not finished', () => {
  const cancel = action('x');
  assert.ok(
    cancel.unavailable({ project: 'site', deployment: 'dep_1', deploymentState: 'succeeded' }),
    'a finished deployment cannot be cancelled',
  );
  assert.equal(
    cancel.unavailable({ project: 'site', deployment: 'dep_1', deploymentState: 'rolling_out' }),
    undefined,
    'a rolling-out deployment can',
  );
  assert.ok(
    cancel.unavailable({ project: 'site' }),
    'with no deployment selected there is nothing to cancel',
  );
});

test('backup runs one target when a target row is selected and every target otherwise', async () => {
  const { api, calls } = fakeApi({
    'POST /api/v1/backups/run': [{ runs: [{ runId: 'r1', target: 'service:db' }], errors: [] }],
  });
  await runAction(action('b'), api, { project: 'site', backupTarget: 'service:db' });
  assert.deepEqual(
    calls[0].body,
    { project: 'site', targets: ['service:db'] },
    'the selected target is sent',
  );
  await runAction(action('b'), api, { project: 'site' });
  assert.deepEqual(
    calls[1].body,
    { project: 'site', targets: undefined },
    'no target means all targets',
  );
  assert.equal(
    action('b').prompt({ project: 'site' }),
    'Back up every target of site now?',
    'the prompt says what will run',
  );
});

test('a backup request that queues nothing is an error', async () => {
  const { api } = fakeApi({
    'POST /api/v1/backups/run': [{ runs: [], errors: ['no destination'] }],
  });
  const result = await runAction(action('b'), api, { project: 'site' });
  assert.equal(result.ok, false, 'nothing queued is a failure');
  assert.match(result.message, /no destination/, 'the control’s reason is shown');
});
