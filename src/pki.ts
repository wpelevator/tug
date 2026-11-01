import 'reflect-metadata';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import * as x509 from '@peculiar/x509';

type CryptoKey = crypto.webcrypto.CryptoKey;
type CryptoKeyPair = crypto.webcrypto.CryptoKeyPair;
type EcKeyAlgorithm = { name: string; namedCurve: string };
x509.cryptoProvider.set(crypto.webcrypto as never);

const SIGNING = { name: 'ECDSA', hash: 'SHA-256' } as const;
const KEY_ALG = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const MINUTE = 60_000;
const DAY = 86_400_000;
/** `notBefore` is back-dated so a host whose clock runs slightly slow can still install and renew. */
export const BACKDATE_MS = 5 * MINUTE;
export const CA_LIFETIME_MS = 3650 * DAY;
export const SERVER_LIFETIME_MS = 90 * DAY;
export const NODE_LIFETIME_MS = 90 * DAY;
export const OPERATOR_MAX_LIFETIME_MS = 365 * DAY;
export const ENROLL_DEFAULT_TTL_MS = 60 * MINUTE;

export type IdentityClass = 'node' | 'operator' | 'enroll';
const IDENTITY_URI = /^tug:(node|operator|enroll):([A-Za-z0-9_.-]+)$/;
export const identityUri = (klass: IdentityClass, id: string): string => `tug:${klass}:${id}`;
export function parseIdentityUri(uri: string): { klass: IdentityClass; id: string } | null {
  const m = IDENTITY_URI.exec(uri);
  return m ? { klass: m[1] as IdentityClass, id: m[2] } : null;
}

/** Everything a client needs to reach control: the public URL, the CA to trust and its own certificate and key. */
export interface Credential {
  v: 1;
  url: string;
  ca: string;
  cert: string;
  key: string;
}

export const encodeCredential = (credential: Credential): string =>
  Buffer.from(JSON.stringify(credential)).toString('base64url');

/** Validates the shape and the HTTPS origin of an untrusted credential document, and that the key matches the certificate. */
export function parseCredential(value: unknown): Credential {
  if (!value || typeof value !== 'object') throw new Error('credential must be a JSON object');
  const c = value as Record<string, unknown>;
  if (c.v !== 1) throw new Error('credential version must be 1');
  for (const field of ['url', 'ca', 'cert', 'key'] as const)
    if (typeof c[field] !== 'string' || !c[field])
      throw new Error(`credential is missing ${field}`);
  const url = new URL(c.url as string);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new Error('credential url must be a credential-free https origin');
  if (url.pathname !== '/') throw new Error('credential url must be an origin without a path');
  const credential = c as unknown as Credential;
  assertKeyMatchesCertificate(credential.cert, credential.key);
  return credential;
}

export function decodeCredential(text: string): Credential {
  const trimmed = text.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      trimmed.startsWith('{') ? trimmed : Buffer.from(trimmed, 'base64url').toString('utf8'),
    );
  } catch (e) {
    throw new Error('credential is not valid JSON or base64url-encoded JSON', { cause: e });
  }
  return parseCredential(parsed);
}

export function assertKeyMatchesCertificate(certPem: string, keyPem: string): void {
  const cert = new crypto.X509Certificate(certPem);
  const derived = crypto.createPublicKey(crypto.createPrivateKey(keyPem));
  if (!cert.checkPrivateKey(crypto.createPrivateKey(keyPem)) || !derived)
    throw new Error('certificate does not match the private key');
}

/** SHA-256 of the DER SubjectPublicKeyInfo: the identity a principal is authorized by. */
export const hashSpki = (spki: Uint8Array | Buffer): string =>
  crypto.createHash('sha256').update(spki).digest('hex');
export const certKeyHash = (certPem: string): string =>
  hashSpki(new crypto.X509Certificate(certPem).publicKey.export({ type: 'spki', format: 'der' }));

