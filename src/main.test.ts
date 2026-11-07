import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { agentIdentityCsr, installIdentity } from './agent-credential.ts';
import { NODE_LIFETIME_MS, Pki, identityUri } from './pki.ts';
import type { IdentityResponse } from './protocol.ts';

const exec = promisify(execFile);
const entry = path.resolve('src/main.ts');

test('--help prints usage for the runtime instead of starting a service', async () => {
  for (const args of [['control', '--help'], ['agent', '--help'], ['--help']]) {
    const { stdout } = await exec(process.execPath, [entry, ...args], { timeout: 10_000 });
    assert.match(stdout, /Usage: tug-runtime/, `${args.join(' ')} should print usage and exit`);
  }
});

test('agent identity --current refuses an agent enrolled as another node with a plain message', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-main-identity-'));
  const pki = await Pki.load(await fs.mkdtemp(path.join(os.tmpdir(), 'tug-main-pki-')), true);
  const csr = await agentIdentityCsr(dir);
  const signed = await pki.signClientCsr(csr, identityUri('node', 'n1'), NODE_LIFETIME_MS);
  await installIdentity(dir, {
    node: { id: 'n1', name: 'app1' } as IdentityResponse['node'],
    certificate: signed.cert,
    ca: pki.caPem,
    url: 'https://control.test:8443',
  });
  const env = { ...process.env, TUG_STATE_DIR: dir };
  const run = (...args: string[]) =>
    exec(process.execPath, [entry, 'agent', 'identity', ...args], { env, timeout: 10_000 });
  await assert.rejects(
    run('--current', 'app9'),
    (error: { code: number; stderr: string }) => {
      assert.equal(error.code, 1, 'the refusal must fail the SSH command so node add stops');
      assert.match(
        error.stderr,
        /^error: this host is enrolled as node app1, not app9/,
        'the operator sees the reason first',
      );
      assert.doesNotMatch(error.stderr, /\n\s+at /, 'the operator must not see a stack trace');
      return true;
    },
    'adding another name on an enrolled host must be refused',
  );
  const same = await run('--current', 'app1');
  assert.match(
    same.stdout,
    /BEGIN CERTIFICATE REQUEST/,
    'the same name prints the CSR for the installed key',
  );
  await assert.rejects(
    run('--current'),
    (error: { stderr: string }) => /^error: --current needs a node name/.test(error.stderr),
    'a missing node name is a plain usage error',
  );
});

test('the control refuses a database from a newer Tug with one plain line and a failing exit', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-main-newer-db-'));
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(dir, 'tug.db'));
  db.exec('PRAGMA user_version = 99');
  db.close();
  await assert.rejects(
    exec(process.execPath, [entry, 'control'], {
      env: { ...process.env, TUG_DATA_DIR: dir, TUG_CONTROL_URL: 'https://control.test:8443' },
      timeout: 20_000,
    }),
    (error: { code: number; stderr: string }) => {
      assert.equal(error.code, 1, 'the container must stop with a failure status');
      // Node 22 prints its own SQLite ExperimentalWarning (and the --trace-warnings hint) first; Node 24 does not.
      const ours = error.stderr
        .split('\n')
        .filter((line) => line && !/^\(node:\d+\) |^\(Use `node --trace-warnings/.test(line));
      assert.deepEqual(
        ours,
        [
          'error: the control database is at schema version 99, newer than the 1 this Tug supports; upgrade Tug, or restore a backup taken by this version',
        ],
        'the container log holds the remedy as one plain line, with no stack trace',
      );
      return true;
    },
    'the control must not start on a database it does not understand',
  );
});
