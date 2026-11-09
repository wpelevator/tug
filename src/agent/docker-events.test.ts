import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeDocker } from '../../tests/fake-docker.ts';
import type { DockerEvent } from '../docker-api.ts';
import {
  CRASHLOOP_RESET_MS,
  DockerEventWatcher,
  EVENT_FILTERS,
  FailureReporter,
  REPEAT_QUIET_MS,
  classifyEvent,
  newRecentEvents,
} from './docker-events.ts';
import type { ReportedEvent } from './docker-events.ts';

const event = (
  action: string,
  attributes: Record<string, string> = {},
  time = 1000,
  id = 'abc123def456789',
): DockerEvent => ({
  Type: 'container',
  Action: action,
  Actor: {
    ID: id,
    Attributes: { 'tug.project': 'site', 'tug.service': 'web', name: 'site-web-1', ...attributes },
  },
  time,
  timeNano: time * 1e9,
});

test('a die is a crash unless something explains it: only a clean exit is not a failure by itself', () => {
  assert.equal(
    classifyEvent(event('die', { exitCode: '1' }))?.kind,
    'exited',
    'exit code 1 is a crash',
  );
  assert.equal(
    classifyEvent(event('die', { exitCode: '139' }))?.exitCode,
    139,
    'a segfault is a crash and keeps its code',
  );
  assert.equal(
    classifyEvent(event('die', { exitCode: '0' })),
    undefined,
    'a clean exit is not a failure',
  );
  for (const code of ['137', '143'])
    assert.equal(
      classifyEvent(event('die', { exitCode: code }))?.exitCode,
      Number(code),
      `exit code ${code} with no kill through the daemon is a signal from elsewhere, such as the host’s memory killer or kill -9`,
    );
});

test('a die right after a kill the daemon reported is a deliberate stop, whatever exit code the app chose on SIGTERM', () => {
  const recent = newRecentEvents();
  assert.equal(
    classifyEvent(event('kill', { signal: '15' }, 1000), recent),
    undefined,
    'the kill event itself is not a failure',
  );
  assert.equal(
    classifyEvent(event('die', { exitCode: '1' }, 1002), recent),
    undefined,
    'an app that exits 1 on SIGTERM is not crashing when it is stopped',
  );
  const timedOut = newRecentEvents();
  classifyEvent(event('kill', { signal: '15' }, 1000), timedOut);
  classifyEvent(event('kill', { signal: '9' }, 1010), timedOut);
  assert.equal(
    classifyEvent(event('die', { exitCode: '137' }, 1010), timedOut),
    undefined,
    'a stop that had to escalate to SIGKILL is still a stop',
  );
  assert.equal(
    classifyEvent(event('die', { exitCode: '1' }, 1200), timedOut)?.kind,
    'exited',
    'a die long after the kill is a separate crash',
  );
  const other = newRecentEvents();
  classifyEvent(event('kill', { signal: '15' }, 1000, 'someone-else'), other);
  assert.equal(
    classifyEvent(event('die', { exitCode: '1' }, 1001), other)?.kind,
    'exited',
    'a kill of a different container explains nothing',
  );
});

test('events remembered for a die are forgotten after their window, so the maps stay small', () => {
  const recent = newRecentEvents();
  for (let i = 0; i < 50; i++) classifyEvent(event('kill', {}, 1000 + i, `c${i}`), recent);
  classifyEvent(event('start', {}, 5000), recent);
  assert.equal(recent.kill.size, 0, 'old kill records are dropped');
});

test('only containers Tug manages for a service count, and job containers are expected to exit', () => {
  assert.equal(
    classifyEvent(event('die', { exitCode: '1', 'tug.service': '' })),
    undefined,
    'a container without a service label is not a service',
  );
  assert.equal(
    classifyEvent(event('die', { exitCode: '1', 'tug.job': 'run_1' })),
    undefined,
    'a one-off job container is expected to exit',
  );
  assert.equal(
    classifyEvent({ ...event('die', { exitCode: '1' }), Type: 'network' }),
    undefined,
    'only container events count',
  );
  assert.equal(classifyEvent(event('start')), undefined, 'a start is not a failure');
});

test('an out-of-memory kill is one failure: the die that follows it is dropped', () => {
  const recent = newRecentEvents();
  assert.equal(
    classifyEvent(event('oom', {}, 1000), recent)?.kind,
    'oom',
    'the oom event is the failure',
  );
  assert.equal(
    classifyEvent(event('die', { exitCode: '137' }, 1001), recent),
    undefined,
    'its die (137) is not reported again',
  );
  assert.equal(
    classifyEvent(event('die', { exitCode: '1' }, 1002), recent),
    undefined,
    'any die right after an oom is its consequence',
  );
  assert.equal(
    classifyEvent(event('die', { exitCode: '1' }, 1100), recent)?.kind,
    'exited',
    'a die long after is a separate crash',
  );
});

test('only an unhealthy health status is a failure', () => {
  assert.equal(
    classifyEvent(event('health_status: unhealthy'))?.kind,
    'unhealthy',
    'unhealthy is reported',
  );
  assert.equal(
    classifyEvent(event('health_status: healthy')),
    undefined,
    'recovery is not a failure',
  );
});

