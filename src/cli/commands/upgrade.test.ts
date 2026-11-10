import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const entry = path.resolve('src/cli.ts');

/** A fake `docker` that logs every call and answers the few queries `control upgrade` makes from files in $FAKE_DIR. */
const FAKE_DOCKER = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const dir = process.env.FAKE_DIR;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'calls.log'), args.join(' ') + '\\n');
const [cmd, sub] = args;
if (cmd === 'inspect') {
  const file = path.join(dir, args[1] + '.json');
  if (!fs.existsSync(file)) { process.stderr.write('Error: No such object: ' + args[1] + '\\n'); process.exit(1); }
  process.stdout.write(fs.readFileSync(file, 'utf8'));
} else if (cmd === 'info') {
  process.stdout.write('/');
} else if (cmd === 'exec' && args.includes('cat')) {
  process.stdout.write(fs.readFileSync(path.join(dir, 'ca.crt'), 'utf8'));
} else if (cmd === 'image' && sub === 'inspect' && args[2] === 'tug:rollback' && !fs.existsSync(path.join(dir, 'rollback-image'))) {
  process.exit(1);
}
`;
/** An ssh that runs the remote script locally, so the real scripts execute against the fake docker. */
const FAKE_SSH = `#!/bin/sh
printf '%s\\n' "$2" >> "$FAKE_DIR/ssh-targets.log"
exec sh -c "$3"
`;

const OLD_IMAGE = 'ghcr.io/wpelevator/tug:1.2.0';
const containerJson = JSON.stringify([
  {
    Image: 'sha256:oldimage',
    Config: {
      Image: OLD_IMAGE,
      Env: ['TUG_CONTROL_URL=https://control.test:9443', 'TUG_EXTRA_SANS=a.example.com,10.0.0.5'],
    },
    HostConfig: { PortBindings: { '8443/tcp': [{ HostPort: '9443' }] } },
  },
]);

async function withHost(
  run: (ctx: {
    dir: string;
    upgrade: (...args: string[]) => Promise<{ code: number; stderr: string; stdout: string }>;
    calls: () => Promise<string[]>;
  }) => Promise<void>,
  { installed = true, config = 'controlSsh: ops@control.test\n' } = {},
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-upgrade-'));
  try {
    const bin = path.join(dir, 'bin');
    await fs.mkdir(bin);
    await fs.writeFile(path.join(bin, 'docker'), FAKE_DOCKER, { mode: 0o755 });
    await fs.writeFile(path.join(bin, 'ssh'), FAKE_SSH, { mode: 0o755 });
    const key = path.join(dir, 'ca.key');
    const ca = spawnSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-keyout',
        key,
        '-out',
        path.join(dir, 'ca.crt'),
        '-subj',
        '/CN=test-ca',
        '-days',
        '2',
      ],
      { encoding: 'utf8' },
    );
    assert.equal(ca.status, 0, `openssl should create a test CA: ${ca.stderr}`);
    if (installed) await fs.writeFile(path.join(dir, 'tug-control-control-1.json'), containerJson);
    await fs.writeFile(path.join(dir, 'tug.yml'), config);
    await fs.writeFile(path.join(dir, 'calls.log'), '');
    const upgrade = async (...args: string[]) => {
      try {
        const { stdout, stderr } = await exec(
          process.execPath,
          [entry, 'control', 'upgrade', ...args],
          {
            cwd: dir,
            env: {
              ...process.env,
              PATH: `${bin}:${process.env.PATH}`,
              FAKE_DIR: dir,
              TUG_CONFIG: 'tug.yml',
            },
          },
        );
        return { code: 0, stdout, stderr };
      } catch (e) {
        const err = e as { code: number; stdout: string; stderr: string };
        return { code: err.code, stdout: err.stdout, stderr: err.stderr };
      }
    };
    await run({
      dir,
      upgrade,
      calls: async () =>
        (await fs.readFile(path.join(dir, 'calls.log'), 'utf8')).split('\n').filter(Boolean),
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('control upgrade keeps the running port, URL and extra names and tags the old image first', async () => {
  await withHost(async ({ upgrade, calls }) => {
    const result = await upgrade('--to', '9.9.9', '--yes');
    assert.equal(result.code, 0, `the upgrade should succeed: ${result.stderr}`);
    const log = await calls();
    const tag = log.findIndex((l) => l === 'tag sha256:oldimage tug:rollback');
    const run = log.findIndex((l) => l.startsWith('run -d --name tug-control-control-1'));
    assert.ok(
      tag >= 0,
      `the previous image should be tagged as the rollback image:\n${log.join('\n')}`,
    );
    assert.ok(run > tag, 'the old image should be tagged before the container is replaced');
    const runLine = log[run];
    assert.match(runLine, /-p 9443:8443/, 'the published port should be kept, not reset to 8443');
    assert.match(
      runLine,
      /-e TUG_CONTROL_URL=https:\/\/control\.test:9443/,
      'the advertised URL should be kept',
    );
    assert.match(
      runLine,
      /-e TUG_EXTRA_SANS=a\.example\.com,10\.0\.0\.5/,
      'the extra names should be kept',
    );
    assert.match(
      runLine,
      /ghcr\.io\/wpelevator\/tug:9\.9\.9 control$/,
      'the container should run the requested version',
    );
    assert.match(
      result.stderr,
      /1\.2\.0 -> ghcr\.io\/wpelevator\/tug:9\.9\.9/,
      'the plan should show the image change',
    );
  });
});

test('control upgrade does nothing when the image already runs, unless forced', async () => {
  await withHost(async ({ upgrade, calls }) => {
    const result = await upgrade('--image', OLD_IMAGE, '--yes');
    assert.equal(result.code, 0, `a no-op upgrade should succeed: ${result.stderr}`);
    assert.match(result.stderr, /nothing to do/, 'the no-op should be explained');
    assert.ok(
      !(await calls()).some((l) => l.startsWith('run ')),
      'the container should not be recreated when it already runs the image',
    );
    await upgrade('--image', OLD_IMAGE, '--force', '--yes');
    assert.ok(
      (await calls()).some((l) => l.startsWith('run -d --name tug-control-control-1')),
      '--force should recreate the container',
    );
  });
});

test('control upgrade --rollback runs the kept image and does not retag', async () => {
  await withHost(async ({ dir, upgrade, calls }) => {
    const missing = await upgrade('--rollback', '--yes');
    assert.notEqual(missing.code, 0, 'a rollback without a kept image should fail');
    assert.match(
      missing.stderr,
      /no tug:rollback image/,
      'the failure should say the image is missing',
    );
    await fs.writeFile(path.join(dir, 'rollback-image'), '');
    const result = await upgrade('--rollback', '--yes');
    assert.equal(result.code, 0, `the rollback should succeed: ${result.stderr}`);
    const log = await calls();
    assert.ok(
      log.some((l) => /^run -d .* tug:rollback control$/.test(l)),
      'control should be started from tug:rollback',
    );
    assert.ok(
      !log.some((l) => l.startsWith('tag ')),
      'a rollback should not overwrite the rollback tag',
    );
    assert.match(result.stderr, /database/, 'the plan should warn about a migrated database');
  });
});

test('control upgrade needs a host and an existing installation', async () => {
  await withHost(
    async ({ upgrade }) => {
      const result = await upgrade('--yes');
      assert.notEqual(result.code, 0, 'no host should fail');
      assert.match(result.stderr, /set controlSsh in/, 'the failure should name the config key');
    },
    { config: 'project: site\n' },
  );
  await withHost(
    async ({ upgrade, calls }) => {
      const result = await upgrade('--to', '9.9.9', '--yes');
      assert.notEqual(result.code, 0, 'a host without control should fail');
      assert.match(result.stderr, /tug control setup/, 'the failure should point at setup');
      assert.ok(!(await calls()).some((l) => l.startsWith('run ')), 'nothing should be started');
    },
    { installed: false },
  );
});

test('tug upgrade needs controlSsh before it touches anything', async () => {
  await withHost(
    async ({ dir, calls }) => {
      const result = await exec(process.execPath, [entry, 'upgrade', '--yes'], {
        cwd: dir,
        env: {
          ...process.env,
          PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`,
          FAKE_DIR: dir,
          TUG_CONFIG: 'tug.yml',
        },
      }).then(
        () => ({ code: 0, stderr: '' }),
        (e: { code: number; stderr: string }) => ({ code: e.code, stderr: e.stderr }),
      );
      assert.notEqual(result.code, 0, 'upgrade without a control host should fail');
      assert.match(result.stderr, /needs controlSsh/, 'the failure should name the config key');
      assert.deepEqual(
        await calls(),
        [],
        'no host command should run before the config is complete',
      );
    },
    { config: 'project: site\n' },
  );
});

