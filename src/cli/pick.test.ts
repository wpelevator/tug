import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createNumberedPicker, createPicker } from './pick.ts';
import { clipToColumns, columnWidth } from './width.ts';

const UP = '\x1b[A';
const DOWN = '\x1b[B';
const labels = ['Database', 'Files', 'Cache'];

function terminal() {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (chunk) => (text += String(chunk)));
  return {
    input,
    picker: createPicker({ input, output }),
    output: () => text,
    /** Keys are sent after the menu is listening, as a person would type them. */
    keys: (value: string) =>
      new Promise<void>((resolve) => setImmediate(() => (input.write(value), resolve()))),
  };
}

test('space toggles entries and enter returns them in list order', async () => {
  const t = terminal();
  const result = t.picker.many('Targets', labels);
  await t.keys(`${DOWN}${DOWN} ${UP}${UP} \r`);
  assert.deepEqual(
    await result,
    [0, 2],
    'entries toggled with space should come back in list order',
  );
  assert.match(
    t.output(),
    /Targets: Database, Cache/,
    'the menu should collapse to the chosen labels',
  );
});

test('toggling an entry twice deselects it and the all-toggle selects then clears everything', async () => {
  const t = terminal();
  const result = t.picker.many('Targets', labels);
  await t.keys('  a\r');
  assert.deepEqual(
    await result,
    [0, 1, 2],
    'toggling twice must deselect, then a selects every entry',
  );
  const again = terminal();
  const second = again.picker.many('Targets', labels);
  await again.keys('aaj \r');
  assert.deepEqual(await second, [1], 'a pressed on a full selection must clear it');
});

test('enter on an empty multi-choice menu is refused until something is selected', async () => {
  const t = terminal();
  const result = t.picker.many('Targets', labels);
  await t.keys('\r\r');
  await t.keys('j ');
  await t.keys('\r');
  assert.deepEqual(await result, [1], 'blank enter must never select a target');
  assert.match(t.output(), /Select at least one/, 'the refusal should tell the person what to do');
});

test('a single-choice menu needs an explicit pick even for one entry, and digits jump to entries', async () => {
  const t = terminal();
  const result = t.picker.one('Delete', ['Only']);
  await t.keys('\r');
  assert.equal(await result, 0, 'enter on the highlighted sole entry picks it');
  const jump = terminal();
  const picked = jump.picker.one('Target', labels);
  await jump.keys('3\r');
  assert.equal(await picked, 2, 'a digit moves the cursor to that entry');
  const start = terminal();
  const initial = start.picker.one('Address', labels, 1);
  await start.keys('\r');
  assert.equal(await initial, 1, 'the initial entry is the one enter takes');
});

test('arrows wrap around the list', async () => {
  const t = terminal();
  const result = t.picker.one('Target', labels);
  await t.keys(`${UP}\r`);
  assert.equal(await result, 2, 'up from the first entry should wrap to the last');
});

test('q and Ctrl-C cancel without selecting anything', async () => {
  for (const key of ['q', '\x03']) {
    const t = terminal();
    const result = t.picker.many('Targets', labels);
    await t.keys(` ${key}`);
    await assert.rejects(
      result,
      /cancelled; nothing was changed/,
      `${JSON.stringify(key)} should cancel`,
    );
  }
});

test('closing input before an answer rejects and releases the listeners', async () => {
  const t = terminal();
  const before = ['keypress', 'end', 'error'].map((event) => t.input.listenerCount(event));
  const result = t.picker.one('Target', labels);
  await t.keys('');
  t.input.end();
  await assert.rejects(result, /input closed before an answer/, 'EOF must not pick a target');
  assert.deepEqual(
    ['keypress', 'end', 'error'].map((event) => t.input.listenerCount(event)),
    before,
    'a finished menu must remove its input listeners',
  );
});

test('long menus scroll inside the terminal height and labels cannot inject escapes', async () => {
  const input = new PassThrough();
  const output = Object.assign(new PassThrough(), { columns: 30, rows: 8 });
  let text = '';
  output.on('data', (chunk) => (text += String(chunk)));
  const picker = createPicker({ input, output });
  const many = Array.from({ length: 12 }, (_, i) => `entry-${i}\x1b[2J${'x'.repeat(40)}`);
  const result = picker.one('Target', many);
  await new Promise((resolve) => setImmediate(resolve));
  input.write(`${UP}\r`);
  assert.equal(
    await result,
    11,
    'moving up from the first entry should reach the last, scrolled into view',
  );
  assert.ok(!text.includes('\x1b[2J'), 'control characters in labels must be neutralized');
  assert.match(text, /\d+-\d+ of 12/, 'a scrolled menu should show which entries are visible');
});

