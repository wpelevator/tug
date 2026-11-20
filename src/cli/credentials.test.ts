import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startMtlsControl } from '../../tests/helpers.ts';
import { execCli } from '../../tests/cli-inprocess.ts';
import { FakeDocker } from '../../tests/fake-docker.ts';

const OPERATOR = 'op-cli-tokens';

test('token commands reject malformed invocations before contacting control', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-token-args-'));
  const env = {
    ...process.env,
    TUG_CONFIG: path.join(dir, 'missing.json'),
    TUG_CONTROL_URL: 'http://unreachable.invalid',
  };
  try {
    const help = (await execCli(['--help'], { env, cwd: dir })).stdout;
    assert.ok(help.includes('credential'), 'help should list the credential group');
    const groups = (await execCli(['credential', '--help'], { env, cwd: dir })).stdout;
    for (const name of ['create', 'list', 'revoke'])
      assert.ok(groups.includes(name), `help for the credential group should list ${name}`);
    const createHelp = (await execCli(['credential', 'create', '--help'], { env, cwd: dir }))
      .stdout;
    assert.match(createHelp, /--role/, 'credential create help should document --role');
    assert.match(createHelp, /--expires-in-days/, 'credential create help should document expiry');
    for (const args of [
      ['credential', 'create', 'ci'],
      ['credential', 'create', 'ci', '--role', 'owner'],
      ['credential', 'create', 'bad name', '--role', 'read'],
      ['credential', 'create', 'operator-x/y', '--role', 'read'],
      ['credential', 'create', 'ci', '--role', 'deploy', '--project', 'bad/name'],
      ['credential', 'create', 'ci', '--role', 'admin', '--project', 'site'],
      ['credential', 'create', 'ci', '--role', 'read', '--expires-in-days', '0'],
      ['credential', 'create', 'ci', '--role', 'read', '--expires-in-days', 'soon'],
      ['credential', 'create', 'ci', '--role', 'read', 'extra'],
      ['credential', 'list', 'extra'],
      ['credential', 'revoke'],
      ['credential', 'revoke', 'a', 'b'],
      ['events', '--all', '--project', 'site'],
    ]) {
      await assert.rejects(
        execCli([...args], { env, cwd: dir }),
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

test('credential create, credential list and credential revoke work against control and a scoped credential works as TUG_TOKEN', async () => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-cli-tokens-'));
  const control = await startMtlsControl(data);
  const tug = (credential: string, ...args: string[]) =>
    execCli([...args], {
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
      'credential',
      'create',
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
      'credential create should print the new credential once on stdout',
    );
    assert.deepEqual(
      body.projects,
      ['blog', 'site'],
      'credential create should send every repeated --project',
    );
    assert.ok(body.expiresAt, 'credential create should send the expiry');
    assert.match(
      created.stderr,
      /not shown again/,
      'credential create should warn on stderr that the secret is shown once',
    );

    const mixed = JSON.parse(
      (
        await tug(
          OPERATOR,
          'credential',
          'create',
          'ci-list',
          '--role',
          'read',
          '--project',
          'site, blog',
          '--project',
          'docs',
        )
      ).stdout,
    );
    assert.deepEqual(
      mixed.projects,
      ['blog', 'docs', 'site'],
      'credential create should accept a comma-separated --project list mixed with repeated flags',
    );

    const listed = await tug(OPERATOR, 'credential', 'list');
    assert.ok(
      !listed.stdout.includes(body.credential) && !listed.stdout.includes('token_hash'),
      'credential list must never print secrets or hashes',
    );
    assert.equal(
      JSON.parse(listed.stdout).credentials.find((t: { name: string }) => t.name === 'ci-deploy')
        .name,
      'ci-deploy',
      'credential list should show the credential by name',
    );

    const status = await tug(body.credential, 'status', '--json');
    assert.ok(
      Array.isArray(JSON.parse(status.stdout).projects),
      'a scoped credential should work anywhere TUG_TOKEN does',
    );
    await assert.rejects(
      tug(body.credential, 'credential', 'list'),
      /403/,
      'a deploy credential cannot list tokens',
    );
    await assert.rejects(
      tug(body.credential, 'events', '--project', 'other'),
      /403/,
      'a scoped credential is refused other projects',
    );

    const events = JSON.parse((await tug(OPERATOR, 'events', '--all', '--json')).stdout).events;
    assert.equal(
      events[0].type,
      'credential.create',
      'tug events --all should include control audit events',
    );
    assert.equal(events[0].actor, 'root', 'tug events should show who acted');

    assert.equal(
      JSON.parse((await tug(OPERATOR, 'credential', 'revoke', 'ci-deploy')).stdout).ok,
      true,
      'credential revoke should confirm',
    );
    await assert.rejects(
      tug(body.credential, 'status', '--json'),
      /fetch failed|terminated|socket|ECONNRESET|closed|401/i,
      'the revoked credential should stop working: the connection gate refuses it',
    );
    await assert.rejects(
      tug(OPERATOR, 'credential', 'revoke', 'ghost'),
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
  const groupHelp = async (...group: string[]) =>
    (await execCli([...group, '--help'], { env, cwd: dir })).stdout;
  for (const [group, verbs] of [
    ['backup', ['run', 'list', 'password', 'destination']],
    ['backup destination', ['set', 'show', 'check', 'remove']],
    ['restore', ['run', 'list', 'resume', 'release']],
  ] as const) {
    const help = await groupHelp(...group.split(' '));
    for (const verb of verbs)
      assert.match(help, new RegExp(`^  ${verb}\\b`, 'm'), `${group} help should list ${verb}`);
  }
  assert.match(
    (await execCli(['--help'], { env, cwd: dir })).stdout,
    /^ {2}run\b/m,
    'help should list the one-off run command',
  );
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
  const run = (...args: string[]) => execCli([...args], { env, cwd: dir });
  try {
    const set = await run(
      'backup',
      'destination',
      'set',
      's3:https://s3.example.com/bucket/tug',
      '--no-check',
      '--env',
      'AWS_ACCESS_KEY_ID',
      '--env',
      'AWS_SECRET_ACCESS_KEY',
    );
    assert.ok(!set.stdout.includes('cli-secret-value'), 'set should not print the secret');
    const shown = JSON.parse((await run('backup', 'destination', 'show')).stdout);
    assert.equal(shown.url, 's3:https://s3.example.com/bucket/tug', 'show prints the url');
    assert.deepEqual(shown.envNames, ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']);
    await assert.rejects(
      run('backup', 'destination', 'set', 's3:https://s3.example.com/bucket/tug', '--no-check'),
      /need AWS_ACCESS_KEY_ID/,
      'a destination without its credentials is refused by control',
    );
    const removed = JSON.parse((await run('backup', 'destination', 'remove')).stdout);
    assert.equal(removed.removed, true, 'remove deletes the destination');
  } finally {
    await control.close();
  }
});

test('backup destination set checks the destination and check exits nonzero while a repository is unusable', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-backup-check-cli-'));
  const docker = new FakeDocker();
  docker.addImage('restic/restic:0.19.1');
  let code = 0;
  docker.execResponder = (cmd) =>
    cmd[1] === 'cat'
      ? {
          code,
          err:
            code === 10
              ? 'Fatal: repository does not exist: unable to open config file: <config/> does not exist\nIs there a repository at the following location?'
              : 'Fatal: unable to open config file: Stat: The specified bucket does not exist.',
        }
      : { code: 0 };
  const control = await startMtlsControl(dir, { docker });
  const env = {
    ...process.env,
    ...control.env,
    AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE',
    AWS_SECRET_ACCESS_KEY: 'cli-secret-value',
  };
  delete (env as Record<string, unknown>).TUG_CONFIG;
  const run = (...args: string[]) => execCli([...args], { env, cwd: dir });
  const setArgs = [
    'backup',
    'destination',
    'set',
    's3:https://s3.example.com/bucket/tug',
    '--env',
    'AWS_ACCESS_KEY_ID',
    '--env',
    'AWS_SECRET_ACCESS_KEY',
  ];
  try {
    code = 10;
    const created = await run(...setArgs);
    const body = JSON.parse(created.stdout);
    assert.equal(body.ok, true, 'set keeps printing the saved destination as one JSON document');
    assert.equal(
      body.check.repositories[0].state,
      'initialized',
      'a missing repository is created',
    );
    assert.match(created.stderr, /control host/, 'the output says where the check ran');

    code = 1;
    await assert.rejects(
      run(...setArgs),
      (error: Error & { code?: number; stderr?: string }) => {
        assert.notEqual(error.code, 0, 'a failed check exits nonzero');
        assert.match(
          error.stderr ?? '',
          /saved but is not usable yet/,
          'the stderr says it was saved',
        );
        assert.match(error.stderr ?? '', /_control/, 'the failing repository is listed');
        return true;
      },
      'set exits nonzero when the check fails',
    );
    const shown = JSON.parse((await run('backup', 'destination', 'show')).stdout);
    assert.equal(shown.checkResult.ok, false, 'the failed check is stored with the destination');

    await assert.rejects(
      run('backup', 'destination', 'check'),
      (error: Error & { code?: number }) => error.code !== 0,
      'check exits nonzero while a repository fails',
    );
    const password = await run('backup', 'password');
    assert.equal(
      JSON.parse(password.stdout).deployed,
      false,
      'the password is printed before a deploy',
    );
    assert.match(
      password.stderr,
      /has not been deployed yet: check the project name/,
      'an undeployed project gets a warning that the name feeds the password',
    );
    code = 0;
    const ok = await run('backup', 'destination', 'check');
    assert.equal(JSON.parse(ok.stdout).ok, true, 'check prints a passing result and exits zero');
  } finally {
    await control.close();
  }
});
