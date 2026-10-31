import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_MESH_CIDR, allocateOverlayIp, diffPeers, ensureWgKeys, generateWgKeyPair, isWgKey, parseCidr, parseWgDump,
  publicKeyFromPrivate, reconcileMesh, renderWgConfig, rotateWgKeys, wgEndpoint
} from './mesh.ts';
import type { NetworkConfig, WgPeer } from './protocol.ts';
import type { HostRunner } from './runners.ts';

const peer = (n: number, extra: Partial<WgPeer> = {}): WgPeer => ({
  node: `n${n}`, publicKey: Buffer.alloc(32, n).toString('base64'), endpoint: `192.0.2.${n}:51820`, allowedIps: [`10.210.0.${n}/32`], persistentKeepalive: 25, ...extra
});

/** Fake `wg`/`ip`: records calls; `link` says whether wg0 exists, `dump` is what `wg show wg0 dump` prints. */
function fakeHost(state: { link: boolean; dump: string }) {
  const calls: string[] = [];
  const host: HostRunner = async (cmd, args) => {
    const line = `${cmd} ${args.join(' ')}`;
    calls.push(line);
    if (line === 'ip link show wg0' && !state.link) throw new Error('Device "wg0" does not exist');
    if (line === 'ip link add wg0 type wireguard') state.link = true;
    return { out: line === 'wg show wg0 dump' ? state.dump : '', err: '' };
  };
  return { host, calls };
}

test('public key derivation matches the RFC 7748 X25519 vector that `wg pubkey` implements', () => {
  const priv = Buffer.from('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a', 'hex').toString('base64');
  const pub = Buffer.from('8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a', 'hex').toString('base64');
  assert.equal(publicKeyFromPrivate(priv), pub, 'derived public key equals the RFC 7748 vector');
});

test('generated keypairs are valid WireGuard keys and the public key derives from the private key', () => {
  const pair = generateWgKeyPair();
  assert.ok(isWgKey(pair.privateKey) && isWgKey(pair.publicKey), 'both keys are 32-byte base64');
  assert.equal(publicKeyFromPrivate(pair.privateKey), pair.publicKey, 'public key derives from the private key');
  assert.notEqual(generateWgKeyPair().privateKey, pair.privateKey, 'each keypair is fresh');
  assert.equal(isWgKey('not-a-key'), false, 'garbage is rejected');
});

test('private key stays in the state dir with mode 0600 and rotation replaces it', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-wgkeys-'));
  const first = await ensureWgKeys(dir);
  assert.deepEqual(await ensureWgKeys(dir), first, 'keys are stable across restarts');
  const file = path.join(dir, 'wireguard', 'private.key');
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600, 'private key file is owner-only');
  const rotated = await rotateWgKeys(dir);
  assert.notEqual(rotated.publicKey, first.publicKey, 'rotation yields a new keypair');
  assert.deepEqual(await ensureWgKeys(dir), rotated, 'rotated key is what is persisted');
});

test('default mesh CIDR does not overlap the integration subnet 10.89.240.0/24', () => {
  const mesh = parseCidr(DEFAULT_MESH_CIDR);
  const it = parseCidr('10.89.240.0/24');
  assert.ok(mesh.base + mesh.size <= it.base || it.base + it.size <= mesh.base, 'ranges are disjoint');
});

