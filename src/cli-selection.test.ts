import assert from 'node:assert/strict';
import test from 'node:test';
import { selectMany, selectOne } from './cli-selection.ts';
import type { SelectionIO } from './cli-selection.ts';

const choices = async () => [
  { value: 'service:db', label: 'Database' },
  { value: 'volume:files', label: 'Files' },
];
function io(
  answers: string[],
  interactive = true,
): SelectionIO & { output: string[]; questions: string[] } {
  const output: string[] = [];
  const questions: string[] = [];
  return {
    interactive,
    output,
    questions,
    write: (value) => output.push(value),
    prompt: async (question) => {
      questions.push(question);
      assert.ok(answers.length, 'selection should finish after the supplied answers');
      return answers.shift()!;
    },
  };
}
test('explicit targets bypass terminal checks, fetching and prompts', async () => {
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
  assert.deepEqual(terminal.questions, [], 'explicit targets must never prompt');
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
  assert.deepEqual(terminal.questions, [], 'scripts must not consume input');
});
test('single-choice requires a deliberate valid number and prints labels', async () => {
  const terminal = io(['', '0', '3', '1,2', '1.0', ' 2 ']);
  assert.equal(
    await selectOne(undefined, 'Target', choices, terminal),
    'volume:files',
    'a valid menu number should return its stable API value',
  );
  assert.deepEqual(
    terminal.output,
    ['Target', '  1) Database', '  2) Files'],
    'the menu should print readable labels separately from its values',
  );
  assert.equal(terminal.questions.length, 6, 'blank and invalid input must not select the default');
});
test('even a sole destructive target requires an explicit choice', async () => {
  const terminal = io(['', '1']);
  assert.equal(
    await selectOne(undefined, 'Delete', async () => [{ value: 'one', label: 'One' }], terminal),
    'one',
    'one target should still require selecting its number',
  );
  assert.equal(terminal.questions.length, 2, 'an empty answer must not accept the only target');
});
test('multi-choice rejects invalid entries and deduplicates selected values', async () => {
  const terminal = io(['', '1,', '0,2', '1,3', '2, 1,2']);
  assert.deepEqual(
    await selectMany('Targets', choices, terminal),
    ['volume:files', 'service:db'],
    'multi-choice should return unique values in chosen order',
  );
});
test('empty menus, cancellation and EOF abort without returning targets', async () => {
  await assert.rejects(
    selectMany('Targets', async () => [], io([])),
    /no eligible options/,
    'empty menus should explain the absence of candidates',
  );
  await assert.rejects(
    selectOne(undefined, 'Target', choices, io(['q'])),
    /cancelled; nothing was changed/,
    'cancellation should abort the command',
  );
  await assert.rejects(
    selectMany('Targets', choices, {
      ...io([]),
      prompt: async () => {
        throw new Error('input closed before an answer was given');
      },
    }),
    /input closed/,
    'EOF should propagate without selecting a target',
  );
});
