import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Agent, fetch as undiciFetch } from 'undici';
import {
  clientTlsOptions,
  createCsr,
  generateKeyPair,
  identityUri,
  parseCredential,
  validateInstalledCertificate,
  writeFileDurable,
} from './pki.ts';
import type { Credential, PersistHooks } from './pki.ts';
import type { IdentityResponse } from './protocol.ts';
import { CLIENT_VERSION_HEADER } from './protocol.ts';
import { packageVersion } from './image.ts';

/** The agent's persisted identity: the common credential plus the node it names. */
export interface AgentDocument extends Credential {
  nodeId: string;
  nodeName: string;
}
interface PendingDocument {
  v: 1;
  key: string;
}

export const agentFile = (stateDir: string) => path.join(stateDir, 'agent.json');
export const pendingFile = (stateDir: string) => path.join(stateDir, 'agent-pending.json');

const NO_AGENT_IDENTITY =
  'this node has no identity: run `tug node add`, `tug node enroll` or `tug node repair` from an operator lifecycle';

async function readJson(file: string): Promise<unknown | null> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${file} is corrupt; run \`tug node repair\` to replace this node's identity`, {
      cause: e,
    });
  }
}

export async function loadAgentDocument(stateDir: string): Promise<AgentDocument | null> {
  const raw = await readJson(agentFile(stateDir));
  if (raw === null) return null;
  try {
    const credential = parseCredential(raw);
    const { nodeId, nodeName } = raw as Record<string, unknown>;
    if (typeof nodeId !== 'string' || typeof nodeName !== 'string')
      throw new Error('missing node identity');
    return { ...credential, nodeId, nodeName };
  } catch (e) {
    throw new Error(
      `${agentFile(stateDir)} is invalid (${e instanceof Error ? e.message : String(e)}); run \`tug node repair\``,
      { cause: e },
    );
  }
}

async function pendingKey(stateDir: string): Promise<string> {
  const existing = (await readJson(pendingFile(stateDir))) as PendingDocument | null;
  if (existing?.key) return existing.key;
  const keys = await generateKeyPair();
  await writeFileDurable(pendingFile(stateDir), JSON.stringify({ v: 1, key: keys.privateKeyPem }));
  return keys.privateKeyPem;
}

/**
 * `agent identity`: reuse or generate the pending key and return its CSR. Safe to repeat.
 *
 * `current` names the node an operator is (re-)adding on this host. When the host is already enrolled as that node,
 * the CSR is made from the installed key, so control sees the same key and treats the request as an idempotent retry:
 * this is what lets `node add` upgrade an enrolled agent in place. The installed key becomes the pending key, which is
 * what `install-cert` validates the response against. An agent enrolled as another node is refused, because a second
 * node must never share its key. Without `current`, or on a host with no installed identity, a pending key is
 * generated as before, and `node replace` therefore rotates the key.
 */
export async function agentIdentityCsr(
  stateDir: string,
  options: { current?: string } = {},
): Promise<string> {
  if (options.current !== undefined) {
    const installed = await loadAgentDocument(stateDir);
    if (installed) {
      if (installed.nodeName !== options.current)
        throw new Error(
          `this host is enrolled as node ${installed.nodeName}, not ${options.current}; use \`tug node replace ${installed.nodeName}\` to re-enroll it, or remove that node first`,
        );
      await writeFileDurable(pendingFile(stateDir), JSON.stringify({ v: 1, key: installed.key }));
      return createCsr(installed.key);
    }
  }
  return createCsr(await pendingKey(stateDir));
}

/** Validates an identity response against the pending key and durably installs it as the agent document. */
export async function installIdentity(
  stateDir: string,
  response: IdentityResponse,
  hooks: PersistHooks = {},
): Promise<AgentDocument> {
  const pending = (await readJson(pendingFile(stateDir))) as PendingDocument | null;
  if (!pending?.key) throw new Error('no pending key: run `agent identity` first');
  validateInstalledCertificate({
    cert: response.certificate,
    ca: response.ca,
    keyPem: pending.key,
    uri: identityUri('node', response.node.id),
  });
  const doc: AgentDocument = {
    ...parseCredential({
      v: 1,
      url: response.url,
      ca: response.ca,
      cert: response.certificate,
      key: pending.key,
    }),
    nodeId: response.node.id,
    nodeName: response.node.name,
  };
  await writeFileDurable(agentFile(stateDir), JSON.stringify(doc), 0o600, hooks);
  await fs.rm(pendingFile(stateDir), { force: true });
  return doc;
}

/** `agent install-cert`: reads an identity response from stdin text. */
export async function installCertFromText(stateDir: string, text: string): Promise<AgentDocument> {
  return installIdentity(stateDir, JSON.parse(text) as IdentityResponse);
}

