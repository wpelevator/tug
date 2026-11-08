import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDb } from './db.ts';
import {
  activeStates,
  advance,
  advanceWhere,
  canMove,
  defineLifecycle,
  isTerminal,
  statesOf,
  terminalStates,
} from './lifecycle.ts';
import {
  backupRunLifecycle,
  buildLifecycle,
  commandLifecycle,
  deploymentLifecycle,
  restoreLifecycle,
  RESTORE_LOCKED_STATES,
} from './lifecycles.ts';
import { ACTIVE_DEPLOYMENT_STATES, TERMINAL_DEPLOYMENT_STATES } from '../protocol.ts';
import { nodeStatus } from '../control/diagnostics.ts';

const lifecycles = [
  deploymentLifecycle,
  commandLifecycle,
  backupRunLifecycle,
  restoreLifecycle,
  buildLifecycle,
] as const;

test('every lifecycle only moves to declared states and starts in a declared state', () => {
  for (const lifecycle of lifecycles) {
    const states = statesOf(lifecycle as never) as string[];
    for (const initial of lifecycle.initial)
      assert.ok(states.includes(initial), `${lifecycle.name}: initial ${initial} is a state`);
    for (const [from, targets] of Object.entries(lifecycle.transitions))
      for (const to of targets as readonly string[])
        assert.ok(states.includes(to), `${lifecycle.name}: ${from} -> ${to} targets a state`);
  }
});

test('every state of a lifecycle is reachable from an initial state', () => {
  for (const lifecycle of lifecycles) {
    const seen = new Set<string>(lifecycle.initial);
    const queue = [...lifecycle.initial] as string[];
    while (queue.length) {
      const from = queue.pop()!;
      for (const to of (lifecycle.transitions as Record<string, readonly string[]>)[from])
        if (!seen.has(to)) {
          seen.add(to);
          queue.push(to);
        }
    }
    assert.deepEqual(
      [...seen].sort(),
      (statesOf(lifecycle as never) as string[]).sort(),
      `${lifecycle.name}: no state is dead, so a state that is never written cannot be declared`,
    );
  }
});

test('defineLifecycle rejects a table that moves to an undeclared state', () => {
  assert.throws(
    () =>
      defineLifecycle({
        name: 'broken',
        table: 'commands',
        column: 'state',
        initial: ['a'],
        transitions: { a: ['b' as 'a'] },
      }),
    /undeclared state b/,
    'a typo in a transition table fails when the module loads',
  );
});

test('deployment states: busy states can still change and finished ones cannot', () => {
  assert.deepEqual([...ACTIVE_DEPLOYMENT_STATES], ['building', 'rolling_out']);
  assert.deepEqual(
    [...TERMINAL_DEPLOYMENT_STATES].sort(),
    ['build_failed', 'cancelled', 'failed', 'succeeded'],
    'the CLI wait loop stops on exactly the states with no exits',
  );
  assert.equal(isTerminal(deploymentLifecycle, 'succeeded'), true);
  assert.equal(
    canMove(deploymentLifecycle, 'succeeded', 'rolling_out'),
    false,
    'a finished deployment never restarts',
  );
});

test('a locked restore state is never a finished one', () => {
  for (const state of RESTORE_LOCKED_STATES)
    assert.equal(isTerminal(restoreLifecycle, state), false, `${state} keeps the project locked`);
  assert.deepEqual(terminalStates(restoreLifecycle).sort(), ['failed', 'released', 'succeeded']);
  assert.ok(activeStates(restoreLifecycle).includes('verifying'), 'verifying is not terminal');
});

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-lifecycle-'));
  const db = await openDb(path.join(dir, 'tug.db'));
  const insert = (rowId: string, state: string, node = 'n1') =>
    db.run(
      'INSERT INTO commands(id,node_id,type,state,attempts) VALUES(?,?,?,?,0)',
      rowId,
      node,
      'x',
      state,
    );
  const stateOf = (rowId: string) =>
    db.get<{ state: string }>('SELECT state FROM commands WHERE id=?', rowId)?.state;
  return { db, insert, stateOf, close: () => db.close() };
}

test('advance moves a row in the expected state and records the extra columns', async () => {
  const { db, insert, stateOf, close } = await fixture();
  insert('c1', 'pending');
  assert.equal(advance(db, commandLifecycle, 'c1', 'pending', 'running', { attempts: 1 }), true);
  assert.equal(stateOf('c1'), 'running', 'the row moved');
  assert.equal(
    db.get<{ attempts: number }>('SELECT attempts FROM commands WHERE id=?', 'c1')?.attempts,
    1,
    'the extra column was written in the same statement',
  );
  close();
});

test('advance reports a lost race instead of overwriting the winner', async () => {
  const { db, insert, stateOf, close } = await fixture();
  insert('c1', 'cancelled');
  assert.equal(
    advance(db, commandLifecycle, 'c1', 'pending', 'running'),
    false,
    'a row that already left the expected state is not moved',
  );
  assert.equal(stateOf('c1'), 'cancelled', 'the earlier writer wins');
  close();
});

test('advance refuses a transition the lifecycle does not declare', async () => {
  const { db, insert, stateOf, close } = await fixture();
  insert('c1', 'succeeded');
  assert.throws(
    () => advance(db, commandLifecycle, 'c1', 'succeeded', 'running'),
    /succeeded cannot move to running/,
    'an illegal move is a programming error, not a silent no-op',
  );
  assert.equal(stateOf('c1'), 'succeeded', 'the row is untouched');
  close();
});

test('advanceWhere moves only matching rows in the listed source states', async () => {
  const { db, insert, stateOf, close } = await fixture();
  insert('a', 'pending', 'n1');
  insert('b', 'pending', 'n2');
  insert('c', 'running', 'n1');
  const moved = advanceWhere(db, commandLifecycle, 'pending', 'expired', {
    sql: 'node_id=?',
    params: ['n1'],
  });
  assert.equal(moved, 1, 'only the pending command of that node moved');
  assert.deepEqual([stateOf('a'), stateOf('b'), stateOf('c')], ['expired', 'pending', 'running']);
  close();
});

test('nodeStatus derives stale from the clock and never needs a stored value', () => {
  const now = Date.parse('2026-11-01T00:10:00Z');
  const base = {
    status: 'online',
    disabled_at: null as string | null,
    last_seen_at: null as string | null,
  };
  assert.equal(
    nodeStatus({ ...base, status: 'registered' }, now, 60),
    'registered',
    'a node never seen stays registered',
  );
  assert.equal(
    nodeStatus({ ...base, last_seen_at: '2026-11-01T00:09:30Z' }, now, 60),
    'online',
    'a recent heartbeat is online',
  );
  assert.equal(
    nodeStatus({ ...base, last_seen_at: '2026-11-01T00:00:00Z' }, now, 60),
    'stale',
    'an old heartbeat is stale without any sweep writing it',
  );
  assert.equal(
    nodeStatus(
      { ...base, disabled_at: '2026-11-01T00:00:00Z', last_seen_at: '2026-11-01T00:00:00Z' },
      now,
      60,
    ),
    'disabled',
    'disabled wins over stale',
  );
});

test('the database rejects a state the lifecycle does not declare', async () => {
  const { db, insert, close } = await fixture();
  assert.throws(
    () => insert('c1', 'rollingout'),
    'a typo in a state name fails at INSERT instead of being stored',
  );
  assert.doesNotThrow(() => insert('c2', 'pending'), 'a declared state is accepted');
  close();
});
