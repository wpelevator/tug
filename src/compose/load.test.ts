import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  UnsupportedComposeError,
  interpolate,
  loadCompose,
  parseDotenv,
  shellSplit,
} from './load.ts';
import { normalizeCompose } from './normalize.ts';

/** Secret names the shipped examples use, interpolated as sentinels like `tug deploy` does. */
const SECRETS = [
  'DB_PASS',
  'DB_PASSWORD',
  'DB_ROOT_PASSWORD',
  'APP_KEY',
  'S3_ACCESS_KEY',
  'S3_SECRET_KEY',
  'SECRET_KEY',
];

const fixtures = new URL('../../tests/fixtures/compose/', import.meta.url).pathname;

/** A project directory with the given files; `compose.yaml` is the file to load. */
async function project(files: Record<string, string>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-load-'));
  for (const [name, text] of Object.entries(files)) await fs.writeFile(path.join(dir, name), text);
  return { dir, file: path.join(dir, 'compose.yaml') };
}

const svc = (compose: Awaited<ReturnType<typeof loadCompose>>, name: string) =>
  compose.services[name] as Record<string, any>;

test('interpolation follows Compose: escapes, defaults, replacements, required values and nesting', () => {
  const vars: Record<string, string> = { SET: 'v', EMPTY: '' };
  const get = (name: string) => vars[name];
  const cases: [string, string][] = [
    ['$$HOME', '$HOME'],
    ['a$SET-b', 'av-b'],
    ['${SET}', 'v'],
    ['${UNSET}', ''],
    ['${UNSET:-d}', 'd'],
    ['${EMPTY:-d}', 'd'],
    ['${EMPTY-d}', ''],
    ['${SET:-d}', 'v'],
    ['${SET:+r}', 'r'],
    ['${EMPTY:+r}', ''],
    ['${EMPTY+r}', 'r'],
    ['${UNSET:-${SET}-${NOPE:-deep}}', 'v-deep'],
    ['$$$$', '$$'],
    ['price $$5', 'price $5'],
  ];
  for (const [input, expected] of cases)
    assert.equal(interpolate(input, get), expected, `${input} should interpolate to ${expected}`);
  assert.throws(
    () => interpolate('${UNSET:?needs a value}', get),
    /required variable UNSET is missing a value: needs a value/,
    '${VAR:?msg} fails with its message when the variable is unset',
  );
  assert.throws(
    () => interpolate('${EMPTY:?x}', get),
    /EMPTY is missing a value/,
    ':? also rejects an empty value',
  );
  assert.equal(interpolate('${EMPTY?x}', get), '', '? accepts an empty but set value');
  assert.throws(() => interpolate('cost $5', get), /invalid interpolation/, 'a lone $ is an error');
  assert.throws(
    () => interpolate('${SET', get),
    /missing closing brace/,
    'an open brace is an error',
  );
});

test('dotenv files support export, quotes, comments, interpolation and bare keys', () => {
  const parsed = parseDotenv(
    [
      '# comment',
      'A=1',
      'export B="two words ${A}"',
      "C='lit $A'",
      'D=x # trailing comment',
      'E=${A}${MISSING:-z}',
      'F="line\\nbreak"',
      'BARE',
      'G=a#b',
    ].join('\n'),
    (name) => (name === 'FROM_ENV' ? 'e' : undefined),
  );
  assert.deepEqual(
    parsed,
    {
      A: '1',
      B: 'two words 1',
      C: 'lit $A',
      D: 'x',
      E: '1z',
      F: 'line\nbreak',
      BARE: null,
      G: 'a#b',
    },
    'values are parsed with Compose dotenv rules',
  );
});

test('command strings split like Compose and refuse shell operators instead of dropping them', () => {
  assert.deepEqual(shellSplit(`echo "q \\" r" 'it''s' $$x tail\\ ing`), [
    'echo',
    'q " r',
    'its',
    '$$x',
    'tail ing',
  ]);
  assert.deepEqual(shellSplit('  a   b '), ['a', 'b'], 'runs of whitespace separate words');
  assert.deepEqual(shellSplit(`a '' b`), ['a', '', 'b'], 'an empty quoted word is kept');
  assert.throws(
    () => shellSplit('echo a && echo b'),
    /shell operator &/,
    'an operator is not silently dropped',
  );
  assert.throws(
    () => shellSplit('echo "open'),
    /unterminated quote/,
    'an unterminated quote is an error',
  );
});

