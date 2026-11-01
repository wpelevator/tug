import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defaultAdvertiseUrl, meshPortCheck } from './cli-install.ts';

const PORT = 51820;

// Fake `ss`, `docker` and `wg` that read their answers from FAKE_* variables, so the real preflight
// script runs unmodified. `docker exec` runs the in-container script locally with the agent state
// directory redirected to FAKE_STATE.
async function fakeHost() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-mesh-preflight-'));
  const bin = path.join(dir, 'bin');
  const state = path.join(dir, 'state');
  await fs.mkdir(bin, { recursive: true });
  await fs.mkdir(path.join(state, 'wireguard'), { recursive: true });
  await fs.writeFile(path.join(state, 'wireguard', 'private.key'), 'secret\n');
  await fs.writeFile(path.join(state, 'wireguard', 'reported.pub'), 'pub-of-secret\n');
  const executable = (name: string, body: string) =>
    fs.writeFile(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  await executable(
    'ss',
    `echo "State Recv-Q Send-Q Local Address:Port Peer Address:Port"\n[ -z "$FAKE_PORT_BUSY" ] || echo "UNCONN 0 0 0.0.0.0:$FAKE_PORT_BUSY 0.0.0.0:*"`,
  );
  await executable(
    'wg',
    `case "$1" in
  pubkey) printf 'pub-of-%s\\n' "$(cat)" ;;
  show) case "$3" in
    listen-port) echo "\${FAKE_WG_PORT:-${PORT}}" ;;
    public-key) echo "\${FAKE_LIVE_KEY:-pub-of-secret}" ;;
  esac ;;
esac`,
  );
  await executable(
    'docker',
    `[ -z "$FAKE_NO_AGENT" ] || exit 1
case "$1" in
  inspect) case "$3" in
    *NetworkMode*) echo "\${FAKE_NETWORK_MODE:-host}" ;;
    *State.Running*) echo "\${FAKE_RUNNING:-true}" ;;
    *Config.Env*) printf '%s\\n' "\${FAKE_ENV:-TUG_MESH=true}" ;;
    *Mounts*) echo "\${FAKE_MOUNT_SOURCE:-/var/lib/tug}" ;;
  esac ;;
  exec) script=$(printf '%s' "$6" | sed "s#/var/lib/tug#$FAKE_STATE#g"); exec sh -eu -c "$script" ;;
  *) exit 1 ;;
esac`,
  );
  const run = (overrides: Record<string, string> = {}) =>
    spawnSync('sh', ['-c', meshPortCheck(PORT)], {
      encoding: 'utf8',
      env: { PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_STATE: state, ...overrides },
    });
  return { run, state, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

test('mesh port check passes when nothing listens on the WireGuard port', async () => {
  const host = await fakeHost();
  try {
    assert.equal(host.run().status, 0, 'a free UDP port must pass');
  } finally {
    await host.cleanup();
  }
});

test("mesh port check lets this node's own running mesh agent keep the port, so installs can be repeated", async () => {
  const host = await fakeHost();
  try {
    assert.equal(
      host.run({ FAKE_PORT_BUSY: String(PORT) }).status,
      0,
      'an agent that owns the live WireGuard key must pass',
    );
  } finally {
    await host.cleanup();
  }
});

test('mesh port check rejects a busy port that the Tug agent does not own', async () => {
  const host = await fakeHost();
  const busy = { FAKE_PORT_BUSY: String(PORT) };
  try {
    assert.equal(
      host.run({ ...busy, FAKE_NO_AGENT: '1' }).status,
      1,
      'another process on the port must fail when no tug-agent container exists',
    );
    assert.equal(
      host.run({ ...busy, FAKE_RUNNING: 'false' }).status,
      1,
      'a stopped agent cannot own the live port',
    );
    assert.equal(
      host.run({ ...busy, FAKE_NETWORK_MODE: 'bridge' }).status,
      1,
      'an agent without host networking cannot own the port',
    );
    assert.equal(
      host.run({ ...busy, FAKE_ENV: 'TUG_ROLE=agent' }).status,
      1,
      'an agent started without the mesh enabled cannot own the port',
    );
    assert.equal(
      host.run({ ...busy, FAKE_MOUNT_SOURCE: '/srv/other' }).status,
      1,
      'an agent with a different state directory cannot own the port',
    );
    assert.equal(
      host.run({ ...busy, FAKE_WG_PORT: '51999' }).status,
      1,
      'wg0 listening on a different port means something else holds this one',
    );
    assert.equal(
      host.run({ ...busy, FAKE_LIVE_KEY: 'pub-of-other' }).status,
      1,
      'a live key that differs from the agent private key must fail',
    );
  } finally {
    await host.cleanup();
  }
});

test('mesh port check rejects a live key that control has not been told about', async () => {
  const host = await fakeHost();
  try {
    await fs.writeFile(path.join(host.state, 'wireguard', 'reported.pub'), 'pub-of-an-older-key\n');
    assert.equal(
      host.run({ FAKE_PORT_BUSY: String(PORT) }).status,
      1,
      'an agent whose live key was never reported to control must fail the check',
    );
  } finally {
    await host.cleanup();
  }
});

test('mesh port check refuses ports outside the valid range', () => {
  for (const port of [0, 65536, 1.5, Number.NaN])
    assert.throws(
      () => meshPortCheck(port),
      /mesh port must be an integer from 1 to 65535/,
      `port ${port} should be rejected before a script is built`,
    );
});

test('defaultAdvertiseUrl derives the control address from the SSH target', () => {
  for (const [target, expected] of [
    ['root@165.232.92.174', 'https://165.232.92.174:8443'],
    ['control.example.com', 'https://control.example.com:8443'],
    ['deploy@control.example.com', 'https://control.example.com:8443'],
    ['ssh://root@10.0.0.3:2222', 'https://10.0.0.3:8443'],
    ['root@[2001:db8::1]', 'https://[2001:db8::1]:8443'],
  ] as const)
    assert.equal(
      defaultAdvertiseUrl(target, 8443),
      expected,
      `${target} should map to ${expected}`,
    );
  assert.equal(
    defaultAdvertiseUrl('root@host', 9099),
    'https://host:9099',
    'the published port is part of the default',
  );
  assert.throws(
    () => defaultAdvertiseUrl('root@', 8443),
    /cannot derive/,
    'an empty host is rejected',
  );
});
