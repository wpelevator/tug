import assert from 'node:assert/strict';
import test from 'node:test';
import { selectMany, selectOne } from './selection.ts';
import type { SelectionIO } from './selection.ts';

const choices = async () => [
  { value: 'service:db', label: 'Database' },
  { value: 'volume:files', label: 'Files' },
];
/** A scripted picker: each call consumes one answer and records the menu it was shown. */
function io(
  answers: (number | number[] | Error)[],
  interactive = true,
): SelectionIO & { menus: { question: string; labels: readonly string[] }[] } {
  const menus: { question: string; labels: readonly string[] }[] = [];
  const next = (question: string, labels: readonly string[]) => {
    menus.push({ question, labels });
    assert.ok(answers.length, 'selection should finish after the supplied answers');
    const answer = answers.shift()!;
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return {
    interactive,
    menus,
    one: async (question, labels) => next(question, labels) as number,
    many: async (question, labels) => next(question, labels) as number[],
  };
}
test('explicit targets bypass terminal checks, fetching and menus', async () => {
  const terminal = io([], false);
  assert.equal(
    await selectOne(
      'db',
      'Target',
      async () => assert.fail('explicit targets must not fetch choices'),
      terminal,
    ),
    'db',
    'an explicit target should be returned unchanged',
  );
  assert.deepEqual(terminal.menus, [], 'explicit targets must never show a menu');
});
test('scripts fail before fetching choices or consuming stdin', async () => {
  const terminal = io([], false);
  for (const run of [
    () => selectOne(undefined, 'Target', choices, terminal),
    () => selectMany('Targets', choices, terminal),
  ]) {
    await assert.rejects(
      run,
      /explicit target.*terminal outside CI/,
      'noninteractive selection should explain how to supply a target',
    );
  }
  assert.deepEqual(terminal.menus, [], 'scripts must not consume input');
});
test('single-choice shows readable labels and returns the stable API value', async () => {
  const terminal = io([1]);
  assert.equal(
    await selectOne(undefined, 'Target', choices, terminal),
    'volume:files',
    'the chosen index should map back to its stable API value',
  );
  assert.deepEqual(
    terminal.menus,
    [{ question: 'Target', labels: ['Database', 'Files'] }],
    'the menu should show readable labels separately from its values',
  );
});
test('multi-choice maps the chosen indexes to their values', async () => {
  assert.deepEqual(
    await selectMany('Targets', choices, io([[0, 1]])),
    ['service:db', 'volume:files'],
    'multi-choice should return the value of every chosen entry',
  );
});
test('empty menus, cancellation and EOF abort without returning targets', async () => {
  await assert.rejects(
    selectMany('Targets', async () => [], io([])),
    /no eligible options/,
    'empty menus should explain the absence of candidates',
  );
  await assert.rejects(
    selectOne(undefined, 'Target', choices, io([new Error('cancelled; nothing was changed')])),
    /cancelled; nothing was changed/,
    'cancellation should abort the command',
  );
  await assert.rejects(
    selectMany('Targets', choices, io([new Error('input closed before an answer was given')])),
    /input closed/,
    'EOF should propagate without selecting a target',
  );
});
