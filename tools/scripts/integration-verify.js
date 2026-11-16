#!/usr/bin/env node
import { inspectPublishedServices } from './integration-verify-lib.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadCredential, mtlsFetch } from './mtls-fetch.js';

const exec = promisify(execFile);
const control = process.env.TUG_CONTROL_URL || 'https://127.0.0.1:18080';
const credential = loadCredential();
const project = process.env.TUG_PROJECT || 'sample';
const nodes = (process.env.TUG_NODES || 'vps-a,vps-b,vps-c')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const timeoutMs = Number(process.env.TUG_VERIFY_TIMEOUT_MS || 120000);

async function status() {
  const res = await mtlsFetch(credential, control, '/api/v1/status');
  if (!res.ok) throw new Error(`status: ${res.status} ${await res.text()}`);
  return res.json();
}

const started = Date.now();
let last;
while (Date.now() - started < timeoutMs) {
  last = await status();
  const projectRow = last.projects.find((p) => p.id === project);
  const deployment =
    projectRow && last.deployments.find((d) => d.id === projectRow.current_deployment_id);
  const statuses = last.statuses.filter((s) => s.project_id === project);
  const seenNodes = new Set(
    statuses
      .filter(
        (s) =>
          s.observed_version === deployment?.version && ['serving', 'skipped'].includes(s.health),
      )
      .map((s) => s.node),
  );
  if (deployment && nodes.every((n) => seenNodes.has(n))) {
    const inspected = await inspectPublishedServices(
      ['web', 'worker', 'cache'],
      async (service) => {
        const { stdout } = await exec(process.execPath, [
          'src/cli.ts',
          'inspect',
          service,
          '--project',
          project,
        ]);
        return JSON.parse(stdout);
      },
    );
    if (!inspected) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      continue;
    }
    console.log(
      JSON.stringify({ ok: true, version: deployment.version, nodes: [...seenNodes] }, null, 2),
    );
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 2000));
}
console.error(JSON.stringify({ ok: false, last }, null, 2));
process.exit(1);
