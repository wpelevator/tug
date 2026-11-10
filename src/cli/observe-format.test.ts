import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatContainers,
  formatDoctor,
  formatEvents,
  formatTable,
  shortImage,
} from './observe-format.ts';

test('formatTable aligns columns by terminal width and trims trailing spaces', () => {
  assert.equal(
    formatTable([
      ['A', 'B', 'C'],
      ['wide-cell', 'x', ''],
    ]),
    'A          B  C\nwide-cell  x',
    'each column is as wide as its widest cell, and an empty last cell leaves no trailing spaces',
  );
  assert.equal(
    formatTable([
      ['名前', 'X'],
      ['ab', 'y'],
    ]),
    '名前  X\nab    y',
    'wide characters count as two columns so later columns stay aligned',
  );
});

test('shortImage keeps twelve digest characters of a pinned image and leaves tags alone', () => {
  assert.equal(shortImage(`nginx@sha256:${'a'.repeat(64)}`), 'nginx@sha256:aaaaaaaaaaaa');
  assert.equal(shortImage('nginx:1.27-alpine'), 'nginx:1.27-alpine', 'a tag is printed as written');
});

test('formatContainers lists services first with state, image, published ports and container name', () => {
  const out = formatContainers([
    {
      Names: ['/tug-site-web-1a2b3c4d'],
      Image: `nginx@sha256:${'b'.repeat(64)}`,
      State: 'running',
      Status: 'Up 2 hours (healthy)',
      Labels: { 'tug.project': 'site', 'tug.service': 'web' },
      Ports: [
        { IP: '127.0.0.1', PrivatePort: 80, PublicPort: 8080, Type: 'tcp' },
        { PrivatePort: 443, Type: 'tcp' },
      ],
    },
    {
      Names: ['/tug-site-db-5e6f7a8b'],
      Image: 'mariadb:11.4',
      State: 'exited',
      Status: 'Exited (1) 3 minutes ago',
      Labels: { 'tug.project': 'site', 'tug.service': 'db' },
    },
  ]).split('\n');
  assert.match(out[0], /^SERVICE\s+STATE\s+STATUS\s+IMAGE\s+PORTS\s+CONTAINER$/, 'a header row');
  assert.match(
    out[1],
    /^db\s+exited\s+Exited \(1\) 3 minutes ago\s+mariadb:11\.4\s+-\s+tug-site-db-5e6f7a8b$/,
    'rows are sorted by service, and a container without published ports shows -',
  );
  assert.match(
    out[2],
    /^web\s+running\s+Up 2 hours \(healthy\)\s+nginx@sha256:bbbbbbbbbbbb\s+127\.0\.0\.1:8080->80\/tcp\s+tug-site-web-1a2b3c4d$/,
    'only published ports are listed, as host:public->private/protocol, and the digest is shortened',
  );
  assert.equal(
    formatContainers([]),
    'No containers',
    'an empty list says so instead of a bare header',
  );
});

test('human event output strips terminal styling and flattens control characters', () => {
  const rendered = formatEvents(
    [{ type: '\x1b[31mservice.serving\x1b[0m', message: 'Ready\nfor requests' }],
    { showProject: false },
  );
  assert.match(
    rendered,
    /service\.serving\s+.*Ready for requests/,
    'the event remains readable on one row',
  );
  assert.ok(!rendered.includes('\x1b'), 'the human output contains no terminal escape');
});

test('formatEvents shows the project column only when events from several projects can appear', () => {
  const events = [
    {
      created_at: '2026-11-09T10:00:00Z',
      level: 'error',
      type: 'backup.failed',
      project_id: 'site',
      actor: null,
      message: 'restic exited 1:\n  repository locked',
    },
    {
      created_at: '2026-11-09T09:00:00Z',
      level: 'info',
      type: 'deployment.succeeded',
      project_id: 'site',
      actor: 'ci',
      message: 'v42 is serving',
    },
  ];
  const project = formatEvents(events, { showProject: false }).split('\n');
  assert.match(
    project[0],
    /^TIME\s+LEVEL\s+TYPE\s+ACTOR\s+MESSAGE$/,
    'no PROJECT column for one project',
  );
  assert.match(
    project[1],
    /^2026-11-09T10:00:00Z\s+error\s+backup\.failed\s+-\s+restic exited 1: repository locked$/,
    'a multi-line message is folded onto its row, and a missing actor shows -',
  );
  assert.match(project[2], /\bci\s+v42 is serving$/, 'the acting credential is shown');
  const all = formatEvents(events, { showProject: true }).split('\n');
  assert.match(all[0], /^TIME\s+LEVEL\s+TYPE\s+PROJECT\s+ACTOR\s+MESSAGE$/, '--all adds PROJECT');
  assert.equal(formatEvents([], { showProject: false }), 'No events');
});

test('formatDoctor groups checks by where they ran, shows failures and warnings, and ends with a verdict', () => {
  const out = formatDoctor({
    ok: false,
    local: [
      { name: 'node', ok: true, output: 'v22.18.0' },
      { name: 'docker', ok: false, error: 'spawn docker ENOENT' },
    ],
    control: {
      ok: false,
      checks: [
        { name: 'sqlite', ok: true, value: 3 },
        {
          name: 'certificates',
          ok: true,
          warnings: ['the server certificate expires in 9 days and has not renewed'],
        },
        { name: 'nodes', ok: false, error: 'app2: clock skew 45s' },
      ],
    },
    nodeDiagnostics: {
      commands: [
        {
          nodeId: 'node_1',
          state: 'succeeded',
          result: {
            node: 'app1',
            checks: [{ name: 'docker.info', ok: true, stdout: '{\n  "ID": "x"\n}' }],
          },
        },
      ],
    },
  });
  const lines = out.split('\n');
  assert.equal(lines[0], 'This machine', 'local checks come first under a heading');
  assert.match(lines[1], /^ {2}ok\s+node\s+v22\.18\.0$/, 'a passing check shows a short detail');
  assert.match(
    lines[2],
    /^ {2}FAIL\s+docker\s+spawn docker ENOENT$/,
    'a failing check shows its error',
  );
  assert.ok(lines.includes('Control'), 'control checks have their own heading');
  assert.ok(
    lines.some((line) => /^ {2}warn\s+certificates$/.test(line)),
    'a passing check with warnings is marked warn',
  );
  assert.ok(
    lines.includes('        the server certificate expires in 9 days and has not renewed'),
    'each warning is printed under its check',
  );
  assert.ok(lines.includes('Node app1 (succeeded)'), 'node diagnostics are grouped by node name');
  assert.ok(
    lines.some((line) => /^ {2}ok\s+docker\.info$/.test(line)),
    'multi-line output such as docker info is left to --json',
  );
  assert.equal(lines.at(-1), 'Problems found: see FAIL lines above.', 'the verdict comes last');
  assert.equal(
    formatDoctor({ ok: true, local: [], control: { ok: true, checks: [] } })
      .split('\n')
      .at(-1),
    'No problems found.',
  );
});
