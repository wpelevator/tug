import test from 'node:test';
import assert from 'node:assert/strict';
import { agentIdentityArgs, planNodeAdd } from './node.ts';
import type { NodeIdentityOpts, PlanDeps } from './node.ts';

const opts = (over: Partial<NodeIdentityOpts> = {}): NodeIdentityOpts => ({
  label: [],
  wait: true,
  ...over,
});

/** Records every question so a test can assert what was (not) asked. */
function deps(over: Partial<PlanDeps>, answers: string[] = []): PlanDeps & { asked: string[] } {
  const asked: string[] = [];
  return {
    interactive: true,
    hasDocker: () => true,
    discover: () => [],
    prompt: async (question) => {
      asked.push(question);
      return answers.shift() ?? '';
    },
    ...over,
    asked,
  };
}

const quiet = async <T>(run: () => Promise<T>): Promise<T> => {
  const original = console.error;
  console.error = () => {};
  try {
    return await run();
  } finally {
    console.error = original;
  }
};

test('without a terminal node add neither probes the host nor asks anything', async () => {
  let probed = false;
  const d = deps({
    interactive: false,
    hasDocker: () => ((probed = true), false),
    discover: () => ((probed = true), []),
  });
  const o = opts();
  await quiet(() => planNodeAdd('root@app1', 'app1', o, d));
  assert.deepEqual(d.asked, [], 'a script must never be prompted');
  assert.equal(probed, false, 'a script run must not SSH to probe Docker or addresses');
  assert.deepEqual(
    [o.installDocker, o.address, o.ingress],
    [undefined, undefined, undefined],
    'the choices stay as the flags left them',
  );
});

test('flags answer the questions so a terminal asks only what is still open', async () => {
  const d = deps({ discover: () => assert.fail('an explicit --address needs no discovery') }, ['']);
  const o = opts({ installDocker: true, address: '10.0.0.7', ingress: true, yes: true });
  await quiet(() => planNodeAdd('root@app1', 'app1', o, d));
  assert.deepEqual(d.asked, [], 'every choice was given by a flag and -y skips the confirmation');
});

test('a terminal offers Docker, a private address first, ingress and a final confirmation', async () => {
  const d = deps(
    {
      hasDocker: () => false,
      discover: () => [
        { interface: 'eth1', address: '10.0.0.7', private: true },
        { interface: 'eth0', address: '203.0.113.7', private: false },
      ],
    },
    ['y', '', 'y', ''],
  );
  const o = opts();
  await quiet(() => planNodeAdd('root@app1', 'app1', o, d));
  assert.equal(o.installDocker, true, 'accepting the offer installs Docker');
  assert.equal(o.address, '10.0.0.7', 'the empty answer takes the private address');
  assert.equal(o.ingress, true, 'accepting the ingress question enables ingress');
  assert.equal(d.asked.length, 4, 'Docker, address, ingress and confirmation are each asked once');
});

test('a public-only host defaults to leaving the address unset', async () => {
  const d = deps({
    discover: () => [{ interface: 'eth0', address: '203.0.113.7', private: false }],
  });
  const o = opts({ ingress: false, yes: true });
  await quiet(() => planNodeAdd('root@app1', 'app1', o, d));
  assert.equal(o.address, undefined, 'a public address is never the default');
});

test('declining the final confirmation cancels before anything changes', async () => {
  const d = deps({}, ['n']);
  await assert.rejects(
    quiet(() => planNodeAdd('root@app1', 'app1', opts({ ingress: false, address: '10.0.0.7' }), d)),
    /cancelled; nothing was changed/,
    'saying no stops node add with a clear message',
  );
});

test('node add asks the host for its installed key, replace and repair ask for a new one', () => {
  assert.equal(
    agentIdentityArgs('create', 'app1'),
    "identity --current 'app1'",
    're-running node add must reuse an enrolled agent key so control sees an idempotent retry',
  );
  assert.equal(
    agentIdentityArgs('replace', 'app1'),
    'identity',
    'node replace and node repair must rotate the key, so they never ask for the installed one',
  );
});
