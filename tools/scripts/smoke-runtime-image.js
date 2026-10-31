#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const image = process.env.TUG_RUNTIME_IMAGE || `tug-runtime-smoke:${process.pid}`;

function docker(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    child.stdout.on('data', chunk => { out = (out + chunk).slice(-24000); });
    child.stderr.on('data', chunk => { err = (err + chunk).slice(-24000); });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(out.trim()) : reject(new Error(`docker ${args.join(' ')} failed (${code})\n${out}\n${err}`)));
  });
}

try {
  if (!process.env.TUG_RUNTIME_IMAGE) {
    console.log('Building the shipped runtime image for packaging checks…');
    await docker(['build', '-t', image, '.']);
  }
  const client = await docker(['run', '--rm', '--entrypoint', 'docker', image, '--version']);
  assert.match(client, /^Docker version /, 'The shipped runtime image must include a working Docker client');
  const compose = await docker(['run', '--rm', '--entrypoint', 'docker', image, 'compose', 'version', '--short']);
  assert.match(compose, /^v?\d+\.\d+\.\d+/, 'The shipped runtime image must include a discoverable executable Compose plugin');
  const node = await docker(['run', '--rm', '--entrypoint', 'node', image, '--version']);
  assert.match(node, /^v\d+\./, 'The shipped runtime image must include a working Node.js executable');
  console.log(`Runtime image packaging passed: ${client}; Compose ${compose}; Node ${node}. No host Docker socket or host plugin was mounted.`);
} finally {
  if (!process.env.TUG_RUNTIME_IMAGE) await docker(['image', 'rm', image]).catch(() => {});
}