test('allocateOverlayIp hands out the first free host address and never network/broadcast', () => {
  assert.equal(allocateOverlayIp('10.210.0.0/16', []), '10.210.0.1');
  assert.equal(allocateOverlayIp('10.210.0.0/16', ['10.210.0.1', '10.210.0.2']), '10.210.0.3');
  assert.equal(allocateOverlayIp('10.210.0.0/16', ['10.210.0.2']), '10.210.0.1', 'freed addresses are reused');
  assert.equal(allocateOverlayIp('10.0.0.0/29', ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4', '10.0.0.5']), '10.0.0.6');
  assert.throws(() => allocateOverlayIp('10.0.0.0/29', ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4', '10.0.0.5', '10.0.0.6']), /no free overlay/, 'exhausted CIDR is an error');
  assert.throws(() => parseCidr('10.0.0.0/31'), /invalid mesh CIDR/, 'tiny CIDRs are rejected');
  assert.throws(() => parseCidr('nonsense'), /invalid/, 'non-CIDR input is rejected');
});

test('wgEndpoint appends the WireGuard port only when the address has none', () => {
  assert.equal(wgEndpoint('203.0.113.7', 51820), '203.0.113.7:51820');
  assert.equal(wgEndpoint('vpn.example.com:51999', 51820), 'vpn.example.com:51999');
  assert.equal(wgEndpoint('2001:db8::1', 51820), '[2001:db8::1]:51820');
  assert.equal(wgEndpoint(null, 51820), undefined, 'nodes without a public address have no endpoint');
});

test('renderWgConfig is deterministic and omits Endpoint for NAT-ed peers', () => {
  const natted = peer(2, { endpoint: undefined });
  const a = renderWgConfig('PRIV', 51820, [peer(3), natted]);
  assert.equal(a, renderWgConfig('PRIV', 51820, [natted, peer(3)]), 'peer order does not change the output');
  assert.match(a, /\[Interface\]\nPrivateKey = PRIV\nListenPort = 51820/);
  assert.match(a, /AllowedIPs = 10\.210\.0\.3\/32\nEndpoint = 192\.0\.2\.3:51820\nPersistentKeepalive = 25/, 'reachable peers carry endpoint and keepalive');
  const natBlock = a.split('[Peer]').find(b => b.includes(natted.publicKey))!;
  assert.doesNotMatch(natBlock, /Endpoint/, 'peer behind NAT has no endpoint');
  assert.match(natBlock, /PersistentKeepalive = 25/, 'peer behind NAT still gets keepalive');
});

test('parseWgDump reads interface and peers', () => {
  const dump = ['PRIV\tPUB\t51820\toff', 'K1\t(none)\t192.0.2.1:51820\t10.210.0.1/32\t0\t0\t0\t25', 'K2\t(none)\t(none)\t10.210.0.2/32,10.210.0.9/32\t0\t0\t0\toff', ''].join('\n');
  assert.deepEqual(parseWgDump(dump), {
    publicKey: 'PUB', listenPort: 51820,
    peers: [
      { publicKey: 'K1', endpoint: '192.0.2.1:51820', allowedIps: ['10.210.0.1/32'], keepalive: 25 },
      { publicKey: 'K2', endpoint: undefined, allowedIps: ['10.210.0.2/32', '10.210.0.9/32'], keepalive: 0 }
    ]
  });
});

test('diffPeers reports added, removed and changed peers and ignores roamed endpoints', () => {
  const applied = [
    { publicKey: peer(1).publicKey, endpoint: '192.0.2.1:51820', allowedIps: ['10.210.0.1/32'], keepalive: 25 },
    { publicKey: peer(2).publicKey, endpoint: '198.51.100.9:4000', allowedIps: ['10.210.0.2/32'], keepalive: 25 },
    { publicKey: peer(4).publicKey, endpoint: undefined, allowedIps: ['10.210.0.4/32'], keepalive: 25 }
  ];
  const desired = [peer(1), peer(2, { endpoint: undefined }), peer(3)];
  assert.deepEqual(diffPeers(desired, applied), { add: [peer(3).publicKey], remove: [peer(4).publicKey], update: [] }, 'roamed endpoint of an endpoint-less peer is not drift');
  assert.deepEqual(diffPeers([peer(1, { endpoint: '192.0.2.99:51820' })], [applied[0]]).update, [peer(1).publicKey], 'a changed configured endpoint is drift');
  assert.deepEqual(diffPeers([peer(1, { allowedIps: ['10.210.0.1/32', '10.210.0.8/32'] })], [applied[0]]).update, [peer(1).publicKey], 'changed allowed IPs are drift');
});

test('reconcileMesh creates wg0 once, then only syncs when peers change', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-mesh-'));
  const { publicKey } = await ensureWgKeys(dir);
  const network: NetworkConfig = { interface: 'wg0', overlayIp: '10.210.0.5', cidr: '10.210.0.0/16', listenPort: 51820, peers: [peer(1)] };
  const state = { link: false, dump: '' };
  const { host, calls } = fakeHost(state);

  let result = await reconcileMesh(host, dir, network);
  assert.equal(result.created, true, 'wg0 is created when missing');
  assert.deepEqual(calls, [
    'ip link show wg0', 'ip link add wg0 type wireguard', 'ip address replace 10.210.0.5/16 dev wg0',
    'ip link set mtu 1420 up dev wg0', `wg syncconf wg0 ${path.join(dir, 'wireguard', 'wg0.conf')}`
  ], 'link, address, up, then syncconf in order');
  const conf = await fs.readFile(path.join(dir, 'wireguard', 'wg0.conf'), 'utf8');
  assert.match(conf, new RegExp(`PublicKey = ${peer(1).publicKey.replace(/[+/]/g, '\\$&')}`), 'peer written to the config');
  assert.equal((await fs.stat(path.join(dir, 'wireguard', 'wg0.conf'))).mode & 0o777, 0o600, 'config holds the private key so it is owner-only');

  // steady state: wg reports exactly the desired peer
  state.dump = `x\t${publicKey}\t51820\toff\n${peer(1).publicKey}\t(none)\t192.0.2.1:51820\t10.210.0.1/32\t0\t0\t0\t25\n`;
  calls.length = 0;
  result = await reconcileMesh(host, dir, network);
  assert.equal(result.synced, false, 'no syncconf when nothing changed');
  assert.ok(!calls.some(c => c.startsWith('wg syncconf')) && !calls.some(c => c.includes('link add')), 'no teardown or rewrite on a quiet tick');

  // a new peer appears in the fleet
  calls.length = 0;
  result = await reconcileMesh(host, dir, { ...network, peers: [peer(1), peer(2)] });
  assert.deepEqual(result.diff.add, [peer(2).publicKey], 'new peer detected');
  assert.ok(calls.some(c => c.startsWith('wg syncconf wg0')), 'syncconf applies the new peer');

  // a peer is removed
  calls.length = 0;
  result = await reconcileMesh(host, dir, { ...network, peers: [] });
  assert.deepEqual(result.diff.remove, [peer(1).publicKey], 'removed peer detected');
});

test('reconcileMesh resyncs after the local key rotates', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-mesh-rot-'));
  const old = await ensureWgKeys(dir);
  const network: NetworkConfig = { interface: 'wg0', overlayIp: '10.210.0.5', cidr: '10.210.0.0/16', listenPort: 51820, peers: [] };
  const state = { link: true, dump: `x\t${old.publicKey}\t51820\toff\n` };
  const { host, calls } = fakeHost(state);
  await rotateWgKeys(dir);
  const result = await reconcileMesh(host, dir, network);
  assert.equal(result.synced, true, 'interface public key no longer matches, so config is re-applied');
  assert.ok(calls.some(c => c.startsWith('wg syncconf')), 'syncconf runs with the new private key');
});
