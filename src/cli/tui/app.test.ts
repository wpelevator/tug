import test from 'node:test';
import assert from 'node:assert/strict';
import { healthyStatus, unhealthyStatus } from '../../../tests/tui-fixtures.ts';
import { fakeTerminal, fakeTransport, fakeApi, start, until } from '../../../tests/tui-harness.ts';
import type { LiveRequest } from '../../protocol.ts';
import { LineSplitter, runTui } from './app.ts';
import type { TuiOptions } from './app.ts';

test('it refuses to run without a terminal and points at --once', async () => {
  const term = fakeTerminal();
  term.stdout.isTTY = false;
  await assert.rejects(
    runTui({
      api: fakeApi().api,
      transport: fakeTransport().transport,
      io: term,
      readonly: false,
      project: 'site',
      controlLabel: 'x',
      cliVersion: '1.2.0',
    }),
    /needs a terminal.*--once/,
    'a script gets told how to get a summary instead of a broken screen',
  );
});

test('it draws the fleet on the alternate screen, quits on q and restores the terminal', async () => {
  const { term, done } = start();
  await until(() => term.output().includes('failed to apply'), 'the attention list to be drawn');
  assert.ok(
    term.output().startsWith('\x1b[?1049h\x1b[?25l'),
    'the alternate screen is entered and the cursor hidden first',
  );
  assert.ok(
    term.output().includes('Nodes 3/4 online'),
    'the header counts nodes from the first poll',
  );
  assert.equal(term.stdin.isRaw, true, 'raw mode is on while the screen runs');
  term.stdin.write('q');
  assert.equal(await done, 0, 'q ends the screen with exit code 0');
  assert.ok(
    term.output().endsWith('\x1b[?25h\x1b[?1049l'),
    'the cursor is shown and the normal screen restored last',
  );
  assert.equal(term.stdin.isRaw, false, 'raw mode is turned off again');
});

test('ctrl-c quits from anywhere and a later frame redraws only the lines that changed', async () => {
  const { term, done } = start();
  await until(() => term.output().includes('failed to apply'), 'the first frame');
  const first = term.output().length;
  await new Promise((resolve) => setTimeout(resolve, 150));
  const idle = term.output().slice(first);
  assert.ok(!idle.includes('\x1b[2J'), 'an unchanged screen is not cleared and redrawn');
  term.stdin.write('\x03');
  assert.equal(await done, 0, 'ctrl-c quits');
});

test('l follows logs of the failing service, drawn as sanitized whole lines, and q closes the session', async () => {
  const { term, live, done } = start();
  await until(() => term.output().includes('failed to apply'), 'the first frame');
  term.stdin.write('l');
  await until(() => live.opened.length === 1, 'the logs session to open');
  assert.deepEqual(
    live.opened[0],
    { operation: 'logs', project: 'site', service: 'web', node: 'app2', follow: true, tail: 200 },
    'logs are requested for the selected placement, following, with the default tail',
  );
  const bytes = new TextEncoder().encode('GET /healthz 503\n\x1b]0;pwned\x07\x1b[2Jlisten');
  live.sessions[0].push({ type: 'stdout', data: bytes.slice(0, 20) });
  live.sessions[0].push({ type: 'stdout', data: bytes.slice(20) });
  live.sessions[0].push({ type: 'stdout', data: new TextEncoder().encode('ing on 8080\n') });
  await until(() => term.output().includes('GET /healthz 503'), 'the first log line to appear');
  await until(
    () => term.output().includes('listening on 8080'),
    'a line split across chunks to be reassembled',
  );
  assert.ok(
    !term.output().includes('pwned') || !term.output().includes('\x1b]0;'),
    'a title-setting escape from a container never reaches the terminal',
  );
  assert.ok(
    !term.output().includes('\x1b]0;pwned'),
    'the escape sequence is stripped from log text',
  );
  live.sessions[0].push({ type: 'disconnect', message: 'agent went away' });
  await until(
    () => term.output().includes('disconnected: agent went away'),
    'the disconnect to be shown',
  );
  term.stdin.write('q');
  await until(() => live.sessions[0].closed, 'the live session to close with the screen');
  term.stdin.write('q');
  assert.equal(await done, 0, 'a second q quits');
});

test('i shows the container inspection result as text and a failed result is shown as an error', async () => {
  const { term, live, done } = start();
  await until(() => term.output().includes('failed to apply'), 'the first frame');
  term.stdin.write('i');
  await until(() => live.opened.length === 1, 'the inspect session to open');
  assert.equal(live.opened[0].operation, 'inspect', 'inspect is requested over the live channel');
  live.sessions[0].push({ type: 'result', value: { State: { Status: 'running' } } });
  live.sessions[0].push({ type: 'exit', code: 0 });
  await until(() => term.output().includes('"Status": "running"'), 'the JSON result to be drawn');
  term.stdin.write('qq');
  assert.equal(await done, 0, 'the screen quits cleanly');
});

test('R then y rolls the project back through the API, and n changes nothing', async () => {
  const { term, calls, done } = start();
  await until(() => term.output().includes('failed to apply'), 'the first frame');
  term.stdin.write('R');
  await until(() => term.output().includes('Roll site back'), 'the confirmation prompt');
  term.stdin.write('n');
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(!calls.some((call) => call.route === '/api/v1/rollback'), 'declining sends nothing');
  term.stdin.write('R');
  await until(() => term.output().includes('[y/N]'), 'the prompt to appear again');
  term.stdin.write('y');
  await until(
    () => calls.some((call) => call.route === '/api/v1/rollback'),
    'the rollback request',
  );
  assert.deepEqual(
    calls.find((call) => call.route === '/api/v1/rollback')?.body,
    { project: 'site', force: false },
    'the request matches the CLI’s',
  );
  await until(
    () => term.output().includes('rollback of site started as deployment dep_9'),
    'the result to be flashed',
  );
  term.stdin.write('q');
  assert.equal(await done, 0, 'quits cleanly');
});

