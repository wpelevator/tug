import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import type { AddressInfo } from 'node:net';
import { createTlsMonitor, parseIssuanceErrors, probeTls, tlsHosts } from './ingress-tls.ts';
import type { TlsProbe } from './ingress-tls.ts';
import type { IngressRoute } from './protocol.ts';
import { FakeDocker } from '../tests/fake-docker.ts';

const route = (over: Partial<IngressRoute>): IngressRoute => ({
  project: 'p',
  service: 'web',
  host: 'a.example.com',
  tls: 'auto',
  upstreams: [],
  ...over,
});

test('tlsHosts lists names Caddy issues itself and skips wildcards, custom certificates and tls off', () => {
  assert.deepEqual(
    tlsHosts([
      route({ host: 'A.example.com', hosts: ['b.example.com'], aliases: ['m.example.org'] }),
      route({ host: 'c.example.com', tls: 'custom', aliases: ['d.example.com'] }),
      route({ host: 'e.example.com', tls: 'off', aliases: ['ignored.example.com'] }),
      route({ host: '*.net.example.com', aliases: ['*.zone.example.org', 'x.example.org'] }),
    ]),
    ['a.example.com', 'b.example.com', 'd.example.com', 'm.example.org', 'x.example.org'],
    'auto names and mapped domains are probed; wildcards would trigger on-demand issuance and custom or off names are not tug-issued',
  );
});

test('parseIssuanceErrors keeps the latest tls error per host and ignores other lines', () => {
  const lines = [
    '{"level":"error","logger":"tls.obtain","msg":"could not get certificate","identifier":"a.example.com","error":"first"}',
    'not json',
    '{"level":"info","logger":"tls.obtain","msg":"obtained","identifier":"a.example.com"}',
    '{"level":"error","logger":"http.log.error","msg":"x","identifier":"a.example.com","error":"other logger"}',
    '{"level":"error","logger":"tls.issuance.acme","msg":"challenge failed","identifier":"A.example.com","error":"connection refused"}',
    '{"level":"warn","logger":"tls.obtain","msg":"will retry","domain":"b.example.com"}',
  ].join('\n');
  assert.deepEqual(
    [...parseIssuanceErrors(lines)],
    [
      ['a.example.com', 'connection refused'],
      ['b.example.com', 'will retry'],
    ],
    'the last warn or error line from a tls logger names each host and explains its state',
  );
});

test('the monitor reports pending, then failed with the logged reason, then issued, with stable since', async () => {
  let time = Date.parse('2026-11-15T10:00:00Z');
  let issued = false;
  const probes: string[] = [];
  const probe: TlsProbe = async (host) => {
    probes.push(host);
    return issued
      ? { ok: true, notAfter: '2027-02-01T00:00:00.000Z', issuer: "Let's Encrypt" }
      : { ok: false, error: 'tlsv1 alert internal error' };
  };
  let log = '';
  const monitor = createTlsMonitor({ probe, now: () => time, readLog: async () => log });
  const docker = new FakeDocker();
  const routes = [route({})];

  let [cert] = await monitor.check(routes, docker);
  assert.equal(cert.state, 'pending', 'a failed handshake with no logged reason is pending');
  assert.equal(cert.error, 'tlsv1 alert internal error', 'the handshake error explains the state');
  const first = cert.since;

  time += 5_000;
  await monitor.check(routes, docker);
  assert.equal(probes.length, 1, 'a not-yet-issued host is not re-probed on every poll');

  time += 60_000;
  log =
    '{"level":"error","logger":"tls.obtain","msg":"could not get certificate","identifier":"a.example.com","error":"connection refused on port 80"}';
  [cert] = await monitor.check(routes, docker);
  assert.equal(probes.length, 2, 'it is re-probed after the retry interval');
  assert.equal(cert.state, 'failed', 'a logged issuance error turns pending into failed');
  assert.equal(
    cert.error,
    'connection refused on port 80',
    'the log reason replaces the handshake error',
  );
  assert.notEqual(cert.since, first, 'since moves when the state changes');

  const failedSince = cert.since;
  time += 60_000;
  [cert] = await monitor.check(routes, docker);
  assert.equal(cert.since, failedSince, 'since is stable while the state is unchanged');

  issued = true;
  time += 60_000;
  [cert] = await monitor.check(routes, docker);
  assert.equal(cert.state, 'issued', 'a successful handshake is issued');
  assert.equal(cert.notAfter, '2027-02-01T00:00:00.000Z', 'the expiry is reported');
  assert.equal(cert.error, undefined, 'an issued host carries no error');

  time += 5 * 60_000;
  await monitor.check(routes, docker);
  assert.equal(probes.length, 4, 'an issued host is only re-probed hourly');
  assert.deepEqual(await monitor.check([], docker), [], 'a host that left the config is dropped');
});

test('the monitor survives a failing log read', async () => {
  const monitor = createTlsMonitor({
    probe: async () => ({ ok: false, error: 'refused' }),
    readLog: async () => {
      throw new Error('no container');
    },
  });
  const [cert] = await monitor.check([route({})], new FakeDocker());
  assert.equal(cert.state, 'pending', 'an unreadable log leaves the host pending, not broken');
});

test('probeTls separates a covering certificate from a handshake failure and a wrong name', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tug-tls-'));
  const key = path.join(dir, 'k.pem');
  const crt = path.join(dir, 'c.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '2',
      '-subj',
      '/CN=a.test',
      '-addext',
      'subjectAltName=DNS:a.test,DNS:*.w.test',
      '-keyout',
      key,
      '-out',
      crt,
    ],
    { stdio: 'ignore' },
  );
  const context = () =>
    tls.createSecureContext({ key: fs.readFileSync(key), cert: fs.readFileSync(crt) });
  const server = tls.createServer(
    {
      SNICallback: (name, cb) =>
        name === 'down.test' ? cb(new Error('no certificate for this name')) : cb(null, context()),
    },
    (s) => s.end(),
  );
  server.on('tlsClientError', () => {});
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    assert.equal(
      (await probeTls('a.test', { port })).ok,
      true,
      'a certificate whose SAN covers the host is issued',
    );
    assert.equal(
      (await probeTls('x.w.test', { port })).ok,
      true,
      'a wildcard SAN covers one label',
    );
    assert.deepEqual(
      await probeTls('other.test', { port }),
      { ok: false, error: 'the served certificate does not cover the host' },
      'a certificate for another name is not issued for this host',
    );
    assert.equal(
      (await probeTls('down.test', { port })).ok,
      false,
      'a handshake the server aborts is not issued',
    );
    assert.deepEqual(
      await probeTls('a.test', { port, now: () => Date.now() + 10 * 86400_000 }),
      { ok: false, error: 'the certificate has expired' },
      'an expired certificate is not issued',
    );
  } finally {
    server.close();
  }
});
