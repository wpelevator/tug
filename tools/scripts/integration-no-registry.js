#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const root = fileURLToPath(new URL('../..', import.meta.url));
const project = process.env.COMPOSE_PROJECT_NAME || `tug-images-${process.pid}`;
const file = path.join(root, 'docker-compose.integration-no-registry.yml');
const control = `http://127.0.0.1:${process.env.TUG_IMAGE_TEST_PORT || 18081}`;
const token = 'integration-token';
const composeArgs = ['compose', '-p', project, '-f', file];
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-no-registry-'));
const env = {
  ...process.env,
  TUG_CONFIG: path.join(directory, '.tug.json'),
  TUG_CONTROL_URL: control,
  TUG_TOKEN: token,
};
const imageRefs = new Set();
let nodeContainer;
let paused = false;

async function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, timeout: 10 * 60 * 1000, ...options });
    let out = '';
    let err = '';
    child.stdout?.on('data', (chunk) => {
      out += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      err += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0
        ? resolve(out.trim())
        : reject(
            new Error(
              `${command} ${args.join(' ')} failed (${code})\n${out.slice(-12000)}\n${err.slice(-12000)}`,
            ),
          ),
    );
  });
}
const compose = (...args) => run('docker', [...composeArgs, ...args]);
async function request(route, body, bearer = token) {
  const response = await fetch(`${control}${route}`, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new Error(`${route}: ${response.status} ${await response.text()}`);
  return response.json();
}
async function wait(check, message, timeout = 180000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${message}${last ? `: ${last.message}` : ''}`);
}
const cli = (...args) =>
  run(process.execPath, [path.join(root, 'src/cli.ts'), ...args], { cwd: directory });
const onNode = (...args) => run('docker', ['exec', nodeContainer, ...args]);
// Runs a command in a service container of the deployed project, found by its Tug labels.
const appCompose = (_exec, ...args) =>
  onNode(
    'sh',
    '-c',
    'docker exec "$(docker ps -q --filter label=tug.project=imagedemo --filter label=tug.service=web | head -1)" "$@"',
    'sh',
    ...args.filter((arg) => arg !== '-T' && arg !== 'web'),
  );
async function expectContents(expected) {
  await wait(
    async () => (await appCompose('exec', '-T', 'web', 'cat', '/www/index.html')) === expected,
    `Deployed application must serve ${expected}`,
  );
}
async function deploy(content, ...options) {
  await fs.writeFile(path.join(directory, 'index.html'), content + '\n');
  const result = JSON.parse(
    await cli(
      'deploy',
      '--project',
      'imagedemo',
      '--version',
      'reused-version',
      '--timeout',
      '180',
      ...options,
    ),
  );
  assert.equal(
    result.deployment.state,
    'succeeded',
    'A registry-free deployment must converge successfully',
  );
  const service = result.desiredState.services.web;
  imageRefs.add(service.image);
  assert.ok(
    service.artifact?.buildId,
    'A built service must use a stored image artifact without a registry',
  );
  await expectContents(content);
  const inspected = JSON.parse(await onNode('docker', 'image', 'inspect', service.image))[0];
  assert.equal(
    inspected.Id,
    service.artifact.imageId,
    'The isolated node must load the exact built image from control',
  );
  return result;
}

try {
  console.log('Starting control and an isolated Docker node without a registry…');
  // CI prebuilds the images with a layer cache and sets TUG_COMPOSE_BUILD="" to skip the rebuild.
  await compose(
    'up',
    '-d',
    ...(process.env.TUG_COMPOSE_BUILD ?? '--build').split(' ').filter(Boolean),
  );
  await wait(() => fetch(`${control}/healthz`).then((r) => r.ok), 'Control must become reachable');
  await wait(
    async () =>
      (await request('/api/v1/status')).nodes.some(
        (node) => node.id === 'image-node' && node.status === 'online',
      ),
    'The isolated node must register and poll',
  );
  nodeContainer = await compose('ps', '-q', 'node');
  const services = (await compose('config', '--services')).split(/\s+/);
  assert.deepEqual(
    services.sort(),
    ['control', 'node', 'provisioner'],
    'The integration stack must have no registry service',
  );
  const diagnostics = await request('/api/v1/diagnostics');
  assert.ok(!diagnostics.registry, 'Control must have no configured registry');
  const daemonInfo = JSON.parse(await onNode('docker', 'info', '--format', '{{json .}}'));
  assert.ok(
    !daemonInfo.RegistryConfig?.InsecureRegistryCIDRs?.some(
      (cidr) => !['127.0.0.0/8', '::1/128'].includes(cidr),
    ),
    'The isolated Docker daemon must not require insecure registry configuration',
  );
  await cli('init', '--control-url', control, '--token', token, '--project', 'imagedemo');
  await fs.writeFile(
    path.join(directory, 'Dockerfile'),
    'FROM busybox:1.36\nCOPY index.html /www/index.html\nCMD ["httpd", "-f", "-p", "8080", "-h", "/www"]\n',
  );
  await fs.writeFile(
    path.join(directory, 'docker-compose.yml'),
    yaml.dump({
      services: {
        web: {
          build: '.',
          'x-tug': {
            placement: { nodes: ['image-node'] },
            health: { type: 'http', port: 8080, path: '/' },
          },
        },
        toolbox: {
          image: 'busybox:1.36',
          command: ['sleep', '3600'],
          'x-tug': { placement: { nodes: ['image-node'] } },
        },
      },
    }),
  );
  const first = await deploy('remote-one');
  const second = await deploy('remote-two');
  assert.notEqual(
    first.desiredState.revision,
    second.desiredState.revision,
    'Reusing a version label must still create a distinct desired-state revision',
  );
  assert.notEqual(
    first.desiredState.services.web.image,
    second.desiredState.services.web.image,
    'Reusing a version label must not overwrite the previous image',
  );
  const rollback = JSON.parse(await cli('rollback', '--project', 'imagedemo', '--timeout', '180'));
  assert.equal(
    rollback.deployment.state,
    'succeeded',
    'Rollback must converge using the retained image archive',
  );
  await expectContents('remote-one');
  console.log(
    'Remote builds, reused-version image identity and rollback passed; restarting the agent…',
  );
  await compose('restart', 'node');
  await expectContents('remote-one');
  console.log('Agent restart passed; building on the operator machine…');
  const local = await deploy('operator-local', '--build-local');

  console.log('Checking backup restore and a fresh artifact download…');
  const backup = await request('/api/v1/control/backups/run', {});
  await run('docker', ['kill', '--signal', 'STOP', nodeContainer]);
  paused = true;
  await appCompose('down');
  await onNode('docker', 'image', 'rm', local.desiredState.services.web.image);
  await request('/api/v1/control/restore', { artifactRef: backup.artifactRef, confirm: true });
  await compose('restart', 'control');
  await wait(
    () => fetch(`${control}/healthz`).then((r) => r.ok),
    'Restored control must become reachable',
  );
  await run('docker', ['kill', '--signal', 'CONT', nodeContainer]);
  paused = false;
  await expectContents('operator-local');
  const restoredImage = JSON.parse(
    await onNode('docker', 'image', 'inspect', local.desiredState.services.web.image),
  )[0];
  assert.equal(
    restoredImage.Id,
    local.desiredState.services.web.artifact.imageId,
    'A node missing its image must download the retained archive after control restore',
  );
  console.log(
    'Registry-free remote build, reused versions, rollback, agent restart, local build and backup restore passed.',
  );
} catch (error) {
  console.error(
    await compose('logs', '--no-color', '--tail', '100').catch(() => 'Could not fetch stack logs'),
  );
  throw error;
} finally {
  if (paused) await run('docker', ['kill', '--signal', 'CONT', nodeContainer]).catch(() => {});
  if (process.env.KEEP_INTEGRATION_STACK !== 'true') {
    await compose('down', '-v', '--remove-orphans').catch(() => {});
    for (const ref of imageRefs) await run('docker', ['image', 'rm', ref]).catch(() => {});
  }
  await fs.rm(directory, { recursive: true, force: true });
}
