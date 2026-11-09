import assert from 'node:assert/strict';
import test from 'node:test';
import { FakeDocker } from '../../tests/fake-docker.ts';
import type { FakeContainer } from '../../tests/fake-docker.ts';
import { unstableServices } from './stability.ts';

async function withService(
  state: FakeContainer['state'],
  exitCode?: number,
  service = 'web',
): Promise<FakeDocker> {
  const docker = new FakeDocker();
  docker.addImage('app');
  const id = await docker.createContainer(`site-${service}-1`, {
    Image: 'app',
    Labels: { 'tug.project': 'site', 'tug.service': service },
  });
  const container = docker.containers.get(id)!;
  container.state = state;
  container.exitCode = exitCode;
  return docker;
}

test('a container Docker keeps restarting is reported as unstable with its exit code', async () => {
  const docker = await withService('restarting', 1);
  assert.deepEqual(
    await unstableServices(docker, 'site', ['web']),
    { web: 'restarting after exiting with code 1' },
    'a crash loop must not read as serving',
  );
});

test('a container that exited with an error and stays down is unstable', async () => {
  const docker = await withService('exited', 2);
  assert.deepEqual(await unstableServices(docker, 'site', ['web']), {
    web: 'exited with code 2',
  });
});

test('a service stopped on purpose or exited cleanly is not called unstable', async () => {
  for (const code of [0, 137, 143])
    assert.deepEqual(
      await unstableServices(await withService('exited', code), 'site', ['web']),
      {},
      `exit code ${code} is an ordinary stop`,
    );
  assert.deepEqual(
    await unstableServices(await withService('running'), 'site', ['web']),
    {},
    'a running container is stable',
  );
});

test('an old revision of a rolling service that exited is not a crash, but a restarting one is', async () => {
  const exited = await withService('exited', 1);
  assert.deepEqual(
    await unstableServices(exited, 'site', ['web'], new Set(['web'])),
    {},
    'rollouts stop old revisions on purpose',
  );
  const restarting = await withService('restarting', 1);
  assert.deepEqual(
    await unstableServices(restarting, 'site', ['web'], new Set(['web'])),
    { web: 'restarting after exiting with code 1' },
    'a rolling service stuck restarting is reported',
  );
});

test('other projects and services are not blamed', async () => {
  const docker = await withService('restarting', 1, 'worker');
  assert.deepEqual(await unstableServices(docker, 'site', ['web']), {}, 'only the named services');
  assert.deepEqual(await unstableServices(docker, 'other', ['worker']), {}, 'only this project');
});
