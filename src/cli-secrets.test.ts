import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  findMissingSecrets,
  generateSecret,
  promptForSecrets,
  requiredVariables,
} from './cli-secrets.ts';

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

test('findMissingSecrets skips control secrets, the environment and .env', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-missing-'));
  try {
    const file = path.join(dir, 'docker-compose.yml');
    await fs.writeFile(file, 'x: ${A} ${B} ${C} ${D}\n');
    await fs.writeFile(path.join(dir, '.env'), 'D=1\n');
    assert.deepEqual(
      await findMissingSecrets(file, ['A'], { B: 'set' }),
      ['C'],
      'only a variable nothing supplies is missing',
    );
    assert.deepEqual(
      await findMissingSecrets(path.join(dir, 'absent.yml'), []),
      [],
      'an unreadable file is left to Compose to report',
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('generateSecret is long, URL-safe and unique', () => {
  const a = generateSecret();
  assert.match(a, /^[A-Za-z0-9_-]{32}$/, 'a secret must be 32 URL-safe characters');
  assert.notEqual(a, generateSecret(), 'secrets must be random');
});

test('promptForSecrets generates by default and accepts an entered value', async () => {
  const answers = ['', 'e', 'hunter2'];
  const values = await promptForSecrets(['ONE', 'TWO'], async () => answers.shift() as string);
  assert.equal(values.ONE.length, 32, 'an empty answer generates a secret');
  assert.equal(values.TWO, 'hunter2', 'choosing to enter stores the typed value');
});
