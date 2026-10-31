import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import yaml from 'js-yaml';
import * as tar from 'tar';
import { resolveCliConfig, integerOption } from './cli-config.ts';
import { createSourceArchive, prepareLocalImages } from './cli-build.ts';
import { dockerRunSnippet, enrollmentCloudInit, shellQuote } from './cli-install.ts';

const exec = promisify(execFile);
const entry = path.resolve('src/cli.ts');

test('connection resolution consistently uses explicit options, then environment, then selected config', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-config-'));
  try {
    await fs.writeFile(path.join(dir, 'chosen.json'), JSON.stringify({ controlUrl: 'https://config.test', operatorToken: 'config-token', project: 'config-project' }));
    const env = { TUG_CONFIG: 'chosen.json', TUG_CONTROL_URL: 'https://env.test', TUG_TOKEN: 'env-token', TUG_PROJECT: 'env-project' };
    const explicit = await resolveCliConfig({ controlUrl: 'https://flag.test/', project: 'flag-project' }, env, dir);
    assert.equal(explicit.controlUrl, 'https://flag.test', 'explicit control URL should override environment and config and normalize trailing slash');
    assert.equal(explicit.project, 'flag-project', 'explicit project should override environment and config');
    assert.equal(explicit.operatorToken, 'env-token', 'environment operator token should override the config token');
    const environment = await resolveCliConfig({}, env, dir);
    assert.equal(environment.controlUrl, 'https://env.test', 'environment control URL should override selected config');
    assert.equal(environment.project, 'env-project', 'environment project should override selected config');
    const config = await resolveCliConfig({ config: 'chosen.json' }, {}, dir);
    assert.equal(config.project, 'config-project', 'selected config should provide the project without explicit or environment values');
    assert.equal(config.operatorToken, 'config-token', 'selected config should provide the operator token without an environment token');
    const fallback = await resolveCliConfig({}, {}, dir);
    assert.equal(fallback.controlUrl, 'http://localhost:8080', 'missing implicit config should use the documented local control URL');
    assert.equal(fallback.project, 'site', 'missing implicit config should use the documented default project');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('invalid and explicitly missing config produce errors instead of silently selecting another control plane', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-invalid-config-'));
  try {
    await assert.rejects(resolveCliConfig({ config: 'missing.json' }, {}, dir), /Cannot read config/, 'explicit missing config should fail before network operations');
    const created = await resolveCliConfig({ config: 'missing.json' }, {}, dir, true);
    assert.equal(created.project, 'site', 'init should be able to create an explicitly selected new config file');
    await fs.writeFile(path.join(dir, '.tug.json'), '{broken');
    await assert.rejects(resolveCliConfig({}, {}, dir), /Cannot read config/, 'malformed default config should report an error');
    await fs.writeFile(path.join(dir, '.tug.json'), '{"project":123}');
    await assert.rejects(resolveCliConfig({}, {}, dir), /project must be a nonempty string/, 'known config keys should be validated');
    await fs.writeFile(path.join(dir, '.tug.json'), '{}');
    await assert.rejects(resolveCliConfig({ controlUrl: 'https://user:secret@control.test' }, {}, dir, true), /without credentials/, 'credentials must not be accepted in the control URL');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('CLI exposes flat commands and rejects malformed invocations before side effects', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-args-'));
  const env = { ...process.env, TUG_CONFIG: path.join(dir, 'missing.json'), TUG_CONTROL_URL: 'http://unreachable.invalid', TUG_TOKEN: 'unused' };
  try {
    const { stdout } = await exec(process.execPath, [entry, '--help'], { env, cwd: dir });
    for (const name of ['control-install', 'node-enroll', 'node-register', 'secret-set', 'volume-remove', 'control-restore']) assert.ok(stdout.includes(name), `help should list flat command ${name}`);
    assert.doesNotMatch(stdout, /node:|secret:|volume:|control:\s/, 'help should not advertise colon commands');
    for (const args of [['status', 'typo'], ['node', 'install'], ['secret:set', 'KEY'], ['deploy', '--build-local', '--no-build-upload'], ['deploy', '--timeout', '0'], ['control-install', 'root@host', '--port', '65536'], ['node-enroll', '--uses', 'NaN'], ['events', '--limit', '501'], ['control-restore', '/backup.tgz']]) {
      await assert.rejects(exec(process.execPath, [entry, ...args], { env, cwd: dir }), error => {
        const stderr = (error as Error & { stderr: string }).stderr;
        assert.doesNotMatch(stderr, /Cannot read config|fetch failed|ENOENT.*(ssh|docker)/, `invalid ${args.join(' ')} should fail before config, API or host operations`);
        return true;
      }, `${args.join(' ')} should be rejected`);
    }
    const help = await exec(process.execPath, [entry, 'deploy', '--help'], { env, cwd: dir });
    assert.match(help.stdout, /--config/, 'command help should show shared connection and config options');
    assert.match(help.stdout, /--build-local/, 'deploy help should explain the application local-build flag');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('init applies global options after the command without relying on Docker or a control server', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-init-'));
  try {
    const file = path.join(dir, 'new.json');
    await exec(process.execPath, [entry, 'init', '--config', file, '--control-url', 'https://flag.test', '--project', 'flag-project'], { cwd: dir, env: { ...process.env, TUG_CONFIG: path.join(dir, 'ignored.json'), TUG_CONTROL_URL: 'https://env.test', TUG_PROJECT: 'env-project', TUG_TOKEN: 'env-token' } });
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { controlUrl: 'https://flag.test', operatorToken: 'env-token', project: 'flag-project' }, 'init should persist the same CLI/env/config precedence used by API operations');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('local application builds skip published images and produce unique file-backed upload manifests', async () => {
  const builds: { service: string; imageRef: string; push?: boolean; contextDir: string }[] = [];
  const files: string[] = [];
  const removed: string[] = [];
  const result = await prepareLocalImages({ services: { web: { build: '.' }, worker: { build: { context: 'worker' } }, cache: { image: 'redis:7' } } }, '/source', '/temp', {
    nonce: () => 'unique-build',
    build: async options => { builds.push(options); },
    save: async (_image, file) => { files.push(file); return { imageId: 'sha256:abc', platform: 'linux/amd64', sha256: 'a'.repeat(64), sizeBytes: 123 }; },
    remove: async imageRef => { removed.push(imageRef); }
  });
  assert.deepEqual(builds.map(build => build.service), ['web', 'worker'], 'local builds should process only services declaring build');
  assert.ok(builds.every(build => build.push === false && build.contextDir === '/source'), 'local builds should use explicit source context and never push directly');
  assert.equal(new Set(builds.map(build => build.imageRef)).size, 2, 'every service should have its own immutable temporary image tag');
  assert.deepEqual(files, ['/temp/image-0.tar.gz', '/temp/image-1.tar.gz'], 'archives should be written to caller-owned temporary files');
  assert.deepEqual(result.map(image => [image.service, image.field, image.sizeBytes]), [['web', 'image-0', 123], ['worker', 'image-1', 123]], 'manifest entries should map each service to its uploaded archive field and exact byte size');
  assert.deepEqual(removed, result.map(image => image.imageRef), 'each generated temporary tag should be removed after its saved archive is complete');
});

test('failed local build/save still removes only generated tags without masking the original failure', async () => {
  for (const failure of ['build', 'save'] as const) {
    const removed: string[] = [];
    const warnings: string[] = [];
    await assert.rejects(prepareLocalImages({ services: { app: { image: 'user/app:keep', build: '.' }, published: { image: 'user/published:keep' } } }, '/source', '/temp', {
      nonce: () => 'cleanup-build',
      build: async () => { if (failure === 'build') throw new Error('original build failure'); },
      save: async () => { throw new Error('original save failure'); },
      remove: async imageRef => { removed.push(imageRef); throw new Error('cleanup failure'); },
      cleanupWarning: message => { warnings.push(message); }
    }), new RegExp(`original ${failure} failure`), `failed ${failure} should retain its actionable original error`);
    assert.deepEqual(removed, ['tug-build/cleanup-build/image-0:local'], `failed ${failure} should attempt cleanup of only the generated temporary image tag`);
    assert.equal(warnings.length, 1, `failed ${failure} should report a cleanup warning when Docker refuses removal`);
  }
});

test('shell snippets quote user values and cloud-init stops enrollment after bootstrap failure', () => {
  const image = "registry.test/image:tag'; printf injected";
  const command = dockerRunSnippet(image, 'join-key', true);
  assert.ok(command.includes(shellQuote(image)), 'image reference should remain a single shell argument');
  assert.match(command, /--network host --cap-add NET_ADMIN/, 'mesh snippets should enable host networking and NET_ADMIN');
  const document = enrollmentCloudInit('set -eu\nexit 20\n', command);
  const parsed = yaml.load(document) as { write_files: { path: string; permissions: string; content: string }[]; runcmd: string[][] };
  assert.ok(document.startsWith('#cloud-config\n'), 'bare-host enrollment should emit valid cloud-init user-data directly');
  assert.equal(parsed.write_files[0].permissions, '0700', 'bootstrap script should be private and executable by root');
  assert.equal(parsed.write_files[0].content, 'set -eu\nexit 20\n', 'cloud-init should preserve bootstrap script contents');
  assert.equal(parsed.runcmd[0][3], `sh /opt/tug/install-docker.sh && ${command}`, 'agent startup should be conditional on successful bootstrap');
});

test('numeric arguments are strict bounded integers', () => {
  assert.equal(integerOption('443', '--port', 1, 65535), 443, 'valid TCP port should retain its integer value');
  for (const value of ['0', '-1', '1.5', 'NaN', '1e3', '65536']) assert.throws(() => integerOption(value, '--port', 1, 65535), /--port must be an integer/, `port ${value} should be rejected as out of range or malformed`);
});

test('source upload excludes Tug credentials even with a broad Dockerfile and ignore reinclusion', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-source-'));
  const archive = path.join(os.tmpdir(), `tug-source-${path.basename(dir)}.tar.gz`);
  try {
    await fs.mkdir(path.join(dir, 'settings'));
    await fs.mkdir(path.join(dir, 'nested'));
    await fs.writeFile(path.join(dir, '.tug.json'), '{"operatorToken":"secret"}');
    await fs.writeFile(path.join(dir, 'settings', 'production.json'), '{"operatorToken":"other-secret"}');
    await fs.writeFile(path.join(dir, 'nested', '.tug.json'), '{"operatorToken":"nested-secret"}');
    await fs.writeFile(path.join(dir, '.dockerignore'), '!.tug.json\n!settings/production.json\n');
    await fs.writeFile(path.join(dir, 'Dockerfile'), 'FROM scratch\nCOPY . .\n');
    await fs.writeFile(path.join(dir, 'app.txt'), 'public application');
    await createSourceArchive(dir, archive, [path.join(dir, 'settings', 'production.json')]);
    const entries: string[] = [];
    await tar.t({ file: archive, onReadEntry: entry => { entries.push(entry.path); } });
    assert.ok(entries.some(entry => entry.endsWith('app.txt')), 'source archive should retain application files');
    assert.ok(entries.some(entry => entry.endsWith('Dockerfile')), 'source archive should retain the Dockerfile');
    assert.ok(entries.every(entry => !entry.endsWith('.tug.json') && !entry.endsWith('settings/production.json')), 'source archive must exclude default, nested and selected Tug credential files even when re-included');
  } finally { await fs.rm(dir, { recursive: true, force: true }); await fs.rm(archive, { force: true }); }
});

test('Docker bootstrap preserves a working installation without package-manager or privilege checks', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-existing-docker-'));
  try {
    await fs.writeFile(path.join(dir, 'docker'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const script = path.resolve('src/templates/install-docker.sh');
    const result = await exec('/bin/sh', [script], { env: { ...process.env, PATH: dir } });
    assert.match(result.stderr, /already available/, 'working Docker Engine and Compose should skip all installation steps');
    await exec('/bin/sh', ['-n', script]);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
