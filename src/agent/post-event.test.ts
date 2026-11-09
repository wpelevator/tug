import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeDocker } from '../../tests/fake-docker.ts';
import { postEvent } from './agent.ts';
import type { AgentContext } from './agent.ts';
import type { AgentEvent } from '../protocol.ts';

function context(over: Partial<AgentContext> = {}) {
  const requests: { url: string; body: unknown }[] = [];
  const ctx = {
    docker: new FakeDocker(),
    http: async (url: string, init?: { body?: string }) => {
      requests.push({ url, body: JSON.parse(init?.body ?? 'null') });
      return { ok: true, json: async () => ({ ok: true }), text: async () => '' };
    },
    nodeName: 'n1',
    stateDir: '/tmp/none',
    apply: false,
    controlUrl: 'https://control.test',
    ...over,
  } as unknown as AgentContext;
  return { ctx, requests };
}
const event: AgentEvent = {
  projectId: 'site',
  level: 'warn',
  type: 'container.exited',
  message: 'web exited',
  metadata: { exitCode: 2 },
};

test('an event goes over the stream socket when it is open, with no HTTP request', async () => {
  const sent: AgentEvent[] = [];
  const { ctx, requests } = context({ pushEvent: (e) => (sent.push(e), true) });
  await postEvent(ctx, event);
  assert.deepEqual(sent, [event], 'the socket carries the event');
  assert.equal(requests.length, 0, 'no request is made when the socket took it');
});

test('an event falls back to POST /agent/v1/events when there is no open socket', async () => {
  for (const pushEvent of [undefined, () => false]) {
    const { ctx, requests } = context(pushEvent ? { pushEvent } : {});
    await postEvent(ctx, event);
    assert.deepEqual(
      requests,
      [{ url: 'https://control.test/agent/v1/events', body: event }],
      'the same event is posted over HTTP',
    );
  }
});