test('short syntax is expanded to the long form the agent consumes', async () => {
  const { file } = await project({
    'compose.yaml': `
services:
  web:
    image: x
    command: sh -c "echo $$HOME"
    environment: [A=1, B, "C=a=b"]
    labels: [k=v, bare]
    ports: ["80", "8080:80", "127.0.0.1:81:81/udp", "[::1]:5000:50", "0.0.0.0::6000", "9000-9001:9100-9101"]
    expose: [1234, "99"]
    volumes: ["data:/data:ro", "./rel:/rel", "/abs:/abs:rw", "/anon"]
    depends_on: [db]
    healthcheck: {test: curl -f localhost}
    extra_hosts: ["a:1.2.3.4", "b=5.6.7.8"]
    tmpfs: /run
    build: ./web
  db:
    image: db
volumes:
  data:
`,
  });
  const web = svc(await loadCompose(file, { env: {} }), 'web');
  assert.deepEqual(
    web.command,
    ['sh', '-c', 'echo $HOME'],
    'command is split and a $$ becomes a literal $',
  );
  assert.deepEqual(
    web.environment,
    { A: '1', B: null, C: 'a=b' },
    'environment lists become maps; an unset bare key stays null',
  );
  assert.deepEqual(web.labels, { k: 'v', bare: '' }, 'label lists become maps');
  assert.deepEqual(
    web.ports,
    [
      { mode: 'ingress', target: 80, protocol: 'tcp' },
      { mode: 'ingress', target: 80, published: '8080', protocol: 'tcp' },
      { mode: 'ingress', host_ip: '127.0.0.1', target: 81, published: '81', protocol: 'udp' },
      { mode: 'ingress', host_ip: '::1', target: 50, published: '5000', protocol: 'tcp' },
      { mode: 'ingress', host_ip: '0.0.0.0', target: 6000, protocol: 'tcp' },
      { mode: 'ingress', target: 9100, published: '9000', protocol: 'tcp' },
      { mode: 'ingress', target: 9101, published: '9001', protocol: 'tcp' },
    ],
    'ports expand to long syntax, with ranges one entry per port and IPv6 hosts unbracketed',
  );
  assert.deepEqual(web.expose, ['1234', '99'], 'expose entries are strings');
  assert.deepEqual(
    web.volumes,
    [
      { type: 'volume', source: 'data', target: '/data', read_only: true, volume: {} },
      { type: 'bind', source: './rel', target: '/rel', bind: {} },
      { type: 'bind', source: '/abs', target: '/abs', bind: {} },
      { type: 'volume', target: '/anon', volume: {} },
    ],
    'volumes expand to long syntax; paths are kept as written',
  );
  assert.deepEqual(
    web.depends_on,
    { db: { condition: 'service_started', required: true } },
    'depends_on lists become maps with the default condition',
  );
  assert.deepEqual(
    web.healthcheck.test,
    ['CMD-SHELL', 'curl -f localhost'],
    'a string test runs in a shell',
  );
  assert.deepEqual(web.extra_hosts, ['a=1.2.3.4', 'b=5.6.7.8'], 'extra_hosts use name=ip');
  assert.deepEqual(web.tmpfs, ['/run'], 'a tmpfs string becomes a list');
  assert.deepEqual(
    web.build,
    { context: './web', dockerfile: 'Dockerfile' },
    'a build string becomes a context',
  );
});

test('variables resolve from the environment first, then .env, and env_file feeds the service environment', async () => {
  const { file } = await project({
    '.env': 'FROM_DOTENV=dotenv\nSHARED=dotenv\n',
    'app.env': 'FILE_ONLY=f\nSHARED=file\nOVERRIDDEN=file\nREF=${FROM_DOTENV}-ref\n',
    'compose.yaml': `
services:
  web:
    image: "x:\${TAG:-latest}-\${FROM_DOTENV}-\${SHARED}"
    env_file:
      - app.env
      - path: missing.env
        required: false
    environment:
      OVERRIDDEN: inline
      TAKEN: \${SHARED}
`,
  });
  const web = svc(await loadCompose(file, { env: { SHARED: 'process', TAG: '2' } }), 'web');
  assert.equal(web.image, 'x:2-dotenv-process', 'the process environment wins over .env');
  assert.deepEqual(
    web.environment,
    { FILE_ONLY: 'f', SHARED: 'file', OVERRIDDEN: 'inline', REF: 'dotenv-ref', TAKEN: 'process' },
    'environment overrides env_file, which is merged under it; env_file values interpolate',
  );
  assert.equal(web.env_file, undefined, 'env_file is merged and not kept');
  await assert.rejects(
    loadCompose(
      (await project({ 'compose.yaml': 'services:\n  w:\n    image: x\n    env_file: nope.env\n' }))
        .file,
      { env: {} },
    ),
    /env file nope.env could not be read/,
    'a required env_file that is missing is an error',
  );
});

