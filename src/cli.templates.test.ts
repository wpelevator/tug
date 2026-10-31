import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import { createApp } from './control.ts';

const execFileAsync = promisify(execFile);
// `src/cli.ts` in dev; `CLI_ENTRY=dist/cli.js npm run test:smoke:dist` checks the built output.
const cliEntry = path.resolve(process.env.CLI_ENTRY || 'src/cli.ts');

// A stub `ssh` that records its arguments (the rendered install script is the last one).
async function stubSsh(dir: string) {
  const bin = path.join(dir, 'bin');
  const log = path.join(dir, 'ssh.log');
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, 'ssh'), `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done >> "${log}"\nprintf '\\n--END--\\n' >> "${log}"\n`, { mode: 0o755 });
  return { bin, log };
}

test('install commands render the shipped templates (src in dev, dist in the image)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-cli-tpl-'));
  process.env.TUG_DATA_DIR = path.join(dir, 'data');
  process.env.TUG_OPERATOR_TOKEN = 'op-cli-template-token';
  const app = await createApp();
  const server = await new Promise<import('node:http').Server>(resolve => { const s = app.listen(0, () => resolve(s)); });
  const controlUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const ssh = await stubSsh(dir);
  const env = { ...process.env, PATH: `${ssh.bin}${path.delimiter}${process.env.PATH}`, TUG_CONFIG: path.join(dir, 'cfg.json'), TUG_TOKEN: 'op-cli-template-token', TUG_CONTROL_URL: controlUrl };
  const cli = (...args: string[]) => execFileAsync(process.execPath, [cliEntry, ...args], { env, cwd: dir });
  try {
    await cli('control', 'install', 'root@control.test', '--registry', 'registry.test', '--no-transfer-image', '--port', '9099');
    let script = await fs.readFile(ssh.log, 'utf8');
    assert.ok(script.includes('registry.test'), 'control-compose.yml rendered with the registry host');
    assert.ok(script.includes('9099'), 'control-compose.yml rendered with the port');
    assert.doesNotMatch(script, /\{\{\w+\}\}/, 'no unrendered template variables');

    await fs.rm(ssh.log);
    await cli('node', 'install', 'root@node.test', '--name', 'n-tpl', '--control-url', controlUrl, '--http-only-dev', '--no-transfer-image');
    script = await fs.readFile(ssh.log, 'utf8');
    assert.ok(script.includes('TUG_NODE_NAME=n-tpl'), 'agent.env rendered');
    assert.ok(script.includes(controlUrl), 'agent.env carries the control URL');
    assert.doesNotMatch(script, /\{\{\w+\}\}/, 'no unrendered template variables');
    assert.doesNotMatch(script, /NET_ADMIN|TUG_MESH/, 'agents join no mesh unless asked');

    await fs.rm(ssh.log);
    await cli('node', 'install', 'root@node2.test', '--name', 'n-mesh', '--control-url', controlUrl, '--http-only-dev', '--no-transfer-image', '--mesh');
    script = await fs.readFile(ssh.log, 'utf8');
    assert.ok(script.includes('TUG_MESH=true'), '--mesh sets TUG_MESH in agent.env');
    assert.match(script, /--network host --cap-add NET_ADMIN/, '--mesh runs the agent with host networking and NET_ADMIN');
    assert.ok(script.includes('lpwgtest type wireguard') && script.includes('udp.51820.free'), '--mesh adds WireGuard kernel and UDP port preflight checks');
    assert.doesNotMatch(script, /\{\{\w+\}\}/, 'no unrendered template variables');

    const enroll = await cli('node', 'enroll', '--name', 'n-enr', '--mesh', '--control-url', controlUrl, '--http-only-dev');
    assert.match(enroll.stdout, /--network host --cap-add NET_ADMIN -e TUG_MESH=true/, 'node enroll --mesh prints a mesh-capable docker run');
  } finally { await new Promise(resolve => server.close(resolve)); }
});
