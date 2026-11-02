import test from 'node:test';
import assert from 'node:assert/strict';
import { formatStatus } from './cli-status.ts';
import type { StatusResponse } from './cli-status.ts';

const status: StatusResponse = {
  projects: [{ id: 'site', current_deployment_id: 'd1' }],
  deployments: [{ id: 'd1', version: 'v2', state: 'failed', error_message: 'health check failed' }],
  nodes: [{ id: 'n1', name: 'web', status: 'stale', last_seen_at: '2026-11-02T10:00:00Z' }],
  statuses: [
    {
      project_id: 'site',
      node_id: 'n1',
      node: 'web',
      health: 'serving',
      observed_version: 'v1',
      status_json: JSON.stringify({
        serviceStates: { web: { rolloutState: 'serving', rolloutError: 'candidate failed' } },
      }),
    },
  ],
};

test('readable status distinguishes stale observations and surfaces deployment and rollout errors', () => {
  const output = formatStatus(status);
  assert.match(
    output,
    /Project site\n[ ]{2}Deployment: v2 \(failed\)\n[ ]{2}Error: health check failed/,
    'the summary must show the current deployment and its error',
  );
  assert.match(
    output,
    /Node web: stale; last reported serving \(v1\)/,
    'the summary must identify stale data as the last report',
  );
  assert.match(
    output,
    /web: serving — candidate failed/,
    'the summary must include a rejected rollout reason',
  );
  assert.match(
    output,
    /web: stale; last seen 2026-11-02T10:00:00Z/,
    'the node inventory must show last contact',
  );
});

test('readable status handles missing reports and omitted older deployment rows', () => {
  const output = formatStatus({
    projects: [{ id: 'site', current_deployment_id: 'not-in-page' }],
    deployments: [],
    nodes: [],
    statuses: [],
  });
  assert.match(
    output,
    /current deployment not in recent results/,
    'the summary must not guess a deployment excluded by the API limit',
  );
  assert.match(output, /No node reports/, 'projects without node reports must be explicit');
  assert.match(output, /No nodes/, 'an empty node inventory must be explicit');
  assert.match(
    formatStatus({ projects: [], deployments: [], nodes: [], statuses: [] }),
    /No projects/,
    'an empty project list must be explicit',
  );
});

test('readable status keeps usable information when a node report is malformed', () => {
  const output = formatStatus({
    ...status,
    statuses: [{ ...status.statuses[0]!, status_json: '{' }],
  });
  assert.match(
    output,
    /Node web: stale; last reported serving/,
    'a malformed detail must not hide the node observation',
  );
  assert.match(output, /Report details unavailable/, 'the missing details must be reported');
});
