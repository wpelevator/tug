#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const image = process.env.TUG_RUNTIME_IMAGE || `tug-runtime-smoke:${process.pid}`;

function docker(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => {
      out = (out + chunk).slice(-24000);
    });
    child.stderr.on('data', (chunk) => {
      err = (err + chunk).slice(-24000);
    });
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0
        ? resolve(out.trim())
        : reject(new Error(`docker ${args.join(' ')} failed (${code})\n${out}\n${err}`)),
    );
  });
}

try {
  if (!process.env.TUG_RUNTIME_IMAGE) {
    console.log('Building the shipped runtime image for packaging checks…');
    await docker([
      'build',
      '-f',
      process.env.TUG_RUNTIME_DOCKERFILE || 'Dockerfile',
      '-t',
      image,
      '.',
    ]);
  }
  const client = await docker(['run', '--rm', '--entrypoint', 'docker', image, '--version']);
  assert.match(
    client,
    /^Docker version /,
    'The shipped runtime image must include a working Docker client',
  );
  const node = await docker(['run', '--rm', '--entrypoint', 'node', image, '--version']);
  assert.match(
    node,
    /^v\d+\./,
    'The shipped runtime image must include a working Node.js executable',
  );
  const mtls = JSON.parse(
    await docker([
      'run',
      '--rm',
      '--entrypoint',
      'node',
      image,
      'tools/scripts/verify-mtls-runtime.js',
    ]),
  );
  assert.ok(
    mtls.results.every((result) => result.ok),
    'The shipped runtime image must issue certificates and complete mTLS requests with undici',
  );
  await docker([
    'run',
    '--rm',
    '--entrypoint',
    'node',
    image,
    '--input-type=module',
    '-e',
    `import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDb, openAgentDb, openSnapshotDb } from './dist/db.js';
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-smoke-'));
try {
  const db = await openDb(path.join(dir, 'control.db'));
  try {
    assert.deepEqual(db.run('INSERT INTO projects(id,name) VALUES(?,?)', 'smoke', 'smoke'), { changes: 1 }, 'compiled control writes must work');
    db.run('VACUUM INTO ?', path.join(dir, 'snapshot.db'));
  } finally { db.close(); }
  const snapshot = openSnapshotDb(path.join(dir, 'snapshot.db'));
  try {
    assert.deepEqual(snapshot.get('SELECT id FROM projects'), { id: 'smoke' }, 'compiled snapshots must retain control data');
    assert.throws(() => snapshot.run('DELETE FROM projects'), Error, 'compiled snapshots must be read-only');
  } finally { snapshot.close(); }
  const agent = await openAgentDb(path.join(dir, 'agent.db'));
  try { assert.deepEqual(agent.all('SELECT * FROM applied_state'), [], 'compiled agent schema must initialize'); }
  finally { agent.close(); }
  for (const addon of ['sqlite', 'sqlite3']) {
    await assert.rejects(fs.access(path.join('node_modules', addon)), 'the image must not ship SQLite npm addons');
  }
} finally { await fs.rm(dir, { recursive: true, force: true }); }`,
  ]);
  console.log(
    `Runtime image packaging passed: ${client}; Node ${node}; mTLS issuance and undici transport verified. No host Docker socket or host plugin was mounted.`,
  );
} finally {
  if (!process.env.TUG_RUNTIME_IMAGE) await docker(['image', 'rm', image]).catch(() => {});
}
