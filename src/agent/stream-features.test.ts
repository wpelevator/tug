import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';
import { FakeDocker } from '../../tests/fake-docker.ts';
import { AgentWakeChannel } from './agent.ts';
import type { AgentContext } from './agent.ts';
import type { AgentEvent } from '../protocol.ts';

class FakeSocket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent: string[] = [];
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.emit('close');
  }
  terminate() {
    this.close();
  }
  say(frame: unknown) {
    this.emit('message', Buffer.from(JSON.stringify(frame)), false);
  }
}

const event: AgentEvent = {
  projectId: 'site',
  level: 'warn',
  type: 'container.exited',
  message: 'web exited',
};

/** A channel connected to a fake socket; `hello` is what the control says in its `ready` frame. */
async function connected(hello: Record<string, unknown>) {
  const socket = new FakeSocket();
  const ctx = {
    docker: new FakeDocker(),
    controlUrl: 'https://control.test',
    credential: {},
  } as unknown as AgentContext;
  const channel = new AgentWakeChannel(ctx, () => socket as unknown as WebSocket);
  const waiting = channel.wait(20);
  socket.emit('open');
  socket.say({ type: 'ready', nodeId: 'node_1', cursor: 0, ...hello });
  await waiting;
  return { channel, socket };
}

test('an older control that lists no features gets no agent.event frames, so it cannot close the socket over one', async () => {
  const { channel, socket } = await connected({});
  assert.equal(
    channel.sendEvent(event),
    false,
    'without a features list the event is left for HTTP',
  );
  assert.deepEqual(
    socket.sent,
    [],
    'nothing unknown was sent to a control that might close the socket on it',
  );
});

test('a control that lists agent.event gets events on the socket as frames', async () => {
  const { channel, socket } = await connected({ features: ['agent.event'] });
  assert.equal(channel.sendEvent(event), true, 'the socket takes the event');
  assert.deepEqual(
    JSON.parse(socket.sent[0]),
    { v: 1, type: 'agent.event', events: [event] },
    'as an agent.event frame',
  );
});

test('features are per connection: a lost socket and a reconnect to a control without them go back to HTTP', async () => {
  const { channel, socket } = await connected({ features: ['agent.event', 'something.new'] });
  assert.equal(channel.sendEvent(event), true, 'the feature is used while it is listed');
  socket.close();
  assert.equal(channel.sendEvent(event), false, 'a closed socket carries nothing');
  const again = new FakeSocket();
  const ctx = {
    docker: new FakeDocker(),
    controlUrl: 'https://control.test',
    credential: {},
  } as unknown as AgentContext;
  const second = new AgentWakeChannel(ctx, () => again as unknown as WebSocket);
  const waiting = second.wait(20);
  again.emit('open');
  again.say({ type: 'ready', nodeId: 'node_1', cursor: 0, features: 'agent.event' });
  await waiting;
  assert.equal(
    second.sendEvent(event),
    false,
    'a features field that is not a list is treated as none',
  );
});