const crash = (at: number) => ({
  kind: 'exited' as const,
  project: 'site',
  service: 'web',
  container: 'c',
  exitCode: 1,
  at,
});

test('the first crash is reported once a minute, and repeats inside the minute are quiet', () => {
  const reporter = new FailureReporter('app1');
  const first = reporter.report(crash(0), 0);
  assert.equal(first?.type, 'container.exited', 'the first crash is reported');
  assert.match(
    first?.message ?? '',
    /web on app1 exited with code 1/,
    'the message names the service, node and code',
  );
  assert.equal(
    reporter.report(crash(10), 10_000),
    undefined,
    'a second crash within a minute is not another event',
  );
});

test('three crashes in five minutes become one crash loop event, then stay quiet until the service has been quiet', () => {
  const reporter = new FailureReporter('app1');
  const types: (string | undefined)[] = [];
  for (const at of [0, 20_000, 40_000, 60_000, 80_000])
    types.push(reporter.report(crash(at), at)?.type);
  assert.deepEqual(
    types,
    ['container.exited', undefined, 'container.crashloop', undefined, undefined],
    'one crash event, then one crash loop event, then silence while it keeps crashing',
  );
  const later = 80_000 + CRASHLOOP_RESET_MS + 1;
  assert.equal(
    reporter.report(crash(later), later)?.type,
    'container.exited',
    'after a long quiet spell a new crash is reported as a crash again',
  );
});

test('oom and unhealthy are reported at most once a minute per service', () => {
  const reporter = new FailureReporter('app1');
  const oom = { kind: 'oom' as const, project: 'site', service: 'web', container: 'c', at: 0 };
  assert.equal(reporter.report(oom, 0)?.level, 'error', 'an oom kill is an error');
  assert.equal(
    reporter.report(oom, REPEAT_QUIET_MS - 1),
    undefined,
    'a repeat inside the minute is dropped',
  );
  assert.equal(
    reporter.report(oom, REPEAT_QUIET_MS)?.type,
    'container.oom',
    'after the minute it is reported again',
  );
  const unhealthy = { ...oom, kind: 'unhealthy' as const };
  assert.equal(
    reporter.report(unhealthy, 0)?.type,
    'container.unhealthy',
    'unhealthy is a separate type with its own quiet period',
  );
});

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function watcher(docker: FakeDocker) {
  const posted: ReportedEvent[] = [];
  let wakes = 0;
  let now = 5_000_000;
  const sleeps: number[] = [];
  const instance = new DockerEventWatcher({
    docker,
    nodeName: 'app1',
    post: (reported) => void posted.push(reported),
    wake: () => void wakes++,
    now: () => now,
    sleep: async (ms) => void sleeps.push(ms),
  });
  return { instance, posted, sleeps, wakes: () => wakes, advance: (ms: number) => (now += ms) };
}

test('the watcher follows managed containers, reports a crash and asks the agent to reconcile', async () => {
  const docker = new FakeDocker();
  const w = watcher(docker);
  w.instance.start();
  await until(() => docker.eventCalls.length === 1, 'the stream to open');
  assert.deepEqual(
    docker.eventCalls[0].filters,
    EVENT_FILTERS,
    'the stream is limited to managed containers and the events that matter',
  );
  assert.equal(
    docker.eventCalls[0].since,
    5000,
    'it starts from now, not from the beginning of the daemon’s history',
  );
  docker.emit(event('die', { exitCode: '2' }, 5001));
  await until(() => w.posted.length === 1, 'the crash to be reported');
  assert.equal(w.posted[0].type, 'container.exited', 'the crash is reported');
  assert.equal(w.wakes(), 1, 'the agent is asked to reconcile at once');
  docker.emit(event('kill', { signal: '15' }, 5002, 'other'));
  docker.emit(event('die', { exitCode: '1' }, 5002, 'other'));
  docker.emit(event('start', {}, 5003));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(w.posted.length, 1, 'a deliberate stop and a start report nothing');
  await w.instance.stop();
});

test('after the stream drops the watcher reconnects with backoff, resumes from the last event and skips replays', async () => {
  const docker = new FakeDocker();
  const w = watcher(docker);
  w.instance.start();
  await until(() => docker.eventCalls.length === 1, 'the first stream');
  docker.emit(event('die', { exitCode: '2' }, 5100));
  await until(() => w.posted.length === 1, 'the first crash');
  docker.dropEventStreams();
  await until(() => docker.eventCalls.length === 2, 'the second stream');
  assert.deepEqual(w.sleeps, [1000], 'it waits before reconnecting');
  assert.equal(docker.eventCalls[1].since, 5100, 'it resumes from the last event it saw');
  w.advance(REPEAT_QUIET_MS + 1);
  docker.emit(event('die', { exitCode: '2' }, 5100));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(
    w.posted.length,
    1,
    'the daemon replays the resume second, and the same event is not reported twice',
  );
  await w.instance.stop();
});

test('stop ends the loop without a retry', async () => {
  const docker = new FakeDocker();
  const w = watcher(docker);
  w.instance.start();
  await until(() => docker.eventCalls.length === 1, 'the stream');
  await w.instance.stop();
  assert.equal(docker.eventStreams.size, 0, 'the stream is closed');
  assert.deepEqual(w.sleeps, [], 'stopping is not treated as a failure to retry');
});
