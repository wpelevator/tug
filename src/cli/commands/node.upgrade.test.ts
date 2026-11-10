import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { startMtlsControl, writeStubDocker } from '../../../tests/helpers.ts';
import { createCsr, generateKeyPair } from '../../pki.ts';
import { defaultImage } from '../../images/image.ts';

const execFileAsync = promisify(execFile);
const cliEntry = path.resolve('src/cli.ts');

/** A stub `ssh` that logs every script and answers the agent inspection and identity steps. */
async function stubSsh(dir: string) {
  const bin = path.join(dir, 'bin');
  const log = path.join(dir, 'ssh.log');
  await fs.mkdir(bin, { recursive: true });
  await writeStubDocker(bin);
  await fs.writeFile(
    path.join(bin, 'ssh'),
    `#!/bin/sh
for a in "$@"; do printf '%s\\n' "$a"; done >> "${log}"
printf '\\n--END--\\n' >> "${log}"
case "$*" in
  *"agent identity"*) cat "$TUG_STUB_CSR" ;;
  *"docker inspect 'tug-agent'"*) if [ -f "$TUG_STUB_AGENT_INSPECT" ]; then cat "$TUG_STUB_AGENT_INSPECT"; else echo 'Error: No such object: tug-agent' >&2; exit 1; fi ;;
  *"image inspect --format"*) case "$*" in *"${defaultImage()}"*) echo 'sha256:x' ;; *) echo 'sha256:new' ;; esac ;;
esac
`,
    { mode: 0o755 },
  );
  return { bin, log };
}

const agentInspect = (image: string, env: string[] = [], imageId = 'sha256:x') =>
  JSON.stringify([{ Image: imageId, Config: { Image: image, Env: env } }]);

test('node upgrade replaces an enrolled agent, keeps its connect URL, skips current nodes and refuses strangers', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-node-upgrade-'));
  const control = await startMtlsControl(path.join(dir, 'data'));
  const ssh = await stubSsh(dir);
  const csrFile = path.join(dir, 'node.csr');
  await fs.writeFile(csrFile, await createCsr((await generateKeyPair()).privateKeyPem));
  const inspectFile = path.join(dir, 'agent-inspect.json');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...control.env,
    PATH: `${ssh.bin}${path.delimiter}${process.env.PATH}`,
    TUG_CONFIG: path.join(dir, 'cfg.json'),
    TUG_STUB_CSR: csrFile,
    TUG_STUB_AGENT_INSPECT: inspectFile,
  };
  await fs.writeFile(env.TUG_CONFIG as string, '{}');
  const cli = (...args: string[]) =>
    execFileAsync(process.execPath, [cliEntry, ...args], { env, cwd: dir });
  const script = () => fs.readFile(ssh.log, 'utf8');
  try {
    await cli('node', 'add', 'root@node.test', '--name', 'n-up', '--no-wait');

    await assert.rejects(
      cli('node', 'upgrade', 'ghost', 'root@ghost.test', '--no-wait'),
      /node ghost is not registered with control/,
      'a node control does not know should be refused, not enrolled by an upgrade',
    );
    await assert.rejects(
      cli('node', 'upgrade', 'n-up', 'root@node.test', '--no-wait'),
      /no agent container on root@node\.test/,
      'a host without an agent should be pointed at node add',
    );

    await fs.writeFile(
      inspectFile,
      agentInspect(
        'ghcr.io/wpelevator/tug:0.0.1',
        ['TUG_CONTROL_URL=https://private.test:8443', 'TUG_ROLLOUT_PORTS=22000-22999'],
        'sha256:old',
      ),
    );
    await fs.rm(ssh.log);
    const upgraded = await cli('node', 'upgrade', 'n-up', 'root@node.test', '--no-wait');
    assert.equal(JSON.parse(upgraded.stdout).upgraded, true, 'an older agent should be upgraded');
    const upgradeScript = await script();
    assert.ok(
      upgradeScript.includes(`'${defaultImage()}'`) &&
        upgradeScript.includes('docker run -d --name tug-agent'),
      "the agent should be reinstalled at this CLI's image",
    );
    assert.ok(
      upgradeScript.includes("-e TUG_CONTROL_URL='https://private.test:8443'"),
      "the running agent's connect-only URL should survive the upgrade without --agent-control-url",
    );
    assert.match(
      upgradeScript,
      /-e TUG_ROLLOUT_PORTS='22000-22999'/,
      'node upgrade preserves its rollout port configuration',
    );
    assert.ok(
      upgradeScript.includes("agent identity --current 'n-up'"),
      "the upgrade should reuse the node's own key, as node add does",
    );

    await fs.writeFile(inspectFile, agentInspect(defaultImage()));
    await fs.rm(ssh.log);
    const skipped = await cli('node', 'upgrade', 'n-up', 'root@node.test', '--no-wait');
    assert.equal(
      JSON.parse(skipped.stdout).upgraded,
      false,
      'a node on the target image should be skipped',
    );
    assert.ok(
      !(await script()).includes('docker run -d --name tug-agent'),
      'a skipped node should not have its agent replaced',
    );
    await fs.rm(ssh.log);
    await cli('node', 'upgrade', 'n-up', 'root@node.test', '--force', '--no-wait');
    assert.ok(
      (await script()).includes('docker run -d --name tug-agent'),
      '--force should reinstall an agent that is already current',
    );

    await assert.rejects(
      cli('node', 'upgrade', 'n-up', 'root@node.test', '--to', '99.0.0', '--no-wait'),
      /upgrade it first with `tug control upgrade --to 99\.0\.0`/,
      'agents must not be moved past the control, which would refuse them',
    );
    await assert.rejects(
      cli('node', 'upgrade', '--all', 'n-up'),
      /cannot be combined/,
      '--all with a node name is ambiguous',
    );
  } finally {
    await control.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
