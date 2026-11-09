import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NOW,
  healthyStatus,
  snapshotOf,
  staleBackup,
  unhealthyStatus,
} from '../../../tests/tui-fixtures.ts';
import { deriveAttention } from './derive.ts';
import {
  LOG_LINES_MAX,
  completeCommand,
  initialState,
  reduce,
  resolveCommand,
  selectedRow,
  top,
} from './state.ts';
import type { Effect, Env, Input, Key, UiState } from './state.ts';
import type { Snapshot } from './types.ts';

const envOf = (snapshot: Snapshot): Env => ({
  snapshot,
  attention: deriveAttention(snapshot, NOW, '1.2.0'),
});
const unhealthy = (): Snapshot =>
  snapshotOf(unhealthyStatus(), { backups: { data: { site: staleBackup }, fetchedAt: NOW } });

/** A tiny driver: feed keys and inputs, keep the state, collect every effect. */
function session(snapshot: Snapshot, over: Partial<UiState> = {}) {
  let env = envOf(snapshot);
  let state: UiState = {
    ...initialState({ columns: 100, rows: 30, readonly: false, defaultProject: 'site', now: NOW }),
    ...over,
  };
  const effects: Effect[] = [];
  const send = (input: Input) => {
    const result = reduce(state, input, env);
    state = result.state;
    effects.push(...result.effects);
    return result;
  };
  const NAMED: Record<string, Key> = {
    enter: { name: 'return', sequence: '\r' },
    esc: { name: 'escape', sequence: '\x1b' },
    tab: { name: 'tab', sequence: '\t' },
    up: { name: 'up' },
    down: { name: 'down' },
    backspace: { name: 'backspace', sequence: '\x7f' },
    'ctrl-c': { name: 'c', ctrl: true, sequence: '\x03' },
    'ctrl-r': { name: 'r', ctrl: true, sequence: '\x12' },
  };
  const press = (...keys: string[]) => {
    for (const key of keys)
      send({
        type: 'key',
        key: NAMED[key] ?? {
          name: key.toLowerCase(),
          sequence: key,
          shift: key !== key.toLowerCase(),
        },
      });
  };
  const type = (text: string) => press(...text.split(''));
  return {
    press,
    type,
    send,
    effects,
    get state() {
      return state;
    },
    set snapshot(next: Snapshot) {
      env = envOf(next);
    },
    get env() {
      return env;
    },
  };
}

test('enter on an attention row opens the thing it names, and esc goes back', () => {
  const s = session(unhealthy());
  s.press('enter');
  assert.deepEqual(
    top(s.state),
    { name: 'placement', project: 'site', service: 'web', node: 'app2' },
    'the failing service opens its placement',
  );
  s.press('esc');
  assert.equal(top(s.state).name, 'overview', 'esc returns to the overview');
});

test('tab cycles the overview panes and the selection moves within the focused pane only', () => {
  const s = session(unhealthy());
  s.press('down');
  assert.equal(
    selectedRow(s.state, s.env)?.key,
    'node:app3',
    'down moves to the second attention row',
  );
  s.press('tab');
  assert.equal(s.state.focus, 'projects', 'tab focuses the next pane');
  assert.equal(selectedRow(s.state, s.env)?.key, 'blog', 'the projects pane has its own selection');
  s.press('tab', 'tab', 'tab');
  assert.equal(s.state.focus, 'attention', 'tab wraps around after the last pane');
  assert.equal(
    selectedRow(s.state, s.env)?.key,
    'node:app3',
    'the first pane remembers its selection',
  );
});

test('the selection follows the row, not the position, when a refresh reorders rows', () => {
  const s = session(unhealthy());
  s.press('tab', 'down');
  assert.equal(selectedRow(s.state, s.env)?.key, 'site', 'site is selected');
  const reordered = unhealthy();
  reordered.status.data!.projects = [
    ...reordered.status.data!.projects,
    { id: 'aaa', current_deployment_id: null },
  ];
  s.snapshot = reordered;
  assert.equal(
    selectedRow(s.state, s.env)?.key,
    'site',
    'a new project sorted above does not move the selection off site',
  );
});

test('a filter narrows the table, enter keeps it, esc clears it, and leaving a view resets it', () => {
  const s = session(unhealthy());
  s.type(':nodes');
  s.press('enter');
  assert.equal(top(s.state).name, 'nodes', 'the command opens the nodes view');
  s.type('/app3');
  assert.equal(s.state.filter, 'app3', 'typing filters live');
  s.press('enter');
  assert.equal(s.state.mode, 'normal', 'enter leaves filter mode and keeps the filter');
  assert.equal(selectedRow(s.state, s.env)?.key, 'app3', 'only the matching row remains');
  s.press('esc');
  assert.equal(s.state.filter, '', 'esc clears the filter first');
  assert.equal(top(s.state).name, 'nodes', 'and stays in the view');
});

