import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawnSync } from 'node:child_process';
import { buildDesiredState } from '../../src/compose.ts';

let projectDir = '';

function dockerInspect(name: string) {
  const r = spawnSync('docker', ['compose', '-p', 'lpsecrettest', 'ps', '-q', name], {
    cwd: projectDir,
    encoding: 'utf8',
  });
  const id = r.stdout.trim().split('\n')[0];
  if (!id) return null;
  const inspected = spawnSync('docker', ['inspect', id], { encoding: 'utf8' });
  return JSON.parse(inspected.stdout)[0];
}

test(
  'changing one secret only recreates the service that references it',
  { timeout: 120000 },
  async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-secret-restart-'));
    projectDir = path.join(dir, 'projects', 'lpsecrettest');

    let secretVersions = { SECRET_A: 1 };
    const server = http.createServer((req, res) => {
      if (req.url?.startsWith('/agent/v1/secrets')) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ secrets: { SECRET_A: 'value-for-a' }, versions: secretVersions }));
        return;
      }
      if (req.url?.startsWith('/agent/v1/events')) {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          res.end('{"ok":true}');
        });
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;

    process.env.TUG_CONTROL_URL = `http://127.0.0.1:${port}`;
    process.env.TUG_AGENT_TOKEN = 'test-token';
    process.env.TUG_NODE_NAME = 'n1';
    process.env.TUG_STATE_DIR = path.join(dir);
    process.env.TUG_APPLY = 'true';
    const { reconcile } = await import('../../src/agent.ts');

    const compose = {
      services: {
        svc_with_secret: {
          image: 'busybox:1.36',
          command: ['sh', '-c', 'sleep 600'],
          environment: { SECRET_A: '${SECRET_A}' },
          'x-tug': { placement: { nodes: ['n1'] } },
        },
        svc_without_secret: {
          image: 'busybox:1.36',
          command: ['sh', '-c', 'sleep 600'],
          environment: { STATIC: 'unrelated' },
          'x-tug': { placement: { nodes: ['n1'] } },
        },
      },
    };
    const desired = buildDesiredState({
      project: 'lpsecrettest',
      version: 'v1',
      compose,
      registry: 'unused',
      defaultNode: 'n1',
    });

    t.after(async () => {
      spawnSync('docker', ['compose', '-p', 'lpsecrettest', 'down', '-v', '--remove-orphans'], {
        cwd: projectDir,
      });
      await new Promise((resolve) => server.close(resolve));
      await fs.rm(dir, { recursive: true, force: true });
    });

    await reconcile(desired);
    const beforeWith = dockerInspect('svc_with_secret');
    const beforeWithout = dockerInspect('svc_without_secret');
    assert.ok(beforeWith?.State?.Running);
    assert.ok(beforeWithout?.State?.Running);

    secretVersions = { SECRET_A: 2 };
    await reconcile(desired);

    const afterWith = dockerInspect('svc_with_secret');
    const afterWithout = dockerInspect('svc_without_secret');

    assert.notEqual(
      afterWith?.Id,
      beforeWith?.Id,
      'service referencing the changed secret should be recreated',
    );
    assert.equal(
      afterWithout?.Id,
      beforeWithout?.Id,
      'service not referencing the changed secret should not be recreated',
    );
  },
);
