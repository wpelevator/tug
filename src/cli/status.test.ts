import test from 'node:test';
import assert from 'node:assert/strict';
import { deploymentsSharingLabel, formatIngressTls, formatStatus, labelKey } from './status.ts';
import type { StatusResponse } from './status.ts';

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

test('a service Docker keeps restarting is listed as unstable, not serving', () => {
  const crashing: StatusResponse = {
    ...status,
    statuses: [
      {
        ...status.statuses[0],
        status_json: JSON.stringify({
          serviceStates: {
            web: { rolloutState: 'serving', unstable: 'restarting after exiting with code 1' },
            db: { rolloutState: 'serving' },
          },
        }),
      },
    ],
  };
  const output = formatStatus(crashing);
  assert.match(
    output,
    /web: unstable — restarting after exiting with code 1/,
    'a crash loop must be visible in the status summary',
  );
  assert.match(output, /db: serving/, 'a stable service still reads as serving');
});

test('status flags an ingress node whose hosts have no certificate yet', () => {
  const output = formatStatus({
    ...status,
    nodes: [{ ...status.nodes[0], status: 'online', tls_not_issued: 2 }],
  });
  assert.match(
    output,
    /web: online; last seen .*; 2 hosts have no certificate yet \(tug ingress tls\)/,
    'serving must not hide hosts that clients cannot reach over HTTPS',
  );
});

test('the ingress TLS table lists hosts, reasons and unknown agents', () => {
  const output = formatIngressTls([
    {
      node: 'n1',
      state: 'serving',
      reportedAt: null,
      tls: [
        {
          host: 'a.example.com',
          state: 'issued',
          since: '2026-11-15T10:00:00Z',
          notAfter: '2027-02-01',
        },
        {
          host: 'b.example.com',
          state: 'failed',
          since: '2026-11-15T10:01:00Z',
          error: 'port 80 refused',
        },
      ],
    },
    { node: 'n2', state: 'serving', reportedAt: null, tls: null },
  ]);
  assert.match(
    output,
    /a\.example\.com\s+issued\s+\S+\s+valid until 2027-02-01/,
    'an issued host shows its expiry',
  );
  assert.match(
    output,
    /b\.example\.com\s+failed\s+\S+\s+port 80 refused/,
    'a failed host shows the reason',
  );
  assert.match(
    output,
    /n2\s+-\s+unknown\s+-\s+ingress serving; agent does not report TLS state/,
    'an old agent is unknown, not issued',
  );
  assert.equal(formatIngressTls([]), 'No ingress nodes', 'no ingress nodes says so');
});

test('status shows the deployment id when another deployment of the project has the same label, and omits it otherwise', () => {
  const rows = [
    {
      id: 'dep_new',
      version: 'git-25bdc82f8359',
      state: 'succeeded',
      error_message: null,
      project_id: 'site',
    },
    {
      id: 'dep_old',
      version: 'git-25bdc82f8359',
      state: 'succeeded',
      error_message: null,
      project_id: 'site',
    },
    {
      id: 'dep_other',
      version: 'git-25bdc82f8359',
      state: 'succeeded',
      error_message: null,
      project_id: 'blog',
    },
  ];
  const shared = formatStatus({
    projects: [{ id: 'site', current_deployment_id: 'dep_new' }],
    deployments: rows,
    nodes: [],
    statuses: [],
  });
  assert.match(
    shared,
    /Deployment: git-25bdc82f8359 \[dep_new\] \(succeeded\)/,
    'two deployments with one label must be told apart by id in status',
  );
  const unique = formatStatus({
    projects: [{ id: 'blog', current_deployment_id: 'dep_other' }],
    deployments: [rows[2]],
    nodes: [],
    statuses: [],
  });
  assert.doesNotMatch(unique, /\[dep_other\]/, 'a label that is unique keeps the plain line');
  assert.equal(
    deploymentsSharingLabel(
      [{ id: 'dep_1', version: 'git-abc', project_id: 'site' }],
      'dep_2',
      'site',
      'rollback-git-abc-1731668000123',
    ).join(),
    'dep_1',
    'a rollback label reads as the label of the deployment it replaced',
  );
  assert.equal(
    labelKey('rollback-git-abc-1731668000123'),
    'git-abc',
    'the rollback prefix and timestamp are not part of the label',
  );
  assert.equal(labelKey('v1.2.3'), 'v1.2.3', 'a custom label is kept as written');
});
