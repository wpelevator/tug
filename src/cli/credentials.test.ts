import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startMtlsControl } from '../../tests/helpers.ts';
import { once } from 'node:events';
import { createServer } from 'node:https';
import { Pki, identityUri, serverNames } from '../pki.ts';
import { packageVersion } from '../images/image.ts';
import { serverTlsOptions } from '../control/tls-server.ts';
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

test('credential create --raw prints only the token, which works as TUG_CREDENTIAL, and keeps the notice on stderr', async () => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-cli-raw-'));
  const control = await startMtlsControl(data);
  try {
    const run = (env: Record<string, string>, ...args: string[]) =>
      execCli([...args], { env: { ...process.env, ...control.env, ...env }, cwd: data });
    const raw = await run({}, 'credential', 'create', 'ci-raw', '--role', 'read', '--raw');
    assert.match(
      raw.stdout,
      /^[A-Za-z0-9_-]{200,}\n$/,
      '--raw prints the token and a newline, nothing else',
    );
    assert.match(raw.stderr, /not shown again/, 'the one-time notice stays on stderr');
    await run({ TUG_CREDENTIAL: raw.stdout.trim(), TUG_CREDENTIAL_FILE: '' }, 'status');
    const json = await run({}, 'credential', 'create', 'ci-json', '--role', 'read');
    await run({ TUG_CREDENTIAL: json.stdout, TUG_CREDENTIAL_FILE: '' }, 'status');
  } finally {
    await control.close();
    await fs.rm(data, { recursive: true, force: true });
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

    assert.match(
      created.stderr,
      /created a new, empty repository at .*_control/,
      'a repository that was just created is not reported as plain success',
    );

    code = 1;
    const failed = await run(...setArgs);
    assert.equal(
      JSON.parse(failed.stdout).check.ok,
      false,
      'a failed check still exits 0 after a successful save and is reported in the JSON',
    );
    assert.match(
      failed.stderr,
      /saved; the check failed for _control.*tug backup destination check/,
    );
    assert.match(
      failed.stderr,
      /control's own nightly backup will fail/,
      'the stderr says what it means',
    );
    assert.match(
      failed.stderr,
      /Checked from the control host/,
      'the stderr says where the check ran',
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

test('backup destination set against a control without the check route saves, warns on stderr and exits 0', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-old-control-'));
  const pki = await Pki.load(path.join(dir, 'pki'), true);
  const issued = await pki.issueServer(serverNames('https://localhost:8443'));
  const client = await pki.issueClient(
    identityUri('operator', 'o1'),
    86_400_000,
    'https://localhost:8443',
  );
  const routes: string[] = [];
  // An older control: it stores the destination but has never heard of /api/v1/backup/destination/check.
  const https = createServer(
    serverTlsOptions({ cert: issued.cert, key: issued.key, ca: pki.caPem }),
    (req, res) => {
      routes.push(`${req.method} ${req.url}`);
      res.setHeader('content-type', 'application/json');
      res.setHeader('x-tug-version', packageVersion());
      if (req.url === '/api/v1/version') {
        res.end(JSON.stringify({ v: packageVersion() }));
        return;
      }
      if (req.url === '/api/v1/backup/destination' && req.method === 'POST') {
        res.end(
          JSON.stringify({ ok: true, url: 'rest:http://backup.internal:8000/tug', envNames: [] }),
        );
        return;
      }
      res.statusCode = 404;
      res.setHeader('content-type', 'text/plain');
      res.end(`Cannot ${req.method} ${req.url}`);
    },
  );
  https.listen(0, '127.0.0.1');
  await once(https, 'listening');
  const credentialFile = path.join(dir, 'operator.credential.json');
  await fs.writeFile(credentialFile, JSON.stringify(client.credential), { mode: 0o600 });
  const env = {
    ...process.env,
    TUG_CONTROL_URL: `https://127.0.0.1:${(https.address() as { port: number }).port}`,
    TUG_CREDENTIAL_FILE: credentialFile,
    TUG_CONFIG: '',
  };
  try {
    const result = await execCli(
      ['backup', 'destination', 'set', 'rest:http://backup.internal:8000/tug'],
      { env, cwd: dir },
    );
    assert.equal(JSON.parse(result.stdout).ok, true, 'the destination is saved and printed');
    assert.ok(
      routes.includes('POST /api/v1/backup/destination/check'),
      'the CLI asks the control to check the destination',
    );
    assert.match(
      result.stderr,
      /saved; this control is too old to check destinations/,
      'stderr warns that this control cannot check destinations',
    );
  } finally {
    https.closeAllConnections();
    await new Promise<void>((resolve) => https.close(() => resolve()));
  }
});

/** A control that accepts a destination check and serves `results` one per poll (the last one repeats). */
async function stubCheckControl(results: unknown[]) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-check-poll-'));
  const pki = await Pki.load(path.join(dir, 'pki'), true);
  const issued = await pki.issueServer(serverNames('https://localhost:8443'));
  const client = await pki.issueClient(
    identityUri('operator', 'o1'),
    86_400_000,
    'https://localhost:8443',
  );
  let polls = 0;
  const https = createServer(
    serverTlsOptions({ cert: issued.cert, key: issued.key, ca: pki.caPem }),
    (req, res) => {
      res.setHeader('content-type', 'application/json');
      res.setHeader('x-tug-version', packageVersion());
      if (req.url === '/api/v1/version')
        return void res.end(JSON.stringify({ v: packageVersion() }));
      if (req.url === '/api/v1/backup/destination/check' && req.method === 'POST') {
        res.statusCode = 202;
        return void res.end(JSON.stringify({ checkId: 'chk_1', state: 'running' }));
      }
      if (req.url === '/api/v1/backup/destination' && req.method === 'POST')
        return void res.end(JSON.stringify({ ok: true, url: 'rest:http://b/tug', envNames: [] }));
      if (req.url === '/api/v1/backup/destination' && req.method === 'GET')
        return void res.end(
          JSON.stringify({
            configured: true,
            checkResult: results[Math.min(polls++, results.length - 1)],
          }),
        );
      res.statusCode = 404;
      res.end('{}');
    },
  );
  https.listen(0, '127.0.0.1');
  await once(https, 'listening');
  const credentialFile = path.join(dir, 'operator.credential.json');
  await fs.writeFile(credentialFile, JSON.stringify(client.credential), { mode: 0o600 });
  return {
    dir,
    polls: () => polls,
    env: {
      ...process.env,
      TUG_CONTROL_URL: `https://127.0.0.1:${(https.address() as { port: number }).port}`,
      TUG_CREDENTIAL_FILE: credentialFile,
      TUG_CONFIG: '',
      TUG_CHECK_POLL_MS: '10',
      TUG_CHECK_TIMEOUT_MS: '400',
    },
    close: async () => {
      https.closeAllConnections();
      await new Promise<void>((resolve) => https.close(() => resolve()));
    },
  };
}
const checkBase = {
  checkId: 'chk_1',
  from: 'control',
  url: 'rest:http://b/tug',
  repositories: [{ name: '_control', repository: 'rest:http://b/tug/_control', state: 'ok' }],
};

test('backup destination check polls until its check is done and prints one line per repository and node', async () => {
  const done = {
    ...checkBase,
    state: 'done',
    ok: false,
    nodes: [
      { project: 'site', node: 'web-1', state: 'ok' },
      { project: 'site', node: 'web-2', state: 'missing' },
      { project: 'blog', node: 'web-1', state: 'error', error: 'dial tcp: i/o timeout' },
      { project: 'blog', node: 'web-3', state: 'offline', error: 'the node is stale' },
      { project: 'shop', node: 'web-4', state: 'timeout', error: 'did not answer within 180 s' },
    ],
  };
  const control = await stubCheckControl([
    {
      ...checkBase,
      state: 'running',
      nodes: [{ project: 'site', node: 'web-1', state: 'pending' }],
    },
    done,
  ]);
  try {
    await assert.rejects(
      execCli(['backup', 'destination', 'check'], { env: control.env, cwd: control.dir }),
      (error: Error & { code: number; stdout: string; stderr: string }) => {
        assert.equal(error.code, 1, 'check exits 1 when a node cannot reach the destination');
        assert.equal(JSON.parse(error.stdout).state, 'done', 'stdout is the finished result');
        for (const line of [
          /from control's host: ok: _control/,
          /node web-1 \(project site\): reaches the destination/,
          /node web-2 \(project site\): repository not created yet; the first backup creates it/,
          /node web-1 \(project blog\): cannot reach the destination: dial tcp: i\/o timeout/,
          /node web-3 \(project blog\): offline/,
          /node web-4 \(project shop\): did not answer within 180 s/,
        ])
          assert.match(error.stderr, line, `stderr should show ${line}`);
        return true;
      },
    );
    assert.ok(control.polls() >= 2, 'the CLI kept polling while the check was running');
  } finally {
    await control.close();
  }
});

test('backup destination check stops waiting at its deadline, points to show and exits 1; set still exits 0', async () => {
  const running = { ...checkBase, state: 'running', nodes: [] };
  const control = await stubCheckControl([running]);
  try {
    await assert.rejects(
      execCli(['backup', 'destination', 'check'], { env: control.env, cwd: control.dir }),
      (error: Error & { code: number; stdout: string; stderr: string }) => {
        assert.equal(error.code, 1, 'an unfinished check is not a pass');
        assert.match(error.stderr, /still running.*tug backup destination show/);
        assert.equal(
          JSON.parse(error.stdout).state,
          'running',
          'stdout carries the partial result',
        );
        return true;
      },
    );
    const set = await execCli(['backup', 'destination', 'set', 'rest:http://b/tug'], {
      env: control.env,
      cwd: control.dir,
    });
    assert.equal(JSON.parse(set.stdout).ok, true, 'the destination is saved');
    assert.match(set.stderr, /saved; the check is still running/, 'set warns and exits 0');
  } finally {
    await control.close();
  }
});