test('the command line completes prefixes, rejects unknown names and quits', () => {
  assert.equal(resolveCommand('dep'), 'deployments', 'an alias resolves');
  assert.equal(resolveCommand('no'), 'nodes', 'a unique prefix resolves');
  assert.equal(resolveCommand('s'), undefined, 'an ambiguous prefix resolves to nothing');
  assert.equal(completeCommand('proj'), 'projects', 'tab completes to the first match');
  const s = session(unhealthy());
  s.type(':bogus');
  s.press('enter');
  assert.match(
    s.state.flash?.text ?? '',
    /unknown command :bogus/,
    'an unknown command is reported',
  );
  s.type(':q');
  s.press('enter');
  assert.deepEqual(s.effects.at(-1), { type: 'quit' }, ':q quits');
});

test('on-demand lists are loaded when their view opens, for the project the command names', () => {
  const s = session(unhealthy());
  s.type(':domains blog');
  s.press('enter');
  assert.deepEqual(
    s.effects.at(-1),
    { type: 'load', view: { name: 'domains', project: 'blog' } },
    'the list is fetched for the named project',
  );
  assert.deepEqual(
    top(s.state),
    { name: 'domains', project: 'blog' },
    'the view is filtered to that project',
  );
});

test('a mutating key asks first, only y confirms, and anything else cancels without effect', () => {
  const s = session(unhealthy());
  s.press('R');
  assert.equal(s.state.mode, 'confirm', 'rollback asks for confirmation');
  assert.equal(
    s.state.confirm?.prompt,
    'Roll site back to its previous successful deployment?',
    'the prompt names the project',
  );
  s.press('enter');
  assert.equal(s.state.mode, 'normal', 'enter is not a yes');
  assert.ok(!s.effects.some((effect) => effect.type === 'action'), 'cancelling changes nothing');
  assert.match(s.state.flash?.text ?? '', /nothing was changed/, 'the cancellation says so');
  s.press('R', 'y');
  assert.deepEqual(
    s.effects.at(-1),
    {
      type: 'action',
      action: 'rollback',
      context: { project: 'site', service: 'web', node: 'app2' },
    },
    'y runs the action with the selected row’s context',
  );
});

test('restart needs a service, cancel needs an unfinished deployment, and the reason is flashed', () => {
  const s = session(snapshotOf(healthyStatus()));
  s.press('tab', 'r');
  assert.equal(s.state.mode, 'normal', 'restart is refused on a project row');
  assert.match(s.state.flash?.text ?? '', /select a service to restart/, 'the reason is shown');
  s.press('x');
  assert.match(
    s.state.flash?.text ?? '',
    /deployment that has not finished/,
    'cancel explains what it needs',
  );
});

test('read-only mode and a read role hide every mutation and the shell with a stated reason', () => {
  const readonly = session(unhealthy(), { readonly: true });
  readonly.press('R');
  assert.match(readonly.state.flash?.text ?? '', /read-only mode/, 'read-only refuses rollback');
  readonly.press('enter', 's');
  assert.match(
    readonly.state.flash?.text ?? '',
    /read-only mode: shell is disabled/,
    'read-only refuses the shell',
  );
  const snapshot = unhealthy();
  snapshot.whoami = { data: { name: 'viewer', role: 'read', projects: null } };
  const viewer = session(snapshot);
  viewer.press('R');
  assert.match(
    viewer.state.flash?.text ?? '',
    /needs the deploy role; this credential is read/,
    'a read role is told which role is missing',
  );
  viewer.press('l');
  assert.ok(
    !viewer.effects.some((effect) => effect.type === 'logs.open'),
    'a read role cannot open logs',
  );
});

test('an unknown role (a control without whoami) may try, and the control decides', () => {
  const snapshot = unhealthy();
  snapshot.whoami = { error: 'GET /api/v1/whoami: 404' };
  const s = session(snapshot);
  s.press('R');
  assert.equal(
    s.state.mode,
    'confirm',
    'without a known role the screen does not block the action',
  );
});