/** Durable write: temporary file in the same directory, flushed, renamed over the target, directory flushed. */
export interface PersistHooks {
  /** Called after the temporary file is flushed and before the rename. Tests throw here to simulate a crash. */
  afterFlush?: () => void;
  /** Called after the rename and before the directory flush. */
  afterRename?: () => void;
}
export async function writeFileDurable(
  file: string,
  content: string,
  mode = 0o600,
  hooks: PersistHooks = {},
): Promise<void> {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`,
  );
  const handle = await fs.open(tmp, 'w', mode);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    hooks.afterFlush?.();
    await fs.rename(tmp, file);
  } catch (e) {
    // A crash leaves the temporary file behind; a failed write must not.
    await fs.rm(tmp, { force: true });
    throw e;
  }
  hooks.afterRename?.();
  const dirHandle = await fs.open(dir, 'r').catch(() => null);
  if (dirHandle) {
    await dirHandle.sync().catch(() => {});
    await dirHandle.close();
  }
}

export interface KeyPair {
  privateKeyPem: string;
  publicKey: CryptoKey;
  privateKey: CryptoKey;
}

export async function generateKeyPair(): Promise<KeyPair> {
  const keys = (await crypto.webcrypto.subtle.generateKey(KEY_ALG, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const pkcs8 = Buffer.from(await crypto.webcrypto.subtle.exportKey('pkcs8', keys.privateKey));
  return {
    privateKeyPem: toPem(pkcs8, 'PRIVATE KEY'),
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
  };
}

export async function importPrivateKey(pem: string): Promise<CryptoKeyPair> {
  const privateKey = await crypto.webcrypto.subtle.importKey(
    'pkcs8',
    pemToDer(pem),
    KEY_ALG,
    true,
    ['sign'],
  );
  const jwk = await crypto.webcrypto.subtle.exportKey('jwk', privateKey);
  const publicKey = await crypto.webcrypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
    KEY_ALG,
    true,
    ['verify'],
  );
  return { privateKey, publicKey };
}

const toPem = (der: Buffer, label: string): string =>
  `-----BEGIN ${label}-----\n${der
    .toString('base64')
    .replace(/(.{64})/g, '$1\n')
    .trimEnd()}\n-----END ${label}-----\n`;
function pemToDer(pem: string): Buffer {
  return Buffer.from(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
}

/** A PEM CSR for the key; the requester's subject is irrelevant because control assigns identities. */
export async function createCsr(privateKeyPem: string): Promise<string> {
  const keys = await importPrivateKey(privateKeyPem);
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: 'CN=tug',
    keys,
    signingAlgorithm: SIGNING,
  });
  return csr.toString('pem');
}

/** Parses a CSR, verifies its signature and requires a P-256 key. Returns the key hash and public key. */
export async function verifyCsr(
  csrPem: unknown,
): Promise<{ keyHash: string; publicKey: CryptoKey }> {
  if (typeof csrPem !== 'string' || csrPem.length > 8192)
    throw new Error('csr must be a PEM string');
  let csr: x509.Pkcs10CertificateRequest;
  try {
    csr = new x509.Pkcs10CertificateRequest(csrPem);
  } catch (e) {
    throw new Error('csr is not a valid PKCS#10 request', { cause: e });
  }
  if (!(await csr.verify())) throw new Error('csr signature is invalid');
  const alg = csr.publicKey.algorithm as EcKeyAlgorithm;
  if (alg.name !== 'ECDSA' || alg.namedCurve !== 'P-256')
    throw new Error('csr key must be ECDSA P-256');
  return {
    keyHash: hashSpki(new Uint8Array(csr.publicKey.rawData)),
    publicKey: await csr.publicKey.export(KEY_ALG, ['verify']),
  };
}

const serial = (): string => `0${crypto.randomBytes(15).toString('hex')}`;

export interface SubjectNames {
  dns: string[];
  ip: string[];
}
/** The DNS names and IP addresses a server certificate covers, from the public URL plus optional extras. */
export function serverNames(advertiseUrl: string, extras: string[] = []): SubjectNames {
  const names: SubjectNames = { dns: [], ip: [] };
  const host = new URL(advertiseUrl).hostname.replace(/^\[|\]$/g, '');
  for (const entry of [host, ...extras.map((e) => e.trim()).filter(Boolean)]) {
    const bucket = net.isIP(entry) ? names.ip : names.dns;
    if (!bucket.includes(entry)) bucket.push(entry);
  }
  return names;
}
export const namesKey = (names: SubjectNames): string =>
  JSON.stringify([[...names.dns].sort(), [...names.ip].sort()]);

export class Pki {
  readonly caPem: string;
  private readonly caCert: x509.X509Certificate;
  private readonly caKey: CryptoKey;

  private constructor(caPem: string, caCert: x509.X509Certificate, caKey: CryptoKey) {
    this.caPem = caPem;
    this.caCert = caCert;
    this.caKey = caKey;
  }

  get caNotAfter(): Date {
    return this.caCert.notAfter;
  }
  get caFingerprint(): string {
    return hashSpki(new Uint8Array(this.caCert.publicKey.rawData));
  }

  /** Loads the CA from `dir`, creating it only when `create` is set and no CA files exist. Corrupt or partial material fails closed. */
  static async load(dir: string, create: boolean): Promise<Pki> {
    const keyFile = path.join(dir, 'ca.key');
    const certFile = path.join(dir, 'ca.crt');
    const [key, cert] = await Promise.all([
      fs.readFile(keyFile, 'utf8').catch(() => null),
      fs.readFile(certFile, 'utf8').catch(() => null),
    ]);
    if (key === null && cert === null) {
      if (!create)
        throw new Error(
          `control has existing state but its CA is missing from ${dir}; restore pki/ from a backup`,
        );
      return Pki.create(dir);
    }
    if (key === null || cert === null) throw new Error(`incomplete CA material in ${dir}`);
    try {
      const caCert = new x509.X509Certificate(cert);
      const keys = await importPrivateKey(key);
      const same =
        hashSpki(new Uint8Array(caCert.publicKey.rawData)) ===
        hashSpki(Buffer.from(await crypto.webcrypto.subtle.exportKey('spki', keys.publicKey)));
      if (!same) throw new Error('CA key does not match the CA certificate');
      return new Pki(cert, caCert, keys.privateKey);
    } catch (e) {
      throw new Error(
        `corrupt CA material in ${dir}: ${e instanceof Error ? e.message : String(e)}`,
        { cause: e },
      );
    }
  }

  private static async create(dir: string): Promise<Pki> {
    const keys = (await crypto.webcrypto.subtle.generateKey(KEY_ALG, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const now = Date.now();
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: serial(),
      name: 'CN=Tug CA',
      notBefore: new Date(now - BACKDATE_MS),
      notAfter: new Date(now + CA_LIFETIME_MS),
      signingAlgorithm: SIGNING,
      keys,
      extensions: [
        new x509.BasicConstraintsExtension(true, 0, true),
        new x509.KeyUsagesExtension(
          x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
          true,
        ),
        await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
      ],
    });
    const pkcs8 = Buffer.from(await crypto.webcrypto.subtle.exportKey('pkcs8', keys.privateKey));
    await writeFileDurable(path.join(dir, 'ca.key'), toPem(pkcs8, 'PRIVATE KEY'), 0o600);
    await writeFileDurable(path.join(dir, 'ca.crt'), cert.toString('pem'), 0o644);
    return Pki.load(dir, false);
  }

  /** Signs a leaf with an assigned profile. Requester-supplied subjects, SANs, validity and extensions are never used. */
  async signLeaf(options: {
    publicKey: CryptoKey;
    kind: 'client' | 'server';
    uri?: string;
    names?: SubjectNames;
    lifetimeMs: number;
  }): Promise<{ cert: string; notAfter: Date }> {
    const now = Date.now();
    const notAfter = new Date(Math.min(now + options.lifetimeMs, this.caCert.notAfter.getTime()));
    const san: x509.JsonGeneralName[] = [];
    if (options.uri) san.push({ type: 'url', value: options.uri });
    for (const dns of options.names?.dns ?? []) san.push({ type: 'dns', value: dns });
    for (const ip of options.names?.ip ?? []) san.push({ type: 'ip', value: ip });
    const cert = await x509.X509CertificateGenerator.create({
      serialNumber: serial(),
      subject: options.kind === 'server' ? 'CN=tug-control' : 'CN=tug-client',
      issuer: this.caCert.subject,
      notBefore: new Date(now - BACKDATE_MS),
      notAfter,
      signingAlgorithm: SIGNING,
      publicKey: options.publicKey,
      signingKey: this.caKey,
      extensions: [
        new x509.BasicConstraintsExtension(false, undefined, true),
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
        new x509.ExtendedKeyUsageExtension(
          [
            options.kind === 'server'
              ? x509.ExtendedKeyUsage.serverAuth
              : x509.ExtendedKeyUsage.clientAuth,
          ],
          true,
        ),
        new x509.SubjectAlternativeNameExtension(san, false),
        await x509.AuthorityKeyIdentifierExtension.create(this.caCert, false),
      ],
    });
    return { cert: cert.toString('pem'), notAfter };
  }

  /** Verifies a CSR and signs a client certificate naming `uri` for its key. */
  async signClientCsr(csrPem: unknown, uri: string, lifetimeMs: number) {
    const { keyHash, publicKey } = await verifyCsr(csrPem);
    const { cert, notAfter } = await this.signLeaf({ publicKey, kind: 'client', uri, lifetimeMs });
    return { cert, keyHash, notAfter };
  }

  /** A client keypair and certificate for `uri`, for credentials issued on control (operators, enrollment keys, root). */
  async issueClient(uri: string, lifetimeMs: number, url: string) {
    const keys = await generateKeyPair();
    const { cert, notAfter } = await this.signLeaf({
      publicKey: keys.publicKey,
      kind: 'client',
      uri,
      lifetimeMs,
    });
    const credential: Credential = { v: 1, url, ca: this.caPem, cert, key: keys.privateKeyPem };
    return { credential, keyHash: certKeyHash(cert), notAfter };
  }

  /** The server certificate and key for the given names. */
  get controlName(): string {
    return controlNameFromCa(this.caPem);
  }

  /** The server certificate always carries the generated control name, plus the given addresses. */
  async issueServer(addresses: SubjectNames) {
    const names: SubjectNames = { dns: [this.controlName, ...addresses.dns], ip: addresses.ip };
    const keys = await generateKeyPair();
    const { cert, notAfter } = await this.signLeaf({
      publicKey: keys.publicKey,
      kind: 'server',
      names,
      lifetimeMs: SERVER_LIFETIME_MS,
    });
    return { cert, key: keys.privateKeyPem, notAfter };
  }
}

/** Checks that a certificate chains to `ca`, names `uri` and is bound to the key. Used by the agent before installing. */
export function validateInstalledCertificate(options: {
  cert: string;
  ca: string;
  keyPem: string;
  uri: string;
}): void {
  const cert = new crypto.X509Certificate(options.cert);
  if (!cert.verify(new crypto.X509Certificate(options.ca).publicKey))
    throw new Error('certificate is not signed by the supplied CA');
  if (!cert.checkPrivateKey(crypto.createPrivateKey(options.keyPem)))
    throw new Error('certificate does not match the pending private key');
  if (!(cert.subjectAltName ?? '').split(/,\s*/).includes(`URI:${options.uri}`))
    throw new Error(`certificate does not name ${options.uri}`);
}

/**
 * The generated name control answers to, derived from its CA key: stable for the life of the CA and independent of any
 * address. Control puts it in its server certificate and clients recompute it from the CA they pin, so moving control to
 * another IP or DNS name needs no new credentials.
 */
export function controlNameFromCa(caPem: string): string {
  const spki = new crypto.X509Certificate(caPem).publicKey.export({ type: 'spki', format: 'der' });
  return `control-${hashSpki(spki).slice(0, 12)}.tug`;
}

/**
 * TLS client options pinned to the credential's CA. The server is verified by its generated control name, never by the
 * address the connection goes to, so an address override (a tunnel, a private IP, a moved host) keeps full verification.
 */
export function clientTlsOptions(credential: Credential): tls.ConnectionOptions {
  const name = controlNameFromCa(credential.ca);
  return {
    ca: credential.ca,
    cert: credential.cert,
    key: credential.key,
    minVersion: 'TLSv1.3',
    servername: name,
    checkServerIdentity: (_host, cert) => tls.checkServerIdentity(name, cert),
  };
}

/** The peer identity presented on a TLS socket, or null when none can be established. */
export function peerIdentity(socket: tls.TLSSocket): {
  uri: string;
  keyHash: string;
  notAfter: number;
} | null {
  if (!socket.authorized) return null;
  const peer = socket.getPeerCertificate(false);
  if (!peer || !peer.raw) return null;
  const x = new crypto.X509Certificate(peer.raw);
  const uri = (x.subjectAltName ?? '')
    .split(/,\s*/)
    .map((s) => s.trim())
    .find((s) => s.startsWith('URI:'))
    ?.slice(4);
  if (!uri) return null;
  const notAfter = Date.parse(x.validTo);
  if (!(notAfter > Date.now()) || !(Date.parse(x.validFrom) <= Date.now() + 60_000)) return null;
  return {
    uri,
    keyHash: hashSpki(x.publicKey.export({ type: 'spki', format: 'der' })),
    notAfter,
  };
}
