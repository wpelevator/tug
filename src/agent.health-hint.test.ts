import test from 'node:test';
import assert from 'node:assert/strict';
import { outsideContainerHint, runsInContainer, waitForHealth } from './agent.ts';
import type { AgentContext } from './agent.ts';
import { FakeDocker } from '../tests/fake-docker.ts';

test('health checks explain an agent that runs outside a container, and only then', () => {
  const tcp = { type: 'tcp', port: 3306 } as const;
  assert.match(
    outsideContainerHint(tcp, false),
    /not running in a container.*cannot\); run it with `docker run`/,
    'a host-process agent is told why container addresses are unreachable',
  );
  assert.match(
    outsideContainerHint({ type: 'http', port: 80 }, false),
    /not running in a container/,
  );
  assert.equal(outsideContainerHint(tcp, true), '', 'an agent in a container gets no hint');
  assert.equal(
    outsideContainerHint({ type: 'docker' }, false),
    '',
    'a Docker health check asks the daemon, so reachability does not matter',
  );
  assert.equal(typeof runsInContainer(), 'boolean');
});

test('a failed tcp health check carries the hint when the agent is not in a container', async () => {
  const docker = new FakeDocker();
  docker.addImage('db');
  const id = await docker.createContainer('proj-db', { Image: 'db', Labels: {} });
  await docker.startContainer(id);
  const ctx = {
    docker,
    http: fetch,
    nodeName: 'n1',
    stateDir: '/tmp/unused',
    apply: true,
    controlUrl: 'http://control.test',
    token: 't',
  } as AgentContext;
  // 127.0.0.1:1 is closed, so the check fails quickly with ECONNREFUSED.
  const failing = waitForHealth(ctx, 'proj', id, 'db', {
    type: 'tcp',
    port: 1,
    retries: 1,
    interval: '1ms',
    timeout: '200ms',
  });
  await assert.rejects(failing, (error: Error) => {
    assert.match(error.message, /db: tcp health check on port 1 failed after 1 attempt/);
    assert.equal(
      error.message.includes('not running in a container'),
      !runsInContainer(),
      'the hint appears exactly when this process is outside a container',
    );
    return true;
  });
});
