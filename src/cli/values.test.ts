import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  classifyEnvFile,
  describeValues,
  findMissingValues,
  generateSecret,
  ignoredSourceNotes,
  parseVarFlags,
  promptForValues,
  referencedVariables,
  requiredVariables,
} from './values.ts';

async function withDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-values-'));
  try {
    return await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('requiredVariables lists variables without defaults and ignores escapes and comments', () => {
  const names = requiredVariables(
    [
      '# ${COMMENTED}',
      'a: ${DB_PASSWORD}',
      'b: $TOKEN',
      'c: ${WITH_DEFAULT:-x}',
      'd: $$LITERAL',
      'e: ${DB_PASSWORD}',
    ].join('\n'),
  );
  assert.deepEqual(names, ['DB_PASSWORD', 'TOKEN'], 'only unique required variables are listed');
});

test('referencedVariables lists every name, defaults and nested defaults included', () => {
  const names = referencedVariables(
    ['# ${COMMENTED}', 'a: ${A:-${B}}', 'b: $C', 'c: ${D:?needed}', 'd: $$ESCAPED', 'e: ${A}'].join(
      '\n',
    ),
  );
  assert.deepEqual(
    names,
    ['A', 'B', 'C', 'D'],
    'a name with a default, one nested in a default and a required one are all referenced, escapes are not',
  );
});

test('findMissingValues counts only what control or --var supplies, never .env or the shell', async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, 'docker-compose.yml');
    await fs.writeFile(file, 'x: ${A} ${B} ${C} ${D}\n');
    await fs.writeFile(path.join(dir, '.env'), 'D=1\n');
    process.env.TUG_TEST_SHELL_VALUE = 'set';
    try {
      assert.deepEqual(
        await findMissingValues(file, new Set(['A'])),
        ['B', 'C', 'D'],
        'a name in .env is still missing unless control holds it',
      );
      await fs.writeFile(file, 'x: ${A} ${TUG_TEST_SHELL_VALUE}\n');
      assert.deepEqual(
        await findMissingValues(file, new Set(['A'])),
        ['TUG_TEST_SHELL_VALUE'],
        'an exported shell variable is still missing unless control holds it',
      );
    } finally {
      delete process.env.TUG_TEST_SHELL_VALUE;
    }
    assert.deepEqual(
      await findMissingValues(path.join(dir, 'absent.yml'), new Set()),
      [],
      'an unreadable file is left to the Compose reader to report',
    );
  });
});

test('describeValues says where each name came from, in file order, and shows no secret value', async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, 'compose.yaml');
    await fs.writeFile(file, 'x: ${DB_PASSWORD} ${TAG} ${HOST} ${REGION:-eu} ${HOST}\n');
    const values = await describeValues(file, {
      secrets: new Set(['DB_PASSWORD']),
      vars: new Map([['HOST', { version: 3, value: 'db.internal' }]]),
      flags: { TAG: 'abc123' },
    });
    assert.deepEqual(
      values,
      [
        { name: 'DB_PASSWORD', source: 'secret' },
        { name: 'TAG', source: '--var', value: 'abc123' },
        { name: 'HOST', source: 'var', version: 3, value: 'db.internal' },
        { name: 'REGION', source: 'default' },
      ],
      'a --var, a secret, a stored variable and a file default each get their own source',
    );
  });
});

test('ignoredSourceNotes names what Tug ignored: .env entries control lacks, and COMPOSE_PROFILES', async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, 'compose.yaml');
    await fs.writeFile(file, 'services: {}\n');
    assert.deepEqual(
      await ignoredSourceNotes(file, new Set(), {}),
      [],
      'no .env and no profiles means nothing to say',
    );
    await fs.writeFile(path.join(dir, '.env'), 'DB_PASSWORD=x\nexport MAIL_HOST=y\nKNOWN=z\n');
    const [note] = await ignoredSourceNotes(file, new Set(['KNOWN']), {});
    assert.match(note, /Ignored \.env/, 'the note says .env was ignored');
    assert.match(
      note,
      /3 names, 2 not set on control \(DB_PASSWORD, MAIL_HOST\)/,
      'it counts the names control lacks',
    );
    assert.match(note, /tug secret import \.env/, 'it points at the import command');
    assert.ok(!note.includes('=x'), 'a value from .env is never echoed');
    const notes = await ignoredSourceNotes(file, new Set(), { COMPOSE_PROFILES: 'debug' });
    assert.match(
      notes.join('\n'),
      /COMPOSE_PROFILES=debug.*--profile/,
      'a shell COMPOSE_PROFILES is reported and --profile suggested',
    );
  });
});