test('profiles drop inactive services and unused top-level volumes are pruned like Compose', async () => {
  const text = `
name: shop
services:
  web:
    image: x
    volumes: [used:/d]
  debug:
    image: y
    profiles: [debug]
    volumes: [debugvol:/d]
volumes:
  used:
  debugvol:
  idle:
    labels: [a=b]
`;
  const { file } = await project({ 'compose.yaml': text });
  const off = await loadCompose(file, { env: {} });
  assert.deepEqual(
    Object.keys(off.services),
    ['web'],
    'a service in an inactive profile is not deployed',
  );
  assert.deepEqual(
    Object.keys(off.volumes ?? {}),
    ['used'],
    'volumes no remaining service mounts are dropped',
  );
  const on = await loadCompose(file, { env: { COMPOSE_PROFILES: 'debug' } });
  assert.deepEqual(
    Object.keys(on.services).sort(),
    ['debug', 'web'],
    'COMPOSE_PROFILES activates a profile',
  );
  assert.deepEqual(
    Object.keys(on.volumes ?? {}).sort(),
    ['debugvol', 'used'],
    'its volume comes with it',
  );
  assert.equal(off.name, 'shop', 'the file name is the project name');
  assert.equal(
    (await loadCompose(file, { env: {}, project: 'site' })).name,
    'site',
    'an explicit project wins',
  );
});

test('extends merges a base service with Compose rules, in the same file or another', async () => {
  const { file } = await project({
    'base.yaml': `
services:
  base:
    image: b
    environment: {A: "1", B: "2"}
    ports: ["80:80"]
    volumes: ["keep:/keep", "old:/data"]
    command: [x]
    labels: {k: v}
    healthcheck: {test: [CMD, a], retries: 3}
`,
    'compose.yaml': `
services:
  local:
    image: l
    cap_add: [NET_ADMIN]
  w:
    extends: {file: base.yaml, service: base}
    environment: {B: "3"}
    ports: ["81:81"]
    volumes: ["new:/data"]
    labels: [z=1]
    command: tail -f
    healthcheck: {test: [CMD, b]}
  l2:
    extends: local
    cap_add: [SYS_TIME]
volumes:
  keep:
  old:
  new:
`,
  });
  const compose = await loadCompose(file, { env: {} });
  const w = svc(compose, 'w');
  assert.equal(w.image, 'b', 'the base provides what the service leaves out');
  assert.deepEqual(w.environment, { A: '1', B: '3' }, 'mappings merge with the service winning');
  assert.deepEqual(w.labels, { k: 'v', z: '1' }, 'labels merge');
  assert.deepEqual(w.command, ['tail', '-f'], 'command is replaced, not appended');
  assert.deepEqual(
    w.ports.map((p: any) => p.published),
    ['80', '81'],
    'ports from both are kept',
  );
  assert.deepEqual(
    w.volumes.map((v: any) => `${v.source}:${v.target}`),
    ['keep:/keep', 'new:/data'],
    'a volume with the same target replaces the base one',
  );
  assert.deepEqual(
    w.healthcheck,
    { test: ['CMD', 'b'], retries: 3 },
    'healthcheck merges while its test is replaced',
  );
  assert.deepEqual(
    svc(compose, 'l2').cap_add,
    ['NET_ADMIN', 'SYS_TIME'],
    'a same-file extends appends cap_add',
  );
  assert.equal(w.extends, undefined, 'extends is resolved and not kept');
  await assert.rejects(
    loadCompose(
      (await project({ 'compose.yaml': 'services:\n  a:\n    extends: b\n  b:\n    extends: a\n' }))
        .file,
      { env: {} },
    ),
    /extends forms a cycle/,
    'a cycle in extends is an error',
  );
});

