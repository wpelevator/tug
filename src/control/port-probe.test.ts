import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { describeClosedPort, probeTcpPort } from './port-probe.ts';

test('probeTcpPort reports open for a listener and refused for a closed port', async () => {
  const server = net.createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  try {
    assert.equal(
      await probeTcpPort('127.0.0.1', port, 1000),
      'open',
      'a listening port should be open',
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  assert.equal(
    await probeTcpPort('127.0.0.1', port, 1000),
    'refused',
    'a port nothing listens on should be refused',
  );
});

test('describeClosedPort names the port, the likely cause and the remedy, and says tug never changes the firewall', () => {
  for (const state of ['timeout', 'refused', 'unreachable'] as const) {
    const text = describeClosedPort('n1', '10.0.0.4', 443, state);
    assert.match(
      text,
      /port 443 on ingress node n1 \(10\.0\.0\.4\)/,
      `${state}: names the port and node`,
    );
    assert.match(text, /ufw allow 80,443\/tcp/, `${state}: gives the ufw remedy`);
    assert.match(text, /firewall-cmd/, `${state}: gives the firewalld remedy`);
    assert.match(
      text,
      /tug never changes firewalls/,
      `${state}: states tug leaves the firewall alone`,
    );
  }
  assert.match(
    describeClosedPort('n1', 'a', 80, 'timeout'),
    /ufw drops packets/,
    'a timeout points at a dropping firewall',
  );
  assert.match(
    describeClosedPort('n1', 'a', 80, 'refused'),
    /tug ingress logs n1/,
    'a refusal also points at Caddy not running',
  );
});