test('control setup over an existing control says which of its settings the run changes', async () => {
  await withHost(async ({ dir }) => {
    const setup = (...args: string[]) =>
      exec(
        process.execPath,
        [
          entry,
          'control',
          'setup',
          'ops@control.test',
          '--yes',
          '--no-import',
          '--credential-out',
          path.join(dir, 'out.json'),
          ...args,
        ],
        {
          cwd: dir,
          env: {
            ...process.env,
            PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`,
            FAKE_DIR: dir,
            TUG_CONFIG: 'tug.yml',
          },
        },
      ).then(
        () => '',
        // The fake docker issues no credential, so setup fails after the install; the note comes before that.
        (e: { stderr: string }) => e.stderr,
      );
    const changed = await setup('--control-url', 'https://control.test:9443');
    assert.match(
      changed,
      /already installed on ops@control\.test.*port 9443 -> 8443.*extra names \[a\.example\.com, 10\.0\.0\.5\] -> \[\].*tug control upgrade/s,
      'setup should name the port and extra names that a rerun without flags would reset',
    );
    const same = await setup(
      '--port',
      '9443',
      '--extra-san',
      'a.example.com,10.0.0.5',
      '--control-url',
      'https://control.test:9443',
    );
    assert.doesNotMatch(
      same,
      /already installed/,
      'a rerun with the same settings needs no warning',
    );
  });
});
