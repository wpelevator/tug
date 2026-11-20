import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  backupReferences,
  escapeReference,
  missingValuesMessage,
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
import { testRuntime } from '../../tests/cli-runtime.ts';

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
        await findMissingValues(process.cwd(), file, new Set(['A'])),
        ['B', 'C', 'D'],
        'a name in .env is still missing unless control holds it',
      );
      await fs.writeFile(file, 'x: ${A} ${TUG_TEST_SHELL_VALUE}\n');
      assert.deepEqual(
        await findMissingValues(process.cwd(), file, new Set(['A'])),
        ['TUG_TEST_SHELL_VALUE'],
        'an exported shell variable is still missing unless control holds it',
      );
    } finally {
      delete process.env.TUG_TEST_SHELL_VALUE;
    }
    assert.deepEqual(
      await findMissingValues(dir, path.join(dir, 'absent.yml'), new Set()),
      [],
      'an unreadable file is left to the Compose reader to report',
    );
  });
});

test('describeValues says where each name came from, in file order, and shows no secret value', async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, 'compose.yaml');
    await fs.writeFile(file, 'x: ${DB_PASSWORD} ${TAG} ${HOST} ${REGION:-eu} ${HOST}\n');
    const values = await describeValues(process.cwd(), file, {
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
      await ignoredSourceNotes(dir, file, new Set(), {}),
      [],
      'no .env and no profiles means nothing to say',
    );
    await fs.writeFile(path.join(dir, '.env'), 'DB_PASSWORD=x\nexport MAIL_HOST=y\nKNOWN=z\n');
    const [note] = await ignoredSourceNotes(dir, file, new Set(['KNOWN']), {});
    assert.match(note, /Ignored \.env/, 'the note says .env was ignored');
    assert.match(
      note,
      /3 names, 2 not set on control \(DB_PASSWORD, MAIL_HOST\)/,
      'it counts the names control lacks',
    );
    assert.match(note, /tug secret import \.env/, 'it points at the import command');
    assert.ok(!note.includes('=x'), 'a value from .env is never echoed');
    const notes = await ignoredSourceNotes(dir, file, new Set(), { COMPOSE_PROFILES: 'debug' });
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

test('classifyEnvFile guesses nothing: the command decides, and explicit lists override it', () => {
  const text =
    'DB_PASSWORD=p\nAPP_ENV=prod\nDATABASE_URL=postgres://u:p@h/db\nBARE\nTUG_REGISTRY_AUTH=x\n';
  const secrets = classifyEnvFile(text, { fallback: 'secret', vars: ['APP_ENV'] });
  assert.deepEqual(
    secrets.entries.map((e) => [e.name, e.kind]),
    [
      ['DB_PASSWORD', 'secret'],
      ['APP_ENV', 'var'],
      ['DATABASE_URL', 'secret'],
    ],
    'a secret import makes every entry a secret unless it is named as a variable, whatever the name or value looks like',
  );
  assert.equal(secrets.skipped.length, 2, 'a bare name and a reserved name are skipped');
  const vars = classifyEnvFile(text, { fallback: 'var', secrets: ['DB_PASSWORD', 'DATABASE_URL'] });
  assert.deepEqual(
    vars.entries.map((e) => [e.name, e.kind]),
    [
      ['DB_PASSWORD', 'secret'],
      ['APP_ENV', 'var'],
      ['DATABASE_URL', 'secret'],
    ],
    'a variable import keeps every entry a variable unless it is named as a secret',
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
    testRuntime().rt,
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

const BACKUP_FILE = [
  'services:',
  '  db:',
  '    image: mariadb:11',
  '    x-tug:',
  '      backup:',
  '        command: mariadb-dump -uroot -p"$MARIADB_ROOT_PASSWORD" --all-databases',
  '        restore: mariadb -uroot -p"${MARIADB_ROOT_PASSWORD}"',
].join('\n');

test('missingValuesMessage explains a single-$ name inside x-tug.backup as a container variable and shows the $$ line', () => {
  const message = missingValuesMessage(
    'compose.yaml',
    BACKUP_FILE,
    ['MARIADB_ROOT_PASSWORD'],
    false,
  );
  assert.match(
    message,
    /needs values that are not set on control: MARIADB_ROOT_PASSWORD/,
    'the standard message stays',
  );
  assert.match(
    message,
    /variable of the container/,
    'the hint says it may be a container variable',
  );
  assert.match(
    message,
    /mariadb-dump -uroot -p"\$\$MARIADB_ROOT_PASSWORD" --all-databases/,
    'the hint shows the corrected command line with $$',
  );
});

test('missingValuesMessage keeps the standard message for a name outside x-tug.backup', () => {
  const message = missingValuesMessage(
    'compose.yaml',
    'services:\n  web:\n    image: nginx\n    environment:\n      A: ${TOKEN}\n    x-tug:\n      backup:\n        command: echo "$OTHER"\n',
    ['TOKEN'],
    true,
  );
  assert.doesNotMatch(
    message,
    /variable of the container/,
    'no backup hint for a name that is not in a backup field',
  );
  assert.match(message, /TOKEN/, 'the missing name is listed');
});

test('backupReferences ignores an escaped $$ and escapeReference doubles both ${NAME} and $NAME forms', () => {
  assert.equal(
    backupReferences('services:\n  a:\n    x-tug:\n      backup:\n        command: echo $$A\n', [
      'A',
    ]).size,
    0,
    'an already escaped name is not a Compose reference',
  );
  assert.equal(
    escapeReference('p="${PW}" q=$PW r=$$PW s=$PWX', 'PW'),
    'p="$${PW}" q=$$PW r=$$PW s=$PWX',
    'single-$ references to the name are doubled and nothing else changes',
  );
});

test('bare environment keys are required values, and KEY: "" or KEY= is a literal empty value', () => {
  const source = [
    'services:',
    '  web:',
    '    image: nginx',
    '    environment:',
    '      PASSTHROUGH:',
    '      EXPLICIT: ${EXPLICIT}',
    '      LITERAL_EMPTY: ""',
    '      LITERAL_VALUE: x',
    '  worker:',
    '    image: nginx',
    '    environment:',
    '      - LIST_BARE',
    '      - LIST_EMPTY=',
    '      - LIST_VALUE=y',
  ].join('\n');
  assert.deepEqual(
    requiredVariables(source),
    ['EXPLICIT', 'PASSTHROUGH', 'LIST_BARE'],
    'a bare key in either syntax is required like ${NAME}; an empty literal is not',
  );
  assert.deepEqual(
    referencedVariables(source),
    ['EXPLICIT', 'PASSTHROUGH', 'LIST_BARE'],
    'a bare key is listed among the referenced names, once',
  );
});

test('a bare key that control holds is described with its source and one that it lacks is missing', async () => {
  await withDir(async (dir) => {
    await fs.writeFile(
      path.join(dir, 'compose.yaml'),
      'services:\n  web:\n    image: nginx\n    environment:\n      TOKEN:\n      REGION:\n      EMPTY: ""\n',
    );
    assert.deepEqual(
      await findMissingValues(dir, 'compose.yaml', new Set(['REGION'])),
      ['TOKEN'],
      'only the bare key control does not hold is missing',
    );
    assert.deepEqual(
      await describeValues(dir, 'compose.yaml', {
        secrets: new Set(['TOKEN']),
        vars: new Map([['REGION', { version: 2, value: 'eu' }]]),
        flags: {},
      }),
      [
        { name: 'TOKEN', source: 'secret' },
        { name: 'REGION', source: 'var', version: 2, value: 'eu' },
      ],
      'bare keys are recorded with their source, and the literal empty value is not listed',
    );
  });
});

test('the missing-values message explains how to pass an empty string for a bare key', () => {
  const source = 'services:\n  web:\n    image: nginx\n    environment:\n      - TOKEN\n';
  const message = missingValuesMessage('compose.yaml', source, ['TOKEN'], false);
  assert.match(message, /TOKEN is listed under environment without a value/, 'names the bare key');
  assert.match(message, /NAME: ""/, 'shows the literal empty syntax');
});
