import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NOW,
  ago,
  event,
  healthyStatus,
  snapshotOf,
  staleBackup,
  unhealthyStatus,
} from '../../../tests/tui-fixtures.ts';
import { columnWidth } from '../width.ts';
import { deriveAttention } from './derive.ts';
import { createStyle } from './format.ts';
import { render } from './render.ts';
import { initialState, reduce } from './state.ts';
import type { Input, UiState } from './state.ts';
import type { Snapshot } from './types.ts';

const options = {
  style: createStyle(false),
  controlLabel: 'control-3fa9.tug',
  cliVersion: '1.2.0',
};
const envOf = (snapshot: Snapshot) => ({
  snapshot,
  attention: deriveAttention(snapshot, NOW, '1.2.0'),
});
const stateFor = (columns: number, rows: number, over: Partial<UiState> = {}): UiState => ({
  ...initialState({ columns, rows, readonly: false, defaultProject: 'site', now: NOW }),
  ...over,
});
const unhealthy = () =>
  snapshotOf(unhealthyStatus(), {
    backups: { data: { site: staleBackup }, fetchedAt: NOW },
    events: {
      data: [
        event({
          id: 'e1',
          type: 'service.failed',
          level: 'error',
          message: 'web on app2: health check returned 503',
          created_at: ago(240),
        }),
      ],
      fetchedAt: NOW,
    },
  });

test('every frame has exactly the terminal’s rows and no line wider than its columns', () => {
  for (const [columns, rows] of [
    [100, 26],
    [80, 24],
    [60, 14],
    [40, 8],
  ] as const) {
    const frame = render(stateFor(columns, rows), envOf(unhealthy()), options);
    assert.equal(
      frame.length,
      rows,
      `${columns}x${rows}: the frame fills the terminal height exactly`,
    );
    for (const line of frame)
      assert.ok(
        columnWidth(line) <= columns,
        `${columns}x${rows}: "${line}" must not exceed the width`,
      );
  }
});

test('the overview leads with the ranked attention list, then projects, nodes and events', () => {
  const text = render(stateFor(100, 26), envOf(unhealthy()), options).join('\n');
  const order = ['Attention (3)', 'Projects', 'Nodes', 'Events'].map((title) =>
    text.indexOf(`─ ${title}`),
  );
  assert.ok(
    order.every((at) => at >= 0),
    'all four panes are drawn when the terminal is tall enough',
  );
  assert.deepEqual(
    [...order].sort((a, b) => a - b),
    order,
    'the panes appear in tab order',
  );
  assert.match(
    text,
    /✖ +site\/web on app2 +failed to apply: health check GET \/healthz returned 503/,
    'the failure line says what and why',
  );
  assert.match(
    text,
    /▲ +node app3 +stale, last seen 12m ago; hosts site\/db/,
    'the stale node line names what it hosts',
  );
  assert.match(text, /Nodes 3\/4 online/, 'the header counts nodes');
  assert.match(
    text,
    /Services 4\/6 serving/,
    'the header counts services serving against expected',
  );
  assert.match(text, /● live 2s/, 'the header shows the age of the data');
});

test('a healthy fleet says nothing needs attention', () => {
  const text = render(stateFor(100, 26), envOf(snapshotOf(healthyStatus())), options).join('\n');
  assert.match(text, /Nothing needs attention/, 'the empty attention pane says so in words');
  assert.doesNotMatch(text, /[✖▲]/, 'no warning symbol appears when nothing is wrong');
});

test('stale data is never shown as current: a failing control turns the header to disconnected with the data’s age', () => {
  const snapshot = snapshotOf(healthyStatus());
  snapshot.status = { data: snapshot.status.data, fetchedAt: NOW - 40_000, error: 'ECONNRESET' };
  const text = render(stateFor(100, 26), envOf(snapshot), options).join('\n');
  assert.match(
    text,
    /◌ disconnected · data 40s old/,
    'the header says the data is old and the link is down',
  );
  assert.match(text, /no answer for 40s: ECONNRESET/, 'the attention list says why');
});

test('before the first answer the screen says it is connecting instead of showing an empty fleet as healthy', () => {
  const snapshot = snapshotOf(healthyStatus());
  snapshot.status = {};
  const text = render(stateFor(100, 26), envOf(snapshot), options).join('\n');
  assert.match(text, /○ connecting/, 'the header says it is still connecting');
  assert.match(text, /Waiting for the control plane/, 'the tables say they are waiting, not empty');
  assert.doesNotMatch(
    text,
    /Nothing needs attention/,
    'the attention pane must not claim all clear before control has answered',
  );
});

test('a short terminal shows the attention list and only the focused pane', () => {
  const text = render(stateFor(100, 12, { focus: 'nodes' }), envOf(unhealthy()), options).join(
    '\n',
  );
  assert.match(text, /─ Attention/, 'attention is always shown');
  assert.match(text, /─ Nodes/, 'the focused pane is shown');
  assert.doesNotMatch(text, /─ Projects/, 'the other panes are hidden to make room');
});

test('spare height goes to more panes instead of blank rows', () => {
  const text = render(stateFor(100, 20), envOf(snapshotOf(healthyStatus())), options).join('\n');
  assert.match(text, /─ Projects/, 'a 20-row terminal shows projects under the attention list');
  assert.match(text, /─ Nodes/, 'and nodes as well, rather than leaving the rows blank');
});

