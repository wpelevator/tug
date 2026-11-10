import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ROLLBACK_TAG,
  alreadyRunning,
  assertNotAheadOfControl,
  inspectAgentScript,
  inspectControlScript,
  parseAgentInspect,
  parseControlInspect,
  rollbackImageScript,
  rollbackTagScript,
} from './upgrade.ts';

const controlInspect = (over: Record<string, unknown> = {}) =>
  JSON.stringify([
    {
      Image: 'sha256:abc123',
      Config: {
        Image: 'ghcr.io/wpelevator/tug:1.2.0',
        Env: [
          'PORT=8443',
          'TUG_DATA_DIR=/data',
          'TUG_CONTROL_URL=https://control.example.com:9443',
          'TUG_EXTRA_SANS=a.example.com, 10.0.0.5,',
        ],
      },
      HostConfig: { PortBindings: { '8443/tcp': [{ HostIp: '', HostPort: '9443' }] } },
      ...over,
    },
  ]);

test('control inspect yields the port, URL and extra names the container was installed with', () => {
  assert.deepEqual(
    parseControlInspect(controlInspect()),
    {
      image: 'ghcr.io/wpelevator/tug:1.2.0',
      imageId: 'sha256:abc123',
      bindings: [{ port: 9443 }],
      controlUrl: 'https://control.example.com:9443',
      extraSans: ['a.example.com', '10.0.0.5'],
    },
    'an upgrade should carry over the published port, URL and extra SANs, not reset them to defaults',
  );
});

test('control inspect without extra names yields an empty list', () => {
  const json = JSON.parse(controlInspect());
  json[0].Config.Env = json[0].Config.Env.filter((e: string) => !e.startsWith('TUG_EXTRA_SANS'));
  assert.deepEqual(
    parseControlInspect(JSON.stringify(json)).extraSans,
    [],
    'no names should be none',
  );
});

test('control inspect refuses a container that setup did not create', () => {
  assert.throws(
    () =>
      parseControlInspect(
        controlInspect({
          HostConfig: {
            NetworkMode: 'host',
            PortBindings: { '8443/tcp': [{ HostIp: '127.0.0.1', HostPort: '9443' }] },
          },
        }),
      ),
    /unsupported network mode/,
    'a configured port ignored by host networking must not turn into a published port',
  );
  assert.throws(
    () => parseControlInspect(controlInspect({ HostConfig: { PortBindings: {} } })),
    /publishes no port 8443/,
    'a container without the 8443 binding should be refused, not upgraded with a guessed port',
  );
  assert.throws(
    () => parseControlInspect(controlInspect({ Config: { Image: 'x', Env: [] } })),
    /no TUG_CONTROL_URL/,
    'a container without the advertised URL should be refused',
  );
  assert.throws(
    () => parseControlInspect('[]'),
    /no control container/,
    'an empty inspect is an error',
  );
  assert.throws(() => parseControlInspect('not json'), /could not read/, 'garbage is an error');
});

test('agent inspect yields the image and the connect-only URL when there is one', () => {
  const agent = (env: string[]) =>
    JSON.stringify([{ Config: { Image: 'ghcr.io/wpelevator/tug:1.2.0', Env: env } }]);
  assert.deepEqual(
    parseAgentInspect(agent(['TUG_CONTROL_URL=https://10.0.0.1:8443'])),
    { image: 'ghcr.io/wpelevator/tug:1.2.0', controlUrl: 'https://10.0.0.1:8443' },
    'an agent dialing a private address should keep it across the upgrade',
  );
  assert.equal(
    parseAgentInspect(agent(['PATH=/usr/bin'])).controlUrl,
    undefined,
    'an agent without a connect URL should not get one',
  );
});

