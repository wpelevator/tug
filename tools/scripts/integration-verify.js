#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const control = process.env.TUG_CONTROL_URL || 'http://localhost:8080';
const token = process.env.TUG_TOKEN || 'integration-token';
const project = process.env.TUG_PROJECT || 'sample';
const nodes = (process.env.TUG_NODES || 'vps-a,vps-b,vps-c')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const timeoutMs = Number(process.env.TUG_VERIFY_TIMEOUT_MS || 120000);

async function status() {
  const res = await fetch(`${control}/api/v1/status`, {
    headers: { authorization: `Bearer ${token}` },
  });
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
      .map((s) => s.node_id),
  );
  if (deployment && nodes.every((n) => seenNodes.has(n))) {
    for (const service of ['web', 'worker', 'cache']) {
      const { stdout } = await exec(process.execPath, [
        'src/cli.ts',
        'inspect',
        service,
        '--project',
        project,
      ]);
      const containers = JSON.parse(stdout);
      assert.ok(containers.length > 0, 'each published service must have a running container');
      for (const container of containers)
        assert.match(
          container.Config.Image,
          /@sha256:[a-f0-9]{64}$/,
          'running containers must use the digest pinned by control',
        );
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
