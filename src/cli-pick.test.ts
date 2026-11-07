import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createPicker } from './cli-pick.ts';

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
