import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execCli } from '../../../tests/cli-inprocess.ts';

/** A fake `docker` that logs every call; `inspect` succeeds only when the control container exists in $FAKE_DIR. */
const FAKE_DOCKER = `#!/bin/sh
echo "$*" >> "$FAKE_DIR/calls.log"
if [ "$1" = inspect ]; then [ -f "$FAKE_DIR/installed" ] || { echo "Error: No such object: $2" >&2; exit 1; }; fi
exit 0
`;
/** An ssh that runs the remote script locally against the fake docker and records the target. */
const FAKE_SSH = `#!/bin/sh
printf '%s\\n' "$2" >> "$FAKE_DIR/ssh-targets.log"
exec sh -c "$3"
`;

async function withHost(
  run: (ctx: {
    control: (...args: string[]) => Promise<{ code: number; stderr: string; stdout: string }>;
    calls: () => Promise<string[]>;
    targets: () => Promise<string[]>;
  }) => Promise<void>,
  { installed = true, config = 'controlSsh: ops@control.test\n' } = {},
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-control-restart-'));
  try {
    const bin = path.join(dir, 'bin');
    await fs.mkdir(bin);
    await fs.writeFile(path.join(bin, 'docker'), FAKE_DOCKER, { mode: 0o755 });
    await fs.writeFile(path.join(bin, 'ssh'), FAKE_SSH, { mode: 0o755 });
    if (installed) await fs.writeFile(path.join(dir, 'installed'), '');
    await fs.writeFile(path.join(dir, 'tug.yml'), config);
    await fs.writeFile(path.join(dir, 'calls.log'), '');
    await fs.writeFile(path.join(dir, 'ssh-targets.log'), '');
    const read = async (file: string) =>
      (await fs.readFile(path.join(dir, file), 'utf8')).split('\n').filter(Boolean);
    await run({
      control: async (...args) => {
        try {
          const { stdout, stderr } = await execCli(['control', ...args], {
            cwd: dir,
            env: {
              ...process.env,
              PATH: `${bin}${path.delimiter}${process.env.PATH}`,
              FAKE_DIR: dir,
              TUG_CONFIG: 'tug.yml',
            },
          });
          return { code: 0, stdout, stderr };
        } catch (e) {
          const err = e as { code: number; stdout: string; stderr: string };
          return { code: err.code, stdout: err.stdout, stderr: err.stderr };
        }
      },
      calls: () => read('calls.log'),
      targets: () => read('ssh-targets.log'),
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('control stop stops only the control container on controlSsh and prints JSON', async () => {
  await withHost(async ({ control, calls, targets }) => {
    const result = await control('stop', '--yes');
    assert.equal(result.code, 0, `control stop should succeed: ${result.stderr}`);
    assert.deepEqual(
      (await calls()).filter((line) => !line.startsWith('inspect')),
      ['stop tug-control-control-1'],
      'only the control container is stopped: no rm, run, pull, volume or network command',
    );
    assert.deepEqual(
      await targets(),
      ['ops@control.test'],
      'the SSH target defaults to controlSsh',
    );
    assert.deepEqual(
      JSON.parse(result.stdout),
      {
        ok: true,
        sshTarget: 'ops@control.test',
        container: 'tug-control-control-1',
        stopped: true,
      },
      'the result is JSON on stdout',
    );
    assert.match(
      result.stderr,
      /tug-control volume, the image and the published ports/,
      'the plan says what is kept',
    );
  });
});

test('control restart restarts the container in place and keeps the image, volume and ports', async () => {
  await withHost(async ({ control, calls }) => {
    const result = await control('restart', 'root@other.test', '--yes');
    assert.equal(result.code, 0, `control restart should succeed: ${result.stderr}`);
    assert.deepEqual(
      (await calls()).filter((line) => !line.startsWith('inspect')),
      ['restart tug-control-control-1'],
      'restart uses docker restart and never recreates the container',
    );
    const out = JSON.parse(result.stdout);
    assert.equal(out.sshTarget, 'root@other.test', 'an explicit target overrides controlSsh');
    assert.equal(out.restarted, true, 'the result reports the restart');
  });
});

test('control stop and restart name the missing container or the missing host', async () => {
  await withHost(
    async ({ control, calls }) => {
      for (const action of ['stop', 'restart']) {
        const result = await control(action, '--yes');
        assert.notEqual(
          result.code,
          0,
          `control ${action} should fail without a control container`,
        );
        assert.match(
          result.stderr,
          /there is no tug-control-control-1 container on this host/,
          `control ${action} should say that no control container exists`,
        );
      }
      assert.ok(
        !(await calls()).some((line) => /^(stop|restart) /.test(line)),
        'nothing is stopped or restarted when the container is missing',
      );
    },
    { installed: false },
  );
  await withHost(
    async ({ control }) => {
      for (const action of ['stop', 'restart']) {
        const result = await control(action, '--yes');
        assert.notEqual(result.code, 0, `control ${action} needs a host`);
        assert.match(
          result.stderr,
          new RegExp(`control ${action} needs the control host`),
          `control ${action} should ask for an SSH target or controlSsh`,
        );
      }
    },
    { config: '{}\n' },
  );
});