test('the remote scripts address the right containers and the rollback tag', () => {
  assert.match(
    inspectControlScript,
    /docker inspect 'tug-control-control-1'/,
    'control is inspected by its name',
  );
  assert.match(
    inspectAgentScript,
    /docker inspect 'tug-agent'/,
    'the agent is inspected by its name',
  );
  assert.equal(
    rollbackTagScript('sha256:abc'),
    `docker tag 'sha256:abc' '${ROLLBACK_TAG}'`,
    'the old image ID should be tagged as the rollback image',
  );
  assert.match(rollbackImageScript, /exit 1/, 'a missing rollback image should fail the step');
});

test('an upgrade is skipped only when the image matches and nothing forces it', () => {
  assert.equal(alreadyRunning('a:1', 'a:1', false), true, 'same image is already current');
  assert.equal(alreadyRunning('a:1', 'a:1', true), false, '--force recreates');
  assert.equal(alreadyRunning('a:1', 'a:2', false), false, 'another image is an upgrade');
});

test('agents may not be upgraded past the control', () => {
  assert.throws(
    () => assertNotAheadOfControl('2.0.0', '1.4.0'),
    /upgrade it first with `tug control upgrade --to 2.0.0`/,
    'a newer major than the control should be refused with the remedy',
  );
  assert.throws(
    () => assertNotAheadOfControl('0.15.0', '0.14.2'),
    /older than the 0\.15\.0/,
    'before 1.0 a newer minor is a newer compatibility key',
  );
  assert.doesNotThrow(
    () => assertNotAheadOfControl('1.5.0', '1.4.0'),
    'a newer minor of the same major is served',
  );
  assert.doesNotThrow(() => assertNotAheadOfControl('1.3.0', '1.4.0'), 'an older agent is fine');
  assert.doesNotThrow(
    () => assertNotAheadOfControl('latest', '1.4.0'),
    'an unparseable tag is not judged here',
  );
});

test('a wildcard binding is replayed as typed, not as the explicit IPv4 and IPv6 mappings the daemon published', () => {
  const published = {
    NetworkSettings: {
      Ports: {
        '8443/tcp': [
          { HostIp: '0.0.0.0', HostPort: '9443' },
          { HostIp: '::', HostPort: '9443' },
        ],
      },
    },
  };
  assert.deepEqual(
    parseControlInspect(controlInspect(published)).bindings,
    [{ port: 9443 }],
    'replaying `-p [::]:9443:8443` would fail on a host without IPv6 where the wildcard still works',
  );
});

test('every requested binding is kept, and a container with extra published ports or host networking is refused', () => {
  assert.deepEqual(
    parseControlInspect(
      controlInspect({
        HostConfig: {
          PortBindings: {
            '8443/tcp': [
              { HostIp: '127.0.0.1', HostPort: '9443' },
              { HostIp: '::1', HostPort: '9443' },
            ],
          },
        },
      }),
    ).bindings,
    [
      { hostIp: '127.0.0.1', port: 9443 },
      { hostIp: '::1', port: 9443 },
    ],
    'a loopback-only install stays loopback-only on both address families',
  );
  assert.throws(
    () =>
      parseControlInspect(
        controlInspect({
          HostConfig: {
            PortBindings: {
              '8443/tcp': [{ HostPort: '9443' }],
              '9000/tcp': [{ HostPort: '9000' }],
            },
          },
        }),
      ),
    /additional container ports/,
    'a port the upgrade would silently unpublish should stop it',
  );
});

test('an agent keeps its rollout port range across an upgrade, and a malformed one is refused', () => {
  const agent = (env: string[]) =>
    JSON.stringify([{ Config: { Image: 'ghcr.io/wpelevator/tug:1.2.0', Env: env } }]);
  assert.equal(
    parseAgentInspect(agent(['TUG_ROLLOUT_PORTS=22000-22999'])).rolloutPorts,
    '22000-22999',
    'a custom range should not reset to the default',
  );
  assert.equal(parseAgentInspect(agent([])).rolloutPorts, undefined, 'no range stays unset');
  assert.throws(
    () => parseAgentInspect(agent(['TUG_ROLLOUT_PORTS=1;rm -rf /'])),
    /is not LOW-HIGH/,
    'a value that is not a range never reaches the install shell command',
  );
});