test('Ctrl-D cancels like EOF would, and Ctrl-N/P and paging move the cursor', async () => {
  const eof = terminal();
  const cancelled = eof.picker.one('Target', labels);
  await eof.keys('\x04');
  await assert.rejects(cancelled, /cancelled; nothing was changed/, 'Ctrl-D should cancel');
  const emacs = terminal();
  const moved = emacs.picker.one('Target', labels);
  await emacs.keys('\x0e\x0e\x10\r');
  assert.equal(await moved, 1, 'Ctrl-N twice and Ctrl-P once should land on the second entry');
  const paged = terminal();
  const many = Array.from({ length: 30 }, (_, i) => `entry ${i}`);
  const result = paged.picker.one('Target', many);
  await paged.keys('\x1b[6~\r');
  assert.ok((await result) > 3, 'PageDown should move by a page, not one entry');
});

test('typed digits form one number so entries past nine are reachable', async () => {
  const t = terminal();
  const many = Array.from({ length: 15 }, (_, i) => `entry ${i + 1}`);
  const result = t.picker.one('Target', many);
  await t.keys('12\r');
  assert.equal(await result, 11, 'typing 1 then 2 should select the twelfth entry');
  const overshoot = terminal();
  const second = overshoot.picker.one('Target', many);
  await overshoot.keys('99\r');
  assert.equal(await second, 8, 'a number past the end starts over from the last digit');
});

test('wide characters are clipped by terminal columns and a short terminal still fits the menu', async () => {
  assert.equal(clipToColumns('abcdef', 10), 'abcdef', 'short text is untouched');
  assert.equal(
    clipToColumns('日本語日本語', 7),
    '日本語…',
    'each wide character counts as two columns',
  );
  assert.ok([...clipToColumns('🙂'.repeat(20), 11)].length <= 6, 'emoji count as two columns each');
  const input = new PassThrough();
  const output = Object.assign(new PassThrough(), { columns: 40, rows: 6 });
  let text = '';
  output.on('data', (chunk) => (text += String(chunk)));
  const result = createPicker({ input, output }).many('Targets', ['a', 'b', 'c', 'd', 'e']);
  await new Promise((resolve) => setImmediate(resolve));
  const lines = text.split('\n').filter((line) => line && !line.includes('\x1b['));
  assert.equal(
    lines.length,
    4,
    'menu height must stay under the terminal rows so redraw can erase it',
  );
  input.write('q');
  await assert.rejects(result, /cancelled/, 'q still cancels a squeezed menu');
});

test('a resize redraws the menu and finishing removes every process hook', async () => {
  const input = new PassThrough();
  const output = Object.assign(new PassThrough(), { columns: 60, rows: 24 });
  let text = '';
  output.on('data', (chunk) => (text += String(chunk)));
  const hooks = () => ['exit', 'SIGTERM', 'SIGHUP'].map((name) => process.listenerCount(name));
  const before = hooks();
  const result = createPicker({ input, output }).one('Target', labels);
  await new Promise((resolve) => setImmediate(resolve));
  const drawn = text.split('Target').length;
  output.columns = 30;
  output.emit('resize');
  assert.ok(text.split('Target').length > drawn, 'a resize should draw the menu again');
  input.write('\r');
  await result;
  assert.deepEqual(
    hooks(),
    before,
    'a finished menu must not leave exit or signal handlers behind',
  );
});

