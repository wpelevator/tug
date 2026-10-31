// WireGuard mesh: overlay IP allocation and key handling (control), config rendering, peer diffing
// and the idempotent `wg0` reconcile (agent). All shell-outs go through an injectable HostRunner.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, errMessage } from './util.ts';
import type { NetworkConfig, WgPeer } from './protocol.ts';
import type { HostRunner } from './runners.ts';

/** Default mesh CIDR. Chosen to avoid the integration subnet 10.89.240.0/24, Docker's 172.16/12 and common home/VPN ranges. */
export const DEFAULT_MESH_CIDR = '10.210.0.0/16';
export const DEFAULT_WG_PORT = 51820;
export const WG_INTERFACE = 'wg0';
export const WG_KEEPALIVE = 25;
/** Below the usual 1500 path MTU minus WireGuard's 60 byte overhead (80 with IPv6 endpoints). */
const WG_MTU = 1420;

// ---- Keys --------------------------------------------------------------------------------------

export const WG_KEY_RE = /^[A-Za-z0-9+/]{43}=$/;
export const isWgKey = (value: unknown): value is string =>
  typeof value === 'string' && WG_KEY_RE.test(value);

const PKCS8_X25519_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

/** Public key for a base64 private key (X25519, as `wg pubkey` computes it). */
export function publicKeyFromPrivate(privateKey: string): string {
  const key = crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_X25519_PREFIX, Buffer.from(privateKey, 'base64')]),
    format: 'der',
    type: 'pkcs8',
  });
  const jwk = crypto.createPublicKey(key).export({ format: 'jwk' });
  return Buffer.from(jwk.x!, 'base64url').toString('base64');
}

export function generateWgKeyPair(): { privateKey: string; publicKey: string } {
  const jwk = crypto.generateKeyPairSync('x25519').privateKey.export({ format: 'jwk' });
  const privateKey = Buffer.from(jwk.d!, 'base64url').toString('base64');
  return { privateKey, publicKey: Buffer.from(jwk.x!, 'base64url').toString('base64') };
}

const wgDir = (stateDir: string) => path.join(stateDir, 'wireguard');

/** Loads the node's keypair from the state dir, generating it on first use. The private key never leaves this directory. */
export async function ensureWgKeys(
  stateDir: string,
): Promise<{ privateKey: string; publicKey: string }> {
  const file = path.join(wgDir(stateDir), 'private.key');
  try {
    const privateKey = (await fs.readFile(file, 'utf8')).trim();
    if (isWgKey(privateKey)) return { privateKey, publicKey: publicKeyFromPrivate(privateKey) };
  } catch {
    /* first boot */
  }
  return rotateWgKeys(stateDir);
}

export async function rotateWgKeys(
  stateDir: string,
): Promise<{ privateKey: string; publicKey: string }> {
  const pair = generateWgKeyPair();
  await ensureDir(wgDir(stateDir));
  await fs.writeFile(path.join(wgDir(stateDir), 'private.key'), `${pair.privateKey}\n`, {
    mode: 0o600,
  });
  return pair;
}

/** The public key control last accepted, so the agent only re-reports when it changed. */
export async function readReportedKey(stateDir: string): Promise<string | null> {
  try {
    return (await fs.readFile(path.join(wgDir(stateDir), 'reported.pub'), 'utf8')).trim() || null;
  } catch {
    return null;
  }
}
export async function writeReportedKey(stateDir: string, publicKey: string): Promise<void> {
  await ensureDir(wgDir(stateDir));
  await fs.writeFile(path.join(wgDir(stateDir), 'reported.pub'), `${publicKey}\n`);
}

// ---- Overlay addressing (control) --------------------------------------------------------------

export function ipToInt(ip: string): number {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255))
    throw new Error(`invalid IPv4 address ${ip}`);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}
export const intToIp = (n: number): string =>
  [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');

export function parseCidr(cidr: string): { base: number; prefix: number; size: number } {
  const [ip, bits, extra] = cidr.split('/');
  const prefix = Number(bits);
  if (
    extra !== undefined ||
    bits === undefined ||
    !Number.isInteger(prefix) ||
    prefix < 8 ||
    prefix > 29
  )
    throw new Error(`invalid mesh CIDR ${cidr} (IPv4, prefix /8 to /29)`);
  const size = 2 ** (32 - prefix);
  const base = (ipToInt(ip) & ~(size - 1)) >>> 0;
  return { base, prefix, size };
}

/** First free host address in the mesh CIDR (never the network or broadcast address). */
export function allocateOverlayIp(cidr: string, used: Iterable<string>): string {
  const { base, size } = parseCidr(cidr);
  const taken = new Set([...used].map(ipToInt));
  for (let offset = 1; offset < size - 1; offset++) {
    if (!taken.has(base + offset)) return intToIp(base + offset);
  }
  throw new Error(`mesh CIDR ${cidr} has no free overlay addresses`);
}

/** `host:port`, adding the WireGuard port when the public address has none. IPv6 literals are bracketed. */
export function wgEndpoint(
  publicAddress: string | null | undefined,
  port: number,
): string | undefined {
  const addr = publicAddress?.trim();
  if (!addr) return undefined;
  if (addr.startsWith('[')) return /\]:\d+$/.test(addr) ? addr : `${addr}:${port}`;
  if (addr.includes(':') && addr.split(':').length > 2) return `[${addr}]:${port}`;
  return /:\d+$/.test(addr) ? addr : `${addr}:${port}`;
}