test('constructs the native reader does not implement are rejected with a pointer to --compose-cli', async () => {
  for (const [what, text] of [
    ['include', 'include: [other.yaml]\nservices:\n  a:\n    image: x\n'],
    ['a !reset tag', 'services:\n  a:\n    image: x\n    ports: !reset []\n'],
    ['an !override tag', 'services:\n  a:\n    image: x\n    ports: !override [ "1:1" ]\n'],
  ]) {
    const { file } = await project({ 'compose.yaml': text });
    await assert.rejects(
      loadCompose(file, { env: {} }),
      (error: Error) =>
        error instanceof UnsupportedComposeError && /--compose-cli/.test(error.message),
      `${what} should be rejected as unsupported, naming the fallback`,
    );
  }
  await assert.rejects(
    loadCompose((await project({ 'compose.yaml': 'name: x\n' })).file, { env: {} }),
    /defines no services/,
    'a file without services is rejected',
  );
});

test('the native reader renders what docker compose config renders (corpus comparison)', async (t) => {
  const probe = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' });
  if (probe.status !== 0) return t.skip('Docker Compose is not installed on this machine');
  const examples = new URL('../../examples/', import.meta.url).pathname;
  const files = [
    ...(await fs.readdir(fixtures)).map((name) => path.join(fixtures, name, 'compose.yaml')),
    ...(await fs.readdir(examples, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) =>
        ['compose.yaml', 'docker-compose.yml']
          .map((name) => path.join(examples, entry.name, name))
          .filter((candidate) => existsSync(candidate)),
      ),
  ];
  assert.ok(files.length > 6, 'the corpus should include the fixtures and the shipped examples');
  for (const file of files) {
    const name = path.relative(path.join(fixtures, '..', '..', '..'), file);
    // Compose resolves env_file against the working directory when paths are left unresolved; the native reader uses
    // the Compose file's directory, which is the same when tug deploy runs next to the file.
    const cwd = process.cwd();
    process.chdir(path.dirname(file));
    let native, compose: any;
    try {
      native = await normalizeCompose(file, SECRETS, { project: 'site' });
      compose = await normalizeCompose(file, SECRETS, { project: 'site', composeCli: true });
    } finally {
      process.chdir(cwd);
    }
    // What Compose adds that Tug ignores: the default network and the project prefix on volume names.
    delete compose.networks;
    // Compose before v2.30-ish adds `create_host_path: true` to short-syntax bind mounts and newer ones do not; the agent
    // binds the path either way, so the field is not part of the comparison.
    for (const service of Object.values<any>(compose.services)) {
      delete service.networks;
      for (const mount of service.volumes ?? [])
        if (mount.bind?.create_host_path === true) delete mount.bind.create_host_path;
    }
    for (const [key, volume] of Object.entries<any>(compose.volumes ?? {}))
      if (volume.name === `site_${key}`) delete volume.name;
    assert.deepEqual(
      native,
      compose,
      `${name}: the native reader should match docker compose config`,
    );
  }
});

test('sizes and durations are rendered the way Compose renders them', async () => {
  const { file } = await project({
    'compose.yaml': `
services:
  web:
    image: x
    mem_limit: 1g
    mem_reservation: 512m
    shm_size: 64m
    stop_grace_period: 90s
    healthcheck: {test: [CMD, a], interval: 1m, timeout: 500ms, start_period: 2h, retries: 2}
`,
  });
  const web = svc(await loadCompose(file, { env: {} }), 'web');
  assert.deepEqual(
    [web.mem_limit, web.mem_reservation, web.shm_size],
    ['1073741824', '536870912', '67108864'],
    'sizes become byte counts as strings',
  );
  assert.equal(web.stop_grace_period, '1m30s', 'durations use the Go text form');
  assert.deepEqual(
    [web.healthcheck.interval, web.healthcheck.timeout, web.healthcheck.start_period],
    ['1m0s', '500ms', '2h0m0s'],
    'healthcheck durations are normalized the same way',
  );
  await assert.rejects(
    loadCompose(
      (await project({ 'compose.yaml': 'services:\n  a:\n    image: x\n    mem_limit: lots\n' }))
        .file,
      { env: {} },
    ),
    /mem_limit "lots" is not a size/,
    'an unreadable size is an error that names the key',
  );
});