export function describeMissingIdentity(): string {
  return NO_AGENT_IDENTITY;
}

export type HttpClient = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * A client pinned to the credential's CA that presents its certificate. `connectUrl` only changes where the TCP
 * connection goes; the server name is still verified against the credential's public host. Redirects are refused.
 */
export function createTransport(credential: Credential, connectUrl?: string) {
  if ('Bun' in globalThis) return createBunTransport(credential, connectUrl);
  const dispatcher = new Agent({ connect: clientTlsOptions(credential) as never });
  const base = new URL(connectUrl ?? credential.url).origin;
  const http: HttpClient = (url, init) => {
    // Every request declares the calling process's version, so the control can refuse one that is newer than it is
    // before running the handler; the CLI's own skew checks flow from the stamped responses this header rides on.
    // Only toward the control: this client is also handed to agent health checks that dial application containers, which
    // must not learn the Tug version.
    const headers = new Headers(init?.headers);
    if (!headers.has(CLIENT_VERSION_HEADER) && new URL(url).origin === base)
      headers.set(CLIENT_VERSION_HEADER, packageVersion());
    let request = { ...init, headers } as RequestInit;
    // The runtime's FormData is not the undici package's FormData, which would stringify it. Serialize it with the
    // runtime's own Response and stream the result.
    if (typeof FormData !== 'undefined' && init?.body instanceof FormData) {
      const encoded = new Response(init.body);
      headers.set('content-type', encoded.headers.get('content-type') ?? 'multipart/form-data');
      request = { ...init, headers, body: encoded.body, duplex: 'half' } as RequestInit;
    }
    return undiciFetch(url, {
      ...(request as object),
      redirect: 'error',
      dispatcher,
    } as never) as unknown as Promise<Response>;
  };
  return { http, base, dispatcher, close: () => dispatcher.close() };
}

const TLS_1_3 = 0x0304;

/**
 * Bun substitutes its own shim for the undici package: its `Agent` has no `close()` and ignores `connect`, which
 * would silently drop the client certificate and CA pin. Bun's `fetch` takes the same TLS options as `tls`.
 */
function createBunTransport(credential: Credential, connectUrl?: string) {
  // Bun takes `minVersion` as the numeric protocol code (0x0304 is TLS 1.3) and rejects the string Node accepts.
  const tlsOptions = { ...clientTlsOptions(credential), minVersion: TLS_1_3 as never };
  const base = new URL(connectUrl ?? credential.url).origin;
  const http: HttpClient = (url, init) => {
    const headers = new Headers(init?.headers);
    if (!headers.has(CLIENT_VERSION_HEADER) && new URL(url).origin === base)
      headers.set(CLIENT_VERSION_HEADER, packageVersion());
    // Bun's fetch follows HTTPS_PROXY / HTTP_PROXY / ALL_PROXY, which the Node path never does; a client that must
    // reach the control directly (and verify its certificate) opts out for this call only. The variable is read when
    // the request starts, and child processes such as docker and ssh never see it.
    const previous = process.env.NO_PROXY;
    process.env.NO_PROXY = '*';
    try {
      return fetch(url, { ...init, headers, redirect: 'error', tls: tlsOptions } as RequestInit);
    } finally {
      if (previous === undefined) delete process.env.NO_PROXY;
      else process.env.NO_PROXY = previous;
    }
  };
  return { http, base, dispatcher: undefined, close: () => Promise.resolve() };
}

export function certificateWindow(certPem: string): { notBefore: number; notAfter: number } {
  const x = new crypto.X509Certificate(certPem);
  return { notBefore: Date.parse(x.validFrom), notAfter: Date.parse(x.validTo) };
}

/** When to renew: two thirds of the lifetime plus up to ten percent random jitter, so a fleet does not sign together. */
export function renewalTime(certPem: string, random = Math.random()): number {
  const { notBefore, notAfter } = certificateWindow(certPem);
  const life = notAfter - notBefore;
  return notBefore + (life * 2) / 3 + random * life * 0.1;
}

/** Sends a CSR for the existing key, validates the result, saves it durably and returns the new document. */
export async function renewCertificate(
  stateDir: string,
  doc: AgentDocument,
  post: (csr: string) => Promise<{ certificate: string }>,
  hooks: PersistHooks = {},
): Promise<AgentDocument> {
  const { certificate } = await post(await createCsr(doc.key));
  validateInstalledCertificate({
    cert: certificate,
    ca: doc.ca,
    keyPem: doc.key,
    uri: identityUri('node', doc.nodeId),
  });
  const next: AgentDocument = { ...doc, cert: certificate };
  await writeFileDurable(agentFile(stateDir), JSON.stringify(next), 0o600, hooks);
  return next;
}
