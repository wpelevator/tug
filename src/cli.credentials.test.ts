import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startMtlsControl } from '../tests/helpers.ts';

const exec = promisify(execFile);
const entry = path.resolve('src/cli.ts');
const OPERATOR = 'op-cli-tokens';

test('token commands reject malformed invocations before contacting control', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-token-args-'));
  const env = {
    ...process.env,
    TUG_CONFIG: path.join(dir, 'missing.json'),
    TUG_CONTROL_URL: 'http://unreachable.invalid',
  };
  try {
    const help = (await exec(process.execPath, [entry, '--help'], { env, cwd: dir })).stdout;
    for (const name of ['credential-create', 'credential-list', 'credential-revoke'])
      assert.ok(help.includes(name), `help should list flat command ${name}`);
    const createHelp = (
      await exec(process.execPath, [entry, 'credential-create', '--help'], { env, cwd: dir })
    ).stdout;
    assert.match(createHelp, /--role/, 'credential-create help should document --role');
    assert.match(createHelp, /--expires-in-days/, 'credential-create help should document expiry');
    for (const args of [
      ['credential-create', 'ci'],
      ['credential-create', 'ci', '--role', 'owner'],
      ['credential-create', 'bad name', '--role', 'read'],
      ['credential-create', 'operator-x/y', '--role', 'read'],
      ['credential-create', 'ci', '--role', 'deploy', '--project', 'bad/name'],
      ['credential-create', 'ci', '--role', 'admin', '--project', 'site'],
      ['credential-create', 'ci', '--role', 'read', '--expires-in-days', '0'],
      ['credential-create', 'ci', '--role', 'read', '--expires-in-days', 'soon'],
      ['credential-create', 'ci', '--role', 'read', 'extra'],
      ['credential-list', 'extra'],
      ['credential-revoke'],
      ['credential-revoke', 'a', 'b'],
      ['events', '--all', '--project', 'site'],
    ]) {
      await assert.rejects(
        exec(process.execPath, [entry, ...args], { env, cwd: dir }),
        (error) => {
          const stderr = (error as Error & { stderr: string }).stderr;
          assert.doesNotMatch(
            stderr,
            /fetch failed|ENOTFOUND|unreachable/,
            `invalid ${args.join(' ')} should fail before any API request`,
          );
          return true;
        },
        `${args.join(' ')} should be rejected`,
      );
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('credential-create, credential-list and credential-revoke work against control and a scoped credential works as TUG_TOKEN', async () => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-cli-tokens-'));
  const control = await startMtlsControl(data);
  const tug = (credential: string, ...args: string[]) =>
    exec(process.execPath, [entry, ...args], {
      env: {
        ...process.env,
        ...control.env,
        ...(credential === OPERATOR ? {} : { TUG_CREDENTIAL: credential, TUG_CREDENTIAL_FILE: '' }),
      },
      cwd: data,
    });
  try {
    const created = await tug(
      OPERATOR,
      'credential-create',
      'ci-deploy',
      '--role',
      'deploy',
      '--project',
      'site',
      '--project',
      'blog',
      '--expires-in-days',
      '30',
    );
    const body = JSON.parse(created.stdout);
    assert.match(
      body.credential,
      /^[A-Za-z0-9_-]{200,}$/,
      'credential-create should print the new credential once on stdout',
    );
    assert.deepEqual(
      body.projects,
      ['blog', 'site'],
      'credential-create should send every repeated --project',
    );
    assert.ok(body.expiresAt, 'credential-create should send the expiry');
    assert.match(
      created.stderr,
      /not shown again/,
      'credential-create should warn on stderr that the secret is shown once',
    );

    const listed = await tug(OPERATOR, 'credential-list');
    assert.ok(
      !listed.stdout.includes(body.credential) && !listed.stdout.includes('token_hash'),
      'credential-list must never print secrets or hashes',
    );
    assert.equal(
      JSON.parse(listed.stdout).credentials.find((t: { name: string }) => t.name === 'ci-deploy')
        .name,
      'ci-deploy',
      'credential-list should show the credential by name',
    );

    const status = await tug(body.credential, 'status');
    assert.ok(
      Array.isArray(JSON.parse(status.stdout).projects),
      'a scoped credential should work anywhere TUG_TOKEN does',
    );
    await assert.rejects(
      tug(body.credential, 'credential-list'),
      /403/,
      'a deploy credential cannot list tokens',
    );
    await assert.rejects(
      tug(body.credential, 'events', '--project', 'other'),
      /403/,
      'a scoped credential is refused other projects',
    );

    const events = JSON.parse((await tug(OPERATOR, 'events', '--all')).stdout).events;
    assert.equal(
      events[0].type,
      'credential.create',
      'tug events --all should include control audit events',
    );
    assert.equal(events[0].actor, 'root', 'tug events should show who acted');

    assert.equal(
      JSON.parse((await tug(OPERATOR, 'credential-revoke', 'ci-deploy')).stdout).ok,
      true,
      'credential-revoke should confirm',
    );
    await assert.rejects(
      tug(body.credential, 'status'),
      /fetch failed|terminated|socket|ECONNRESET|closed|401/i,
      'the revoked credential should stop working: the connection gate refuses it',
    );
    await assert.rejects(
      tug(OPERATOR, 'credential-revoke', 'ghost'),
      /404/,
      'revoking an unknown token should fail',
    );
  } finally {
    await control.close();
    await fs.rm(data, { recursive: true, force: true });
  }
});

test('backup commands are listed in help', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-backup-help-'));
  const env = { ...process.env, TUG_CONFIG: path.join(dir, 'missing.json') };
  const help = (await exec(process.execPath, [entry, '--help'], { env, cwd: dir })).stdout;
  for (const name of [
    'backup-run',
    'backup-list',
    'backup-destination-set',
    'backup-repository-password',
    'restore',
    'restore-list',
    'restore-resume',
    'restore-release',
    'run',
  ])
    assert.ok(help.includes(name), `help should list ${name}`);
});

test('backup destination commands set, show and remove the destination without echoing secrets', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-backup-cli-'));
  const control = await startMtlsControl(dir);
  const env = {
    ...process.env,
    ...control.env,
    AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE',
    AWS_SECRET_ACCESS_KEY: 'cli-secret-value',
  };
  delete (env as Record<string, unknown>).TUG_CONFIG;
  const run = (...args: string[]) => exec(process.execPath, [entry, ...args], { env, cwd: dir });
  try {
    const set = await run(
      'backup-destination-set',
      's3:https://s3.example.com/bucket/tug',
      '--env',
      'AWS_ACCESS_KEY_ID',
      '--env',
      'AWS_SECRET_ACCESS_KEY',
    );
    assert.ok(!set.stdout.includes('cli-secret-value'), 'set should not print the secret');
    const shown = JSON.parse((await run('backup-destination-show')).stdout);
    assert.equal(shown.url, 's3:https://s3.example.com/bucket/tug', 'show prints the url');
    assert.deepEqual(shown.envNames, ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']);
    await assert.rejects(
      run('backup-destination-set', 's3:https://s3.example.com/bucket/tug'),
      /need AWS_ACCESS_KEY_ID/,
      'a destination without its credentials is refused by control',
    );
    const removed = JSON.parse((await run('backup-destination-remove')).stdout);
    assert.equal(removed.removed, true, 'remove deletes the destination');
  } finally {
    await control.close();
  }
});
