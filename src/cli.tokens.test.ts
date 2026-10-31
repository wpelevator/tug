import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from './control.ts';

const exec = promisify(execFile);
const entry = path.resolve('src/cli.ts');
const OPERATOR = 'op-cli-tokens';

test('token commands reject malformed invocations before contacting control', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-token-args-'));
  const env = { ...process.env, TUG_CONFIG: path.join(dir, 'missing.json'), TUG_CONTROL_URL: 'http://unreachable.invalid', TUG_TOKEN: 'unused' };
  try {
    const help = (await exec(process.execPath, [entry, '--help'], { env, cwd: dir })).stdout;
    for (const name of ['token-create', 'token-list', 'token-revoke']) assert.ok(help.includes(name), `help should list flat command ${name}`);
    const createHelp = (await exec(process.execPath, [entry, 'token-create', '--help'], { env, cwd: dir })).stdout;
    assert.match(createHelp, /--role/, 'token-create help should document --role');
    assert.match(createHelp, /--expires-in-days/, 'token-create help should document expiry');
    for (const args of [
      ['token-create', 'ci'], ['token-create', 'ci', '--role', 'owner'], ['token-create', 'bad name', '--role', 'read'], ['token-create', 'operator-x/y', '--role', 'read'],
      ['token-create', 'ci', '--role', 'deploy', '--project', 'bad/name'], ['token-create', 'ci', '--role', 'admin', '--project', 'site'],
      ['token-create', 'ci', '--role', 'read', '--expires-in-days', '0'], ['token-create', 'ci', '--role', 'read', '--expires-in-days', 'soon'],
      ['token-create', 'ci', '--role', 'read', 'extra'], ['token-list', 'extra'], ['token-revoke'], ['token-revoke', 'a', 'b'], ['events', '--all', '--project', 'site']
    ]) {
      await assert.rejects(exec(process.execPath, [entry, ...args], { env, cwd: dir }), error => {
        const stderr = (error as Error & { stderr: string }).stderr;
        assert.doesNotMatch(stderr, /fetch failed|ENOTFOUND|unreachable/, `invalid ${args.join(' ')} should fail before any API request`);
        return true;
      }, `${args.join(' ')} should be rejected`);
    }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('token-create, token-list and token-revoke work against control and a scoped token works as TUG_TOKEN', async () => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-cli-tokens-'));
  Object.assign(process.env, { TUG_DATA_DIR: data, TUG_OPERATOR_TOKEN: OPERATOR });
  const app = await createApp();
  const server = await new Promise<Server>(resolve => { const s = app.listen(0, () => resolve(s)); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const tug = (tok: string, ...args: string[]) => exec(process.execPath, [entry, ...args], { env: { ...process.env, TUG_CONFIG: '', TUG_CONTROL_URL: url, TUG_TOKEN: tok }, cwd: data });
  try {
    const created = await tug(OPERATOR, 'token-create', 'ci-deploy', '--role', 'deploy', '--project', 'site', '--project', 'blog', '--expires-in-days', '30');
    const body = JSON.parse(created.stdout);
    assert.match(body.token, /^tug_tok_/, 'token-create should print the new token once on stdout');
    assert.deepEqual(body.projects, ['blog', 'site'], 'token-create should send every repeated --project');
    assert.ok(body.expiresAt, 'token-create should send the expiry');
    assert.match(created.stderr, /not shown again/, 'token-create should warn on stderr that the secret is shown once');

    const listed = await tug(OPERATOR, 'token-list');
    assert.ok(!listed.stdout.includes(body.token) && !listed.stdout.includes('token_hash'), 'token-list must never print secrets or hashes');
    assert.equal(JSON.parse(listed.stdout).tokens[0].name, 'ci-deploy', 'token-list should show the token by name');

    const status = await tug(body.token, 'status');
    assert.ok(Array.isArray(JSON.parse(status.stdout).projects), 'a scoped token should work anywhere TUG_TOKEN does');
    await assert.rejects(tug(body.token, 'token-list'), /403/, 'a deploy token cannot list tokens');
    await assert.rejects(tug(body.token, 'events', '--project', 'other'), /403/, 'a scoped token is refused other projects');

    const events = JSON.parse((await tug(OPERATOR, 'events', '--all')).stdout).events;
    assert.equal(events[0].type, 'token.create', 'tug events --all should include control audit events');
    assert.equal(events[0].actor, 'operator', 'tug events should show who acted');

    assert.equal(JSON.parse((await tug(OPERATOR, 'token-revoke', 'ci-deploy')).stdout).ok, true, 'token-revoke should confirm');
    await assert.rejects(tug(body.token, 'status'), /401/, 'the revoked token should stop working');
    await assert.rejects(tug(OPERATOR, 'token-revoke', 'ghost'), /404/, 'revoking an unknown token should fail');
  } finally { await new Promise(resolve => server.close(resolve)); await fs.rm(data, { recursive: true, force: true }); }
});