test('on a narrow terminal the reason column shrinks last, and information items are dim and marked with a dot', () => {
  const snapshot = snapshotOf(unhealthyStatus(), {
    events: {
      data: [
        event({
          id: 'p',
          type: 'ports.public',
          level: 'warn',
          message: 'db publishes 5432 publicly',
          project_id: 'blog',
        }),
      ],
      fetchedAt: NOW,
    },
  });
  const frame = render(stateFor(72, 20), envOf(snapshot), options);
  const failure = frame.find((line) => line.startsWith('✖')) ?? '';
  assert.match(
    failure,
    /failed to apply: health check GET \/healthz/,
    'the reason keeps most of its text at 72 columns',
  );
  assert.ok(
    failure.indexOf('failed to apply') <= 20,
    'the WHAT column gave way before the reason did',
  );
  const info = frame.find((line) => line.startsWith('·')) ?? '';
  assert.match(info, /^· {2}blog/, 'a rank 4 item uses a dot, not the warning triangle');
  const coloured =
    render(stateFor(100, 20), envOf(snapshot), { ...options, style: createStyle(true) }).find(
      (line) => line.includes('blog  '),
    ) ?? '';
  assert.ok(coloured.includes('\x1b[2m'), 'a rank 4 item is dimmed');
});

test('names with wide characters and escape sequences cannot break the layout or reach the terminal', () => {
  const status = unhealthyStatus();
  status.statuses[1].status_json = JSON.stringify({
    health: 'failed',
    serviceStates: {
      web: {
        rolloutState: 'failed',
        rolloutError:
          '\x1b]0;pwned\x07\x1b[2Jboom 日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語',
      },
    },
  });
  const frame = render(stateFor(60, 20), envOf(snapshotOf(status)), options);
  assert.ok(
    frame.every((line) => !line.includes('\x1b')),
    'no escape sequence from workload text reaches the frame',
  );
  assert.ok(
    frame.every((line) => columnWidth(line) <= 60),
    'wide characters are clipped by columns, not by characters',
  );
  assert.match(frame.join('\n'), /boom/, 'the readable part of the message survives');
});

test('colour is added only when asked and never carries meaning alone', () => {
  const coloured = render(stateFor(100, 26), envOf(unhealthy()), {
    ...options,
    style: createStyle(true),
  }).join('\n');
  const plain = render(stateFor(100, 26), envOf(unhealthy()), options).join('\n');
  assert.ok(coloured.includes('\x1b[31m'), 'a failure is drawn in red when colour is on');
  assert.ok(!plain.includes('\x1b'), 'NO_COLOR output has no escape sequences');
  assert.match(plain, /✖/, 'the failure is marked by a symbol as well as colour');
});

test('opening a project lists its services by node, with the deployment above them', () => {
  const snapshot = unhealthy();
  const env = envOf(snapshot);
  let state = stateFor(100, 26);
  const press = (input: Input) => (state = reduce(state, input, env).state);
  press({ type: 'key', key: { name: 'tab', sequence: '\t' } });
  press({ type: 'key', key: { name: 'return', sequence: '\r' } });
  const text = render(state, env, options).join('\n');
  assert.match(text, /overview › blog|overview › site/, 'the breadcrumb shows where you are');
  assert.match(
    text,
    /Deployment v\d+ \(succeeded\)/,
    'the current deployment is shown above the table',
  );
  assert.match(
    text,
    /SERVICE +NODE +STATE +ERROR/,
    'the services table has service, node, state and error columns',
  );
});

test('a placement view shows rollout state, error, image and recent events for one service on one node', () => {
  const snapshot = unhealthy();
  snapshot.events = {
    data: [
      event({
        id: 'e1',
        type: 'service.failed',
        level: 'error',
        message: 'web on app2: health check returned 503',
        created_at: ago(240),
      }),
    ],
    fetchedAt: NOW,
  };
  const state = stateFor(100, 26, {
    stack: [
      { name: 'overview' },
      { name: 'placement', project: 'site', service: 'web', node: 'app2' },
    ],
  });
  const text = render(state, envOf(snapshot), options).join('\n');
  assert.match(text, /Rollout +health_checking/, 'the rollout state is shown');
  assert.match(text, /Error +health check GET \/healthz returned 503/, 'the error is shown');
  assert.match(text, /Image +ghcr.io\/acme\/site@sha256:abc/, 'the image digest is shown');
  assert.match(text, /Recent events/, 'recent events for this service are listed');
});

test('a project whose current deployment is outside the returned rows is still listed, with a note', () => {
  const status = healthyStatus();
  status.projects[0].current_deployment_id = 'dep_old';
  const state = stateFor(100, 26, { stack: [{ name: 'overview' }, { name: 'projects' }] });
  const text = render(state, envOf(snapshotOf(status)), options).join('\n');
  assert.match(
    text,
    /site .*not in recent results/,
    'the project is not hidden when its deployment is missing from the rows',
  );
});

test('filtering keeps matching rows, negates with !, and matches one column with column=word', () => {
  const env = envOf(unhealthy());
  const view = (filter: string) =>
    render(
      stateFor(100, 26, { filter, stack: [{ name: 'overview' }, { name: 'nodes' }] }),
      env,
      options,
    ).join('\n');
  assert.doesNotMatch(view('app2'), /app4 /, 'a plain word keeps only rows containing it');
  assert.match(view('!stale'), /app1/, 'a leading ! keeps rows without the word');
  assert.doesNotMatch(view('!stale'), /app3/, 'a leading ! drops rows with the word');
  assert.match(view('status=stale'), /app3/, 'column=word matches that column');
  assert.doesNotMatch(view('status=app'), /app1 /, 'column=word does not match other columns');
});
