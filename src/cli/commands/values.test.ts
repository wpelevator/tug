import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startMtlsControl } from '../../../tests/helpers.ts';
import { cliOutcome, execCli } from '../../../tests/cli-inprocess.ts';
import { formatValueRows } from './values.ts';

test('formatValueRows hides secrets, shows variables, and says what a missing name needs', () => {
  const table = formatValueRows([
    { name: 'DB_PASSWORD', status: 'secret' },
    { name: 'TAG', status: 'var', value: 'v1' },
    { name: 'PORT', status: 'default' },
    { name: 'API_KEY', status: 'missing' },
  ]);
  assert.match(table, /DB_PASSWORD\s+secret\s+•••/, 'a secret value is never shown');
  assert.match(table, /TAG\s+var\s+v1/, 'a variable shows its value');
  assert.match(table, /PORT\s+default\s+\(default from the Compose file\)/, 'a default is named');
  assert.match(
    table,
    /API_KEY\s+missing\s+not set: tug secret set API_KEY, or tug var set API_KEY/,
    'a missing name says how to set it',
  );
});

test('tug values lists every referenced name with its kind and exits 1 while one is missing', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-values-'));
  const control = await startMtlsControl(dir);
  try {
    const env = { ...process.env, ...control.env, TUG_CREDENTIAL: '', CI: '1' };
    const tug = (args: string[]) => cliOutcome([...args, '--project', 'shop'], { cwd: dir, env });
    await fs.writeFile(
      path.join(dir, 'compose.yaml'),
      [
        'services:',
        '  web:',
        '    image: acme/web:${TAG}',
        '    environment:',
        '      DB_PASSWORD:',
        '      API_KEY: ${API_KEY}',
        '      PORT: ${PORT:-8080}',
        '',
      ].join('\n'),
    );
    await execCli(['secret', 'set', 'DB_PASSWORD', '--value', 'hunter2', '--project', 'shop'], {
      cwd: dir,
      env,
    });
    await execCli(['var', 'set', 'TAG', '--value', 'v1', '--project', 'shop'], { cwd: dir, env });
    const first = await tug(['values']);
    assert.equal(first.code, 1, 'a name that is not set makes the command fail, for scripts');
    assert.match(first.stdout, /TAG\s+var\s+v1/, 'a variable is listed with its value');
    assert.match(first.stdout, /DB_PASSWORD\s+secret\s+•••/, 'a bare environment key is checked');
    assert.match(first.stdout, /API_KEY\s+missing/, 'an unset required name is missing');
    assert.match(first.stdout, /PORT\s+default/, 'a name with a default is not missing');
    assert.ok(!first.stdout.includes('hunter2'), 'a secret value is never printed');
    await execCli(['secret', 'set', 'API_KEY', '--value', 'k', '--project', 'shop'], {
      cwd: dir,
      env,
    });
    const second = await tug(['values', '--json']);
    assert.equal(second.code, 0, 'everything required is set');
    const parsed = JSON.parse(second.stdout);
    assert.equal(parsed.project, 'shop', 'the JSON names the project');
    assert.deepEqual(
      parsed.values.map((v: { name: string; status: string }) => [v.name, v.status]),
      [
        ['TAG', 'var'],
        ['API_KEY', 'secret'],
        ['PORT', 'default'],
        ['DB_PASSWORD', 'secret'],
      ],
      'every referenced name is listed once with its status',
    );
  } finally {
    await control.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