// ---- Config rendering and diffing (agent) ------------------------------------------------------

/** `wg syncconf` input: interface key and port plus peers (no wg-quick-only keys such as Address). */
export function renderWgConfig(privateKey: string, listenPort: number, peers: WgPeer[]): string {
  const lines = ['[Interface]', `PrivateKey = ${privateKey}`, `ListenPort = ${listenPort}`];
  for (const peer of [...peers].sort((a, b) => a.publicKey.localeCompare(b.publicKey))) {
    lines.push(
      '',
      '[Peer]',
      `PublicKey = ${peer.publicKey}`,
      `AllowedIPs = ${[...peer.allowedIps].sort().join(', ')}`,
    );
    if (peer.endpoint) lines.push(`Endpoint = ${peer.endpoint}`);
    lines.push(`PersistentKeepalive = ${peer.persistentKeepalive}`);
  }
  return `${lines.join('\n')}\n`;
}

export interface AppliedPeer {
  publicKey: string;
  endpoint?: string;
  allowedIps: string[];
  keepalive: number;
}
export interface AppliedInterface {
  publicKey: string;
  listenPort: number;
  peers: AppliedPeer[];
}

/** Parses `wg show <iface> dump` (tab separated; first line is the interface, then one line per peer). */
export function parseWgDump(dump: string): AppliedInterface {
  const [header, ...rest] = dump.split('\n').filter(Boolean);
  const h = (header || '').split('\t');
  return {
    publicKey: h[1] || '',
    listenPort: Number(h[2]) || 0,
    peers: rest.map((line) => {
      const f = line.split('\t');
      return {
        publicKey: f[0],
        endpoint: f[2] && f[2] !== '(none)' ? f[2] : undefined,
        allowedIps: f[3] && f[3] !== '(none)' ? f[3].split(',') : [],
        keepalive: f[7] && f[7] !== 'off' ? Number(f[7]) : 0,
      };
    }),
  };
}

export interface PeerDiff {
  add: string[];
  remove: string[];
  update: string[];
}

/** Compares desired peers with what `wg` reports. A desired endpoint is authoritative; a peer without one keeps whatever it roamed to. */
export function diffPeers(desired: WgPeer[], applied: AppliedPeer[]): PeerDiff {
  const have = new Map(applied.map((p) => [p.publicKey, p]));
  const want = new Map(desired.map((p) => [p.publicKey, p]));
  const sameSet = (a: string[], b: string[]) =>
    a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);
  const diff: PeerDiff = { add: [], remove: [], update: [] };
  for (const [key, peer] of want) {
    const cur = have.get(key);
    if (!cur) diff.add.push(key);
    else if (
      !sameSet(peer.allowedIps, cur.allowedIps) ||
      peer.persistentKeepalive !== cur.keepalive ||
      (peer.endpoint && peer.endpoint !== cur.endpoint)
    )
      diff.update.push(key);
  }
  for (const key of have.keys()) if (!want.has(key)) diff.remove.push(key);
  return diff;
}

export interface MeshResult {
  created: boolean;
  synced: boolean;
  diff: PeerDiff;
}

/**
 * Brings `wg0` in line with the control-provided network block without tearing it down: creates the
 * link and address only when missing, and calls `wg syncconf` only when keys, port or peers differ.
 */
export async function reconcileMesh(
  host: HostRunner,
  stateDir: string,
  network: NetworkConfig,
): Promise<MeshResult> {
  const { privateKey, publicKey } = await ensureWgKeys(stateDir);
  const iface = network.interface;
  const prefix = parseCidr(network.cidr).prefix;
  let created = false;
  try {
    await host('ip', ['link', 'show', iface]);
  } catch {
    await host('ip', ['link', 'add', iface, 'type', 'wireguard']);
    created = true;
  }
  await host('ip', ['address', 'replace', `${network.overlayIp}/${prefix}`, 'dev', iface]);
  if (created) await host('ip', ['link', 'set', 'mtu', String(WG_MTU), 'up', 'dev', iface]);

  let applied: AppliedInterface = { publicKey: '', listenPort: 0, peers: [] };
  if (!created) {
    try {
      applied = parseWgDump((await host('wg', ['show', iface, 'dump'])).out);
    } catch (e) {
      throw new Error(`wg show ${iface} failed: ${errMessage(e)}`, { cause: e });
    }
  }
  const diff = diffPeers(network.peers, applied.peers);
  const synced =
    created ||
    applied.publicKey !== publicKey ||
    applied.listenPort !== network.listenPort ||
    diff.add.length + diff.remove.length + diff.update.length > 0;
  if (synced) {
    const file = path.join(wgDir(stateDir), `${iface}.conf`);
    await ensureDir(wgDir(stateDir));
    await fs.writeFile(file, renderWgConfig(privateKey, network.listenPort, network.peers), {
      mode: 0o600,
    });
    await host('wg', ['syncconf', iface, file]);
  }
  return { created, synced, diff };
}