test('logs open on the selected placement, ask for a node when a service has several, and close with esc', () => {
  const s = session(unhealthy());
  s.press('l');
  assert.deepEqual(
    s.effects.at(-1),
    { type: 'logs.open', project: 'site', service: 'web', node: 'app2' },
    'logs open on the failing placement',
  );
  assert.equal(
    s.state.screen?.kind,
    'logs',
    'the logs screen is shown at once, before any line arrives',
  );
  s.send({ type: 'logs.append', lines: ['one', 'two'] });
  assert.deepEqual(s.state.screen?.lines, ['one', 'two'], 'lines are appended');
  s.press('esc');
  assert.equal(s.state.screen, undefined, 'esc closes the screen');
  assert.deepEqual(s.effects.at(-1), { type: 'logs.close' }, 'and ends the live session');

  const picked = session(unhealthy());
  picked.press('tab', 'down', 'p');
  assert.equal(
    picked.state.mode,
    'pick',
    'site runs on app1, app2 and app3, so listing its containers asks which node',
  );
  picked.press('down', 'enter');
  assert.deepEqual(
    picked.effects.at(-1),
    { type: 'text.open', op: 'ps', project: 'site', service: undefined, node: 'app2' },
    'the chosen node is used',
  );
});

test('the logs screen follows new lines, pauses when scrolled up, filters, clears and keeps a bounded buffer', () => {
  const s = session(unhealthy());
  s.press('l');
  s.send({ type: 'logs.append', lines: Array.from({ length: 100 }, (_, i) => `line ${i}`) });
  assert.equal(s.state.screen?.follow, true, 'a new logs screen follows the end');
  s.press('up');
  assert.equal(s.state.screen?.follow, false, 'scrolling up pauses following');
  s.press('G');
  assert.equal(s.state.screen?.follow, true, 'going to the end resumes following');
  s.press(' ');
  assert.equal(s.state.screen?.follow, false, 'space pauses');
  s.type('/line 9');
  s.press('enter');
  assert.equal(s.state.screen?.filter, 'line 9', 'the filter applies to the log lines');
  s.press('c');
  assert.deepEqual(s.state.screen?.lines, [], 'c clears the buffer');
  s.send({
    type: 'logs.append',
    lines: Array.from({ length: LOG_LINES_MAX + 50 }, (_, i) => `n${i}`),
  });
  assert.equal(s.state.screen?.lines.length, LOG_LINES_MAX, 'the buffer is a ring of fixed size');
  assert.equal(s.state.screen?.lines.at(-1), `n${LOG_LINES_MAX + 49}`, 'the newest lines are kept');
});

test('describe shows the selected row as sanitized JSON, inspect and ps open text screens, shell hands over the terminal', () => {
  const s = session(unhealthy());
  s.press('tab', 'd');
  assert.equal(s.state.screen?.kind, 'text', 'd opens a text screen');
  assert.match(s.state.screen?.lines.join('\n') ?? '', /"project"/, 'it shows the row’s record');
  s.press('esc');
  const inspect = session(unhealthy());
  inspect.press('i');
  assert.deepEqual(
    inspect.effects.at(-1),
    { type: 'text.open', op: 'inspect', project: 'site', service: 'web', node: 'app2' },
    'i inspects the selected placement',
  );
  inspect.send({ type: 'text.set', lines: ['{', '}'] });
  assert.deepEqual(
    inspect.state.screen?.lines,
    ['{', '}'],
    'the loaded text replaces the placeholder',
  );
  const shell = session(unhealthy());
  shell.press('s');
  assert.deepEqual(
    shell.effects.at(-1),
    { type: 'shell', project: 'site', service: 'web', node: 'app2' },
    's runs a shell on the selected placement',
  );
});

test('quitting works from anywhere with ctrl-c, and q closes a screen before it quits', () => {
  const s = session(unhealthy());
  s.press('l', 'q');
  assert.equal(s.state.screen, undefined, 'q closes the open screen first');
  assert.ok(!s.effects.some((effect) => effect.type === 'quit'), 'and does not quit');
  s.press('ctrl-c');
  assert.deepEqual(s.effects.at(-1), { type: 'quit' }, 'ctrl-c quits');
});

test('flashes expire and the screen asks for a refresh with ctrl-r', () => {
  const s = session(unhealthy());
  s.press('ctrl-r');
  assert.deepEqual(s.effects.at(-1), { type: 'refresh' }, 'ctrl-r polls now');
  assert.ok(s.state.flash, 'a flash is shown');
  s.send({ type: 'tick', now: NOW + 60_000 });
  assert.equal(s.state.flash, undefined, 'the flash expires on a later tick');
});