test('parseVarFlags splits on the first equals sign and rejects bad, reserved and repeated names', () => {
  assert.deepEqual(
    parseVarFlags(['TAG=a=b,c', 'EMPTY=']),
    { TAG: 'a=b,c', EMPTY: '' },
    'a value may contain equals signs and commas, and may be empty',
  );
  assert.throws(() => parseVarFlags(['NOVALUE']), /NAME=value/, 'a flag without = is refused');
  assert.throws(() => parseVarFlags(['1BAD=x']), /names start with/, 'an invalid name is refused');
  assert.throws(
    () => parseVarFlags(['TUG_REGISTRY_AUTH=x']),
    /reserved/,
    'a reserved name is refused',
  );
  assert.throws(() => parseVarFlags(['A=1', 'A=2']), /twice/, 'a repeated name is refused');
});

test('classifyEnvFile sorts credentials from configuration and honours explicit lists', () => {
  const text = 'DB_PASSWORD=p\nAPP_ENV=prod\nAWS_ACCESS_KEY_ID=k\nBARE\nTUG_REGISTRY_AUTH=x\n';
  const sorted = classifyEnvFile(text, { sorted: true });
  assert.deepEqual(
    sorted.entries.map((e) => [e.name, e.kind]),
    [
      ['DB_PASSWORD', 'secret'],
      ['APP_ENV', 'var'],
      ['AWS_ACCESS_KEY_ID', 'secret'],
    ],
    'credential-like names become secrets and the rest variables',
  );
  assert.equal(sorted.skipped.length, 2, 'a bare name and a reserved name are skipped');
  const unsorted = classifyEnvFile(text, { sorted: false, fallback: 'secret', vars: ['APP_ENV'] });
  assert.deepEqual(
    unsorted.entries.map((e) => [e.name, e.kind]),
    [
      ['DB_PASSWORD', 'secret'],
      ['APP_ENV', 'var'],
      ['AWS_ACCESS_KEY_ID', 'secret'],
    ],
    'without a terminal an entry is a secret unless it is named as a variable',
  );
  const vars = classifyEnvFile(text, { sorted: false, fallback: 'var', secrets: ['DB_PASSWORD'] });
  assert.deepEqual(
    vars.entries.map((e) => [e.name, e.kind]),
    [
      ['DB_PASSWORD', 'secret'],
      ['APP_ENV', 'var'],
      ['AWS_ACCESS_KEY_ID', 'var'],
    ],
    'a variable import keeps everything a variable unless it is named as a secret',
  );
});

test('generateSecret is long, URL-safe and unique', () => {
  const a = generateSecret();
  assert.match(a, /^[A-Za-z0-9_-]{32}$/, 'a secret must be 32 URL-safe characters');
  assert.notEqual(a, generateSecret(), 'secrets must be random');
});

test('promptForValues generates by default and accepts an entered secret or variable', async () => {
  const answers = ['', 'e', 'hunter2', 'v', 'eu-west-1'];
  const values = await promptForValues(
    ['ONE', 'TWO', 'THREE'],
    async () => answers.shift() as string,
  );
  assert.equal(values.ONE.kind, 'secret', 'an empty answer generates a secret');
  assert.equal(values.ONE.value.length, 32, 'the generated secret is 32 characters');
  assert.deepEqual(values.TWO, { kind: 'secret', value: 'hunter2' }, 'e enters a secret');
  assert.deepEqual(
    values.THREE,
    { kind: 'var', value: 'eu-west-1' },
    'v enters a visible variable',
  );
});
