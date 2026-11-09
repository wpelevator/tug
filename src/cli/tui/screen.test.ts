import test from 'node:test';
import assert from 'node:assert/strict';
import xterm from '@xterm/headless';
import { fakeTerminal, start, until } from '../../../tests/tui-harness.ts';

const { Terminal } = xterm;

/**
 * Feeds everything the screen writes into a real terminal emulator, so these tests check what a terminal would show
 * after applying the escape sequences, not just the text the renderer produced.
 */
function emulate(term: ReturnType<typeof fakeTerminal>, cols = 100, rows = 30) {
  const emu = new Terminal({ cols, rows, allowProposedApi: true });
  // The screen may already have drawn before the emulator was attached, so replay what it wrote.
  let chain = new Promise<void>((resolve) => emu.write(term.output(), resolve));
  term.stdout.on('data', (chunk: Buffer) => {
    chain = chain.then(() => new Promise<void>((resolve) => emu.write(chunk, resolve)));
  });
  const lines = () =>
    Array.from(
      { length: emu.rows },
      (_, i) => emu.buffer.active.getLine(i)?.translateToString(true) ?? '',
    );
  /** The screen with ages masked, since "live 2s" and "12m" change as time passes. */
  const stable = () => lines().map((line) => line.replace(/\b\d+[smhd]\b/g, 'N'));
  const settled = () => chain;
  return { emu, lines, stable, settled };
}
/** Waits until the emulated screen satisfies the condition. */
async function screen(
  em: ReturnType<typeof emulate>,
  condition: (text: string) => boolean,
  what: string,
) {
  await until(() => condition(em.lines().join('\n')), what);
  await em.settled();
}
const redraw = async (term: ReturnType<typeof fakeTerminal>, em: ReturnType<typeof emulate>) => {
  await em.settled();
  term.stdout.emit('resize');
  await new Promise((resolve) => setTimeout(resolve, 20));
  await em.settled();
};

function run() {
  const session = start();
  const em = emulate(session.term);
  return { ...session, em };
}

test('the first frame is on the alternate screen and holds the header, panes and hints', async () => {
  const { term, em, done } = run();
  await screen(em, (text) => text.includes('failed to apply'), 'the first frame');
  const lines = em.lines();
  assert.equal(
    em.emu.buffer.active.type,
    'alternate',
    'the UI draws on the alternate screen, leaving the scrollback alone',
  );
  assert.match(
    lines[0],
    /^ tug +localhost|^ tug +control-3fa9\.tug/,
    'the first row is the header',
  );
  assert.match(lines[1], /Nodes 3\/4 online/, 'the second row holds the counters');
  assert.match(lines[2], /^─ Attention \(4\)/, 'the attention pane starts under the header');
  assert.match(
    lines[29],
    /^ \? help +q quit/,
    'the key hints are on the last row, with help and quit first so a narrow terminal cannot clip them',
  );
  term.stdin.write('q');
  await done;
});

test('after many incremental updates the screen equals a full redraw of the same state', async () => {
  const { term, em, done } = run();
  await screen(em, (text) => text.includes('failed to apply'), 'the first frame');
  const keys = [
    '\t',
    'j',
    '\t',
    '\t',
    '\t',
    ':nodes\r',
    '/app3',
    '\r',
    '\x1b[A',
    ':events\r',
    'j',
    'j',
  ];
  for (const key of keys) {
    term.stdin.write(key);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  await em.settled();
  const incremental = em.stable();
  await redraw(term, em);
  assert.deepEqual(
    em.stable(),
    incremental,
    'the line diff leaves exactly what a clear-and-redraw would show: no stale or missing rows',
  );
  term.stdin.write('\x03');
  await done;
});

test('opening and closing a log screen restores the overview exactly, with no log text left behind', async () => {
  const { term, em, live, done } = run();
  await screen(em, (text) => text.includes('failed to apply'), 'the first frame');
  const before = em.stable();
  term.stdin.write('l');
  await until(() => live.sessions.length === 1, 'the logs session');
  live.sessions[0].push({
    type: 'stdout',
    data: new TextEncoder().encode('GET /healthz 503\nlistening on 8080\n'),
  });
  await screen(
    em,
    (text) => text.includes('listening on 8080') && text.includes('─ logs site/web@app2'),
    'the log lines',
  );
  assert.ok(
    !em.lines().join('\n').includes('Attention'),
    'the log screen replaces the overview body',
  );
  term.stdin.write('q');
  await screen(em, (text) => text.includes('─ Attention'), 'the overview to return');
  assert.deepEqual(em.stable(), before, 'closing the screen leaves no log lines on the overview');
  term.stdin.write('q');
  await done;
});

test('a resize redraws at the new size with every row inside it', async () => {
  const { term, em, done } = run();
  await screen(em, (text) => text.includes('failed to apply'), 'the first frame');
  term.stdout.columns = 60;
  term.stdout.rows = 14;
  em.emu.resize(60, 14);
  term.stdout.emit('resize');
  await screen(em, (text) => text.includes('─ Attention'), 'the redraw');
  const lines = em.lines();
  assert.equal(lines.length, 14, 'the emulator has the new height');
  assert.match(lines[13], /^ \? help +q quit/, 'the hints moved to the new last row');
  assert.ok(
    lines.every((line) => line.length <= 60),
    'no row is wider than the new width, so nothing wrapped',
  );
  assert.match(
    lines[1],
    /…$/,
    'the counters row was redrawn narrower and clipped, not left at 100 columns',
  );
  const resized = em.stable();
  await redraw(term, em);
  assert.deepEqual(em.stable(), resized, 'a further full redraw changes nothing');
  term.stdin.write('q');
  await done;
});

test('the shell runs on the normal screen, and the overview returns intact afterwards', async () => {
  const { term, em, live, done } = run();
  await screen(em, (text) => text.includes('failed to apply'), 'the first frame');
  const before = em.stable();
  term.stdin.write('s');
  await until(() => live.sessions.length === 1, 'the shell session');
  await em.settled();
  assert.equal(
    em.emu.buffer.active.type,
    'normal',
    'the shell has the normal screen, so its output lands in the scrollback',
  );
  live.sessions[0].push({ type: 'exit', code: 0 });
  await screen(em, (text) => text.includes('─ Attention'), 'the overview to return');
  assert.equal(em.emu.buffer.active.type, 'alternate', 'the alternate screen is back');
  assert.deepEqual(
    em.stable().slice(0, 29),
    before.slice(0, 29),
    'the overview is as it was, apart from the message line',
  );
  term.stdin.write('q');
  await done;
});

test('quitting leaves the normal screen showing, with nothing of the UI on it', async () => {
  const { term, em, done } = run();
  await screen(em, (text) => text.includes('failed to apply'), 'the first frame');
  term.stdin.write('q');
  await done;
  await em.settled();
  assert.equal(em.emu.buffer.active.type, 'normal', 'the normal screen is restored on exit');
  assert.ok(
    em.lines().every((line) => line.trim() === ''),
    'no UI text is left on the normal screen',
  );
});