test('read-only mode refuses mutations without calling the API', async () => {
  const { term, calls, done } = start({ readonly: true });
  await until(() => term.output().includes('failed to apply'), 'the first frame');
  term.stdin.write('R');
  await until(() => term.output().includes('read-only mode'), 'the refusal');
  assert.ok(
    !calls.some((call) => call.method === 'POST'),
    'no mutating request is sent in read-only mode',
  );
  term.stdin.write('q');
  await done;
});

test('losing control turns the header to disconnected without blanking the data', async () => {
  let down = false;
  const { term, done } = start({
    status: () => {
      if (down) throw new Error('GET /api/v1/status: could not reach control');
      return healthyStatus() as ReturnType<typeof unhealthyStatus>;
    },
  });
  await until(() => term.output().includes('● live'), 'a live header');
  down = true;
  await until(() => term.output().includes('◌ disconnected'), 'the disconnected header');
  assert.ok(
    term.output().includes('Nodes 4/4 online'),
    'the last known counts stay on screen, marked old by the header',
  );
  term.stdin.write('q');
  await done;
});

test('s hands the terminal to a TTY exec session, then takes it back and redraws', async () => {
  const { term, live, done } = start();
  await until(() => term.output().includes('failed to apply'), 'the first frame');
  const before = term.output().length;
  term.stdin.write('s');
  await until(() => live.opened.length === 1, 'the exec session to open');
  const request = live.opened[0] as Extract<LiveRequest, { operation: 'exec' }>;
  assert.deepEqual(
    [
      request.operation,
      request.project,
      request.service,
      request.node,
      request.command,
      request.interactive,
      request.tty,
    ],
    ['exec', 'site', 'web', 'app2', ['sh'], true, true],
    'a shell is an interactive TTY exec of sh on the selected placement',
  );
  assert.ok(
    term.output().slice(before).includes('\x1b[?1049l'),
    'the alternate screen is left before the shell starts',
  );
  live.sessions[0].push({ type: 'exit', code: 3 });
  await until(
    () => term.output().lastIndexOf('\x1b[?1049h') > term.output().lastIndexOf('\x1b[?1049l'),
    'the screen to be re-entered',
  );
  await until(
    () => term.output().includes('shell exited with code 3'),
    'the exit code to be flashed',
  );
  assert.equal(term.stdin.isRaw, true, 'raw mode is back on for the screen');
  term.stdin.write('q');
  assert.equal(await done, 0, 'the screen still quits normally after a shell');
});

test('with the push channel open the header says so, new events appear without a poll, and a hint refetches', async () => {
  let handlers: Parameters<NonNullable<TuiOptions['watch']>>[0] | undefined;
  const stopped: boolean[] = [];
  const slow = { status: 1e6, events: 1e6, slow: 1e6, diagnostics: 1e6, lists: 1e6 };
  const { term, calls, done } = start({
    intervals: slow,
    watch: (h) => {
      handlers = h;
      return { start: () => {}, stop: () => void stopped.push(true) };
    },
  });
  await until(() => term.output().includes('failed to apply'), 'the first frame');
  assert.ok(term.output().includes('● live'), 'without the channel the header shows the data age');
  assert.ok(!term.output().includes('live · push'), 'and does not claim push');
  handlers!.onState(true);
  await until(() => term.output().includes('● live · push'), 'the push marker');
  const before = calls.filter((call) => call.route === '/api/v1/status').length;
  handlers!.onFrame({
    v: 1,
    type: 'watch.events',
    cursor: 9,
    events: [
      {
        seq: 9,
        id: 'evt_pushed',
        project_id: 'site',
        deployment_id: null,
        node_id: null,
        level: 'error',
        type: 'container.crashloop',
        message: 'web on app2 crashed 3 times',
        metadata_json: '{}',
        created_at: new Date().toISOString(),
        actor: null,
      },
    ],
  });
  await until(
    () => term.output().includes('web on app2 crashed 3 times'),
    'the pushed event to be drawn',
  );
  assert.equal(
    calls.filter((call) => call.route === '/api/v1/status').length,
    before,
    'a pushed event needs no request',
  );
  handlers!.onFrame({
    v: 1,
    type: 'watch.changed',
    changes: [{ topic: 'status', project: 'site' }],
  });
  await until(
    () => calls.filter((call) => call.route === '/api/v1/status').length > before,
    'the hint to refetch status',
  );
  term.stdin.write('q');
  assert.equal(await done, 0, 'quits cleanly');
  assert.deepEqual(stopped, [true], 'the push channel is closed with the screen');
});

test('the line splitter reassembles lines across chunks and multi-byte characters, and strips escapes', () => {
  const splitter = new LineSplitter();
  const bytes = new TextEncoder().encode('héllo wörld\r\nsecond \x1b[31mred\x1b[0m\nthird');
  const lines = [
    ...splitter.push(bytes.slice(0, 2)),
    ...splitter.push(bytes.slice(2, 9)),
    ...splitter.push(bytes.slice(9)),
  ];
  assert.deepEqual(
    lines,
    ['héllo wörld', 'second red'],
    'whole lines come out, multi-byte characters survive a chunk boundary and colour codes are removed',
  );
  assert.deepEqual(splitter.flush(), ['third'], 'the unfinished last line is released at the end');
});