test('a terminated process shows the cursor again and still dies of the signal', async () => {
  const picker = pathToFileURL(path.resolve('src/cli/pick.ts')).href;
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { createPicker } from ${JSON.stringify(picker)};
      createPicker({ input: process.stdin, output: process.stderr }).one('Target', ['a', 'b']);`,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += String(chunk)));
  for (const started = Date.now(); !stderr.includes('cancel)');)
    if (Date.now() - started > 5000) assert.fail(`the menu never appeared: ${stderr}`);
    else await new Promise((resolve) => setTimeout(resolve, 20));
  child.kill('SIGTERM');
  const [code, signal] = await once(child, 'close');
  assert.equal(
    signal,
    'SIGTERM',
    `a SIGTERM during a menu must still end the process (exit ${code})`,
  );
  assert.ok(
    stderr.lastIndexOf('\x1b[?25h') > stderr.lastIndexOf('\x1b[?25l'),
    'the cursor must be visible again after the process is terminated',
  );
});

test('numbered menus answer plain terminals, with a default only when the menu offers one', async () => {
  const shown: string[] = [];
  const answers = ['', '9', 'x', '2'];
  const picker = createNumberedPicker(
    async () => answers.shift() ?? 'q',
    (line) => shown.push(line),
  );
  assert.equal(
    await picker.one('Target', ['a', 'b']),
    1,
    'blank, out of range and junk are refused',
  );
  assert.deepEqual(shown, ['Target', '  1) a', '  2) b'], 'entries are listed with their numbers');
  const withDefault = createNumberedPicker(
    async () => '',
    () => {},
  );
  assert.equal(
    await withDefault.one('Address', ['a', 'b'], 1),
    1,
    'blank takes the offered default',
  );
  const several = createNumberedPicker(
    async () => '3, 1,3',
    () => {},
  );
  assert.deepEqual(
    await several.many('Targets', ['a', 'b', 'c']),
    [0, 2],
    'several numbers come back deduplicated in list order',
  );
  await assert.rejects(
    createNumberedPicker(
      async () => 'q',
      () => {},
    ).many('Targets', ['a']),
    /cancelled; nothing was changed/,
    'q cancels a numbered menu',
  );
});

test('narrowing the terminal erases the rows the drawn lines now wrap onto', async () => {
  const input = new PassThrough();
  const output = Object.assign(new PassThrough(), { columns: 40, rows: 24 });
  let text = '';
  output.on('data', (chunk) => (text += String(chunk)));
  const result = createPicker({ input, output }).one(
    'A question that is fairly long for a narrow terminal',
    ['a', 'b'],
  );
  await new Promise((resolve) => setImmediate(resolve));
  const drawn = text.length;
  output.columns = 20;
  output.emit('resize');
  // eslint-disable-next-line no-control-regex
  const upMoves = [...text.slice(drawn).matchAll(/\x1b\[(\d+)A/g)].map((match) => Number(match[1]));
  assert.ok(
    upMoves[0] > 4,
    'the 4 drawn lines wrap onto more rows after narrowing, so more rows must be erased than lines drawn',
  );
  input.write('q');
  await assert.rejects(result, /cancelled/, 'the menu still works after a resize');
});

test('zero-width, keycap and flag characters are measured as terminals draw them', () => {
  assert.equal(columnWidth('a\u200bb'), 2, 'a zero-width space takes no column');
  assert.equal(columnWidth('1\ufe0f\u20e3'), 2, 'a keycap emoji is two columns wide');
  assert.equal(columnWidth('🇱🇻'), 2, 'a flag is one two-column character');
  assert.equal(columnWidth('e\u0301'), 1, 'a combining accent adds no column');
  assert.equal(columnWidth('abc'), 3, 'plain text is one column per character');
});

test('a very short terminal drops the hint and footer so the menu still fits', async () => {
  const input = new PassThrough();
  const output = Object.assign(new PassThrough(), { columns: 60, rows: 4 });
  let text = '';
  output.on('data', (chunk) => (text += String(chunk)));
  const result = createPicker({ input, output }).many('Targets', ['a', 'b', 'c', 'd']);
  await new Promise((resolve) => setImmediate(resolve));
  const lines = text.split('\n').filter((line) => line.trim());
  assert.ok(
    lines.length <= 3,
    'title plus entries must stay within the terminal rows minus the prompt line',
  );
  assert.ok(!text.includes('(space select'), 'the hint line is dropped when there is no room');
  input.write('\r');
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(text, /Targets - Select at least one/, 'the refusal note moves onto the title line');
  input.write('q');
  await assert.rejects(result, /cancelled/, 'q still cancels');
});

test('digits typed around another key do not join into one number', async () => {
  const t = terminal();
  const many = Array.from({ length: 15 }, (_, i) => `entry ${i + 1}`);
  const result = t.picker.one('Target', many);
  await t.keys('1\x1b[B2\r');
  assert.equal(
    await result,
    1,
    'an arrow key between digits starts a new number: 1, down, 2 selects entry 2',
  );
});
