import assert from 'node:assert/strict';
import { readFile, readdir, access } from 'node:fs/promises';
import { test } from 'node:test';
import * as yaml from 'js-yaml';
import { cases } from './cases.mjs';

const readYaml = async (path) => yaml.load(await readFile(new URL(path, import.meta.url), 'utf8'));
const common = await readYaml('./compose.yml');

test('benchmark automation runs separately through manual dispatch on main only', async () => {
  const workflow = await readYaml('../../.github/workflows/benchmarks.yml');
  const ci = await readYaml('../../.github/workflows/ci.yml');
  assert.deepEqual(
    Object.keys(workflow.on),
    ['workflow_dispatch'],
    'only explicit manual dispatch should trigger benchmark runs',
  );
  assert.equal(
    workflow.on.pull_request,
    undefined,
    'pull requests should not trigger measurements',
  );
  assert.equal(
    workflow.jobs.benchmark.if,
    "github.ref == 'refs/heads/main'",
    'manual dispatch should also be restricted to main',
  );
  assert.ok(
    workflow.jobs.benchmark.steps.some((step) => step.run === 'npm run benchmark:examples'),
    'the dedicated workflow should run the actual example measurements',
  );
  const artifact = workflow.jobs.benchmark.steps.find((step) =>
    step.uses?.startsWith('actions/upload-artifact@'),
  );
  assert.equal(
    artifact.if,
    'always()',
    'partial failure reports should be uploaded as well as successful reports',
  );
  assert.equal(
    artifact.with.path,
    'benchmarks/examples/results/*.json',
    'artifacts should contain reports without generated private keys',
  );
  for (const job of Object.values(ci.jobs)) {
    assert.ok(
      !(job.steps ?? []).some(
        (step) => step.run?.includes('test:benchmarks') || step.run?.includes('benchmark:examples'),
      ),
      'the main CI workflow should not run the separate benchmark suite',
    );
  }
});

test('every deployable example stack has a benchmark case', async () => {
  const root = new URL('../../examples/', import.meta.url);
  const stacks = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      await access(new URL(`${entry.name}/docker-compose.yml`, root));
      stacks.push(entry.name);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  assert.deepEqual(
    Object.keys(cases).sort(),
    stacks.sort(),
    'benchmark cases should cover every example with a Compose deployment',
  );
});

for (const stack of Object.keys(cases)) {
  test(`${stack} fixture preserves example images and server defaults`, async () => {
    const fixture = await readYaml(`./compose.${stack}.yml`);
    const example = await readYaml(`../../examples/${stack}/docker-compose.yml`);
    const sourceWeb = example.services[stack === 'wordpress' ? 'wordpress' : 'web'];
    assert.equal(
      fixture.services.db.image,
      example.services.db.image,
      'database image should match the example',
    );
    if (stack === 'wordpress') {
      assert.equal(
        fixture.services.web.image,
        sourceWeb.image,
        'WordPress image should match the example',
      );
      assert.deepEqual(
        fixture.services.db.command,
        example.services.db.command,
        'WordPress database settings should match the example',
      );
      assert.ok(
        fixture.services.install.image === 'wordpress:cli-php8.3',
        'installer should use the PHP 8.3 WordPress CLI image',
      );
    } else {
      assert.ok(
        fixture.services.s3.command.includes('-ip=s3 -ip.bind=0.0.0.0'),
        'S3 should listen on the container network using its service address',
      );
      const expectedBuild =
        stack === 'laravel' ? '../../examples/laravel' : `../../examples/${stack}/app`;
      assert.equal(
        fixture.services.web.build,
        expectedBuild,
        'web should build the original example Dockerfile',
      );
      assert.equal(
        fixture.services.redis.image,
        example.services.redis.image,
        'Redis image should match the example',
      );
      assert.equal(
        fixture.services.web.command,
        undefined,
        'web should retain the Dockerfile server command',
      );
      assert.equal(
        fixture.services.migrate.profiles[0],
        'setup',
        'migration must be an explicit setup service',
      );
      assert.equal(
        fixture.services['s3-init'].profiles[0],
        'setup',
        'bucket creation must be an explicit setup service',
      );
      assert.equal(
        fixture.services.web.environment.S3_ENDPOINT ??
          fixture.services.web.environment.AWS_ENDPOINT,
        'http://s3:9000',
        'object storage should be local',
      );
    }
    for (const service of cases[stack].services) {
      assert.ok(
        fixture.services[service] || common.services[service],
        `measured service ${service} should exist`,
      );
    }
    for (const service of cases[stack].setup) {
      assert.ok(fixture.services[service], `setup service ${service} should exist`);
    }
    for (const [name, service] of Object.entries({ ...common.services, ...fixture.services })) {
      assert.equal(service.ports, undefined, `${name} should not expose host ports`);
    }
    assert.ok(fixture.services.db.healthcheck, 'database should provide a readiness check');
  });
}

test('load and TLS services use the local driver and certificates', () => {
  assert.equal(
    common.services.load.image,
    'node:24-alpine',
    'load driver should use the specified Node image',
  );
  assert.deepEqual(
    common.services.load.entrypoint,
    ['node', '/load.mjs'],
    'load service should execute the benchmark driver',
  );
  assert.ok(
    common.services.caddy.volumes.includes('./certs:/certs:ro'),
    'Caddy should read local benchmark certificates',
  );
});
