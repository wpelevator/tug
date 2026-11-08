// Smoke tests for the standalone executable. They run only when TUG_BINARY points at a built `tug`
// (`BUN=... npm run build:binary && TUG_BINARY=dist-bin/tug npm run test:smoke:binary`).
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { startMtlsControl } from '../tests/helpers.ts';
import { Pki, identityUri, serverNames } from './pki.ts';

const exec = promisify(execFile);
const binary = process.env.TUG_BINARY ? path.resolve(process.env.TUG_BINARY) : undefined;
const skip = binary ? false : 'set TUG_BINARY to a built tug executable';
const run = (args: string[], cwd: string, env: Record<string, string | undefined>) =>
  exec(binary!, args, { cwd, env: { ...process.env, TUG_CONFIG: '', ...env }, timeout: 20000 });
const tmp = (name: string) => fs.mkdtemp(path.join(os.tmpdir(), `tug-bin-${name}-`));

test('the binary reports the package version', { skip }, async () => {
  const pkg = JSON.parse(await fs.readFile('package.json', 'utf8')) as { version: string };
  const { stdout } = await run(['--version'], await tmp('version'), {});
  assert.equal(
    stdout.trim(),
    pkg.version,
    'tug --version prints the version embedded from package.json',
  );
});

test('the binary ignores bunfig.toml and .env in the working directory', { skip }, async () => {
  const dir = await tmp('hostile');
  const marker = path.join(dir, 'preload-ran');
  await fs.writeFile(
    path.join(dir, 'pre.js'),
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x');`,
  );
  await fs.writeFile(path.join(dir, 'bunfig.toml'), 'preload = ["./pre.js"]\n');
  await fs.writeFile(path.join(dir, '.env'), 'TUG_CONTROL_URL=https://evil.invalid:9\n');
  const { stdout } = await run(['status', '--help'], dir, {});
  assert.match(
    stdout,
    /Usage: tug status/,
    'the command still runs in a directory with Bun config files',
  );
  await assert.rejects(
    fs.access(marker),
    'a bunfig.toml preload in the working directory must not execute',
  );
  const control = await startMtlsControl(await tmp('hostile-control'));
  try {
    const out = await run(['node', 'list'], dir, { ...control.env, TUG_CREDENTIAL: '' });
    assert.match(
      out.stdout,
      /No nodes/,
      'a .env TUG_CONTROL_URL must not override the environment',
    );
  } finally {
    await control.close();
  }
});

test(
  'the binary reaches the control directly even when proxy variables are set',
  { skip },
  async () => {
    const control = await startMtlsControl(await tmp('proxy'));
    try {
      const proxy = 'http://127.0.0.1:9';
      const out = await run(['node', 'list'], await tmp('proxy-cwd'), {
        ...control.env,
        HTTPS_PROXY: proxy,
        https_proxy: proxy,
        ALL_PROXY: proxy,
      });
      assert.match(
        out.stdout,
        /No nodes/,
        'mTLS requests must not be sent through HTTPS_PROXY, as under Node',
      );
    } finally {
      await control.close();
    }
  },
);

test('the binary refuses a control that only speaks TLS 1.2', { skip }, async () => {
  const dir = await tmp('tls12');
  const pki = await Pki.load(dir, true);
  const server = await pki.issueServer(serverNames('https://control.example.com:8443'));
  const { credential } = await pki.issueClient(
    identityUri('operator', 'verify'),
    86_400_000,
    'https://control.example.com:8443',
  );
  const credentialFile = path.join(dir, 'c.json');
  await fs.writeFile(credentialFile, JSON.stringify(credential), { mode: 0o600 });
  const listener = https.createServer(
    { cert: server.cert, key: server.key, ca: pki.caPem, requestCert: true, maxVersion: 'TLSv1.2' },
    (_req, res) => res.end('[]'),
  );
  await new Promise<void>((r) => listener.listen(0, '127.0.0.1', r));
  try {
    const port = (listener.address() as { port: number }).port;
    const failure = await run(['node', 'list'], dir, {
      TUG_CONTROL_URL: `https://127.0.0.1:${port}`,
      TUG_CREDENTIAL_FILE: credentialFile,
    }).then(
      () =>
        assert.fail('a control below TLS 1.3 must be refused even with a CA-signed certificate'),
      (e: { stderr: string }) => e.stderr,
    );
    assert.match(
      failure,
      /TLS handshake failed|EPROTO|protocol/i,
      'the refusal comes from the TLS layer, not a later check',
    );
  } finally {
    listener.closeAllConnections();
    listener.close();
  }
});

test('tug doctor does not require node on PATH', { skip }, async () => {
  const control = await startMtlsControl(await tmp('doctor'));
  try {
    const bare = await tmp('empty-path');
    const out = await run(['doctor'], bare, { ...control.env, PATH: bare }).catch((e) => e);
    const text = `${out.stdout ?? ''}${out.stderr ?? ''}`;
    assert.doesNotMatch(
      text,
      /"name":\s*"node"|node --version|\bnode\b.*not found/i,
      'the binary does not probe for a local node',
    );
  } finally {
    await control.close();
  }
});
