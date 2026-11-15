// Agent side: what clients get from this node's Caddy for each named host. State comes from a TLS handshake
// against the node's own port 443 (ground truth, and it reproduces the "internal error" a client sees while ACME has
// not succeeded); Caddy's log only supplies the reason. See docs/ingress.md#certificate-status.
import tls from 'node:tls';
import { errMessage } from './errors.ts';
import { CADDY_CONTAINER } from './ingress.ts';
import type { DockerApi } from './docker-api.ts';
import type { IngressCertStatus, IngressRoute } from './protocol.ts';

/** Reports at most this many hosts, so a huge mapped-domain list cannot bloat the status report. */
export const MAX_TLS_HOSTS = 256;
const PARALLEL_PROBES = 8;
const RETRY_UNISSUED_MS = 20_000;
const RECHECK_ISSUED_MS = 60 * 60_000;
const LOG_SCAN_MS = 60_000;
const LOG_TAIL = 1000;
/** How long `check` waits for fresh probes before answering from what it has; the rest finishes in the background. */
const CHECK_WAIT_MS = 2000;
const LOG_TIMEOUT_MS = 5000;

export type TlsProbeResult =
  { ok: true; notAfter: string; issuer?: string } | { ok: false; error: string };
export type TlsProbe = (host: string) => Promise<TlsProbeResult>;

/**
 * Named hosts whose certificate Caddy obtains itself: every non-wildcard `tls: auto` name and mapped domain.
 * A `tls: custom` route's declared names carry the operator's own certificate, and wildcard zones are issued name
 * by name on demand, where a probe would itself trigger issuance for a name nobody asked for.
 */
export function tlsHosts(routes: IngressRoute[]): string[] {
  const hosts = new Set<string>();
  for (const route of routes) {
    if (route.tls === 'off') continue;
    const names = [
      ...(route.tls === 'auto' ? [route.host, ...(route.hosts ?? [])] : []),
      ...(route.aliases ?? []),
    ];
    for (const name of names) if (!name.includes('*')) hosts.add(name.toLowerCase());
  }
  return [...hosts].sort().slice(0, MAX_TLS_HOSTS);
}

function covers(subjectAltName: string | undefined, host: string): boolean {
  return (subjectAltName ?? '').split(',').some((entry) => {
    const name = entry.trim().replace(/^DNS:/i, '').toLowerCase();
    if (!entry.trim().toLowerCase().startsWith('dns:')) return false;
    if (name === host) return true;
    return (
      name.startsWith('*.') &&
      host.split('.').length === name.split('.').length &&
      host.endsWith(name.slice(1))
    );
  });
}

/** Handshakes with `host` as SNI against the local Caddy and reads the certificate it presents. */
export function probeTls(
  host: string,
  options: { address?: string; port?: number; timeoutMs?: number; now?: () => number } = {},
): Promise<TlsProbeResult> {
  const { address = '127.0.0.1', port = 443, timeoutMs = 3000, now = Date.now } = options;
  return new Promise((resolve) => {
    let done = false;
    const finish = (result: TlsProbeResult) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(result);
    };
    const socket = tls.connect({
      host: address,
      port,
      servername: host,
      // Trust is not the question: a certificate that covers the host and is in date is what Caddy obtained.
      rejectUnauthorized: false,
      timeout: timeoutMs,
    });
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate();
      if (!cert || !cert.valid_to) return finish({ ok: false, error: 'no certificate presented' });
      if (!covers(cert.subjectaltname, host))
        return finish({ ok: false, error: 'the served certificate does not cover the host' });
      const notAfter = new Date(cert.valid_to);
      if (notAfter.getTime() <= now())
        return finish({ ok: false, error: 'the certificate has expired' });
      finish({
        ok: true,
        notAfter: notAfter.toISOString(),
        ...(cert.issuer?.O || cert.issuer?.CN
          ? { issuer: String(cert.issuer.O ?? cert.issuer.CN).slice(0, 100) }
          : {}),
      });
    });
    socket.once('timeout', () => finish({ ok: false, error: 'TLS handshake timed out' }));
    socket.once('error', (e) => finish({ ok: false, error: errMessage(e).slice(0, 300) }));
  });
}

export interface IssuanceError {
  reason: string;
  /** Epoch milliseconds of the log line (the scan time when the line has no usable `ts`). */
  at: number;
}

/**
 * The latest issuance error Caddy logged per host. Caddy writes JSON lines; the ones that matter come from the `tls.*`
 * loggers at warn or error level and name the host in `identifier` (or `domain`). Best effort: a log format change
 * costs the explanation, never the state.
 */
export function parseIssuanceErrors(
  logText: string,
  scannedAt = Date.now(),
): Map<string, IssuanceError> {
  const errors = new Map<string, IssuanceError>();
  for (const line of logText.split('\n')) {
    if (!line.startsWith('{')) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof entry.logger !== 'string' || !entry.logger.startsWith('tls')) continue;
    if (entry.level !== 'error' && entry.level !== 'warn') continue;
    const host = [entry.identifier, entry.domain].find((v): v is string => typeof v === 'string');
    if (!host) continue;
    const reason = [entry.error, entry.msg].find(
      (v): v is string => typeof v === 'string' && v !== '',
    );
    if (!reason) continue;
    // Caddy's `ts` is Unix seconds; accept an ISO string too.
    const at =
      typeof entry.ts === 'number' && Number.isFinite(entry.ts)
        ? entry.ts * 1000
        : typeof entry.ts === 'string' && Number.isFinite(Date.parse(entry.ts))
          ? Date.parse(entry.ts)
          : scannedAt;
    const key = host.toLowerCase();
    if (!errors.has(key) || at >= errors.get(key)!.at)
      errors.set(key, { reason: reason.slice(0, 300), at });
  }
  return errors;
}

async function readLogs(docker: DockerApi, tail: number): Promise<string> {
  const proc = await docker.logs(CADDY_CONTAINER, { follow: false, tail });
  const chunks: Buffer[] = [];
  proc.stdout.on('data', (d: Buffer) => chunks.push(d));
  proc.stderr.on('data', (d: Buffer) => chunks.push(d));
  await new Promise<void>((resolve, reject) => {
    proc.on('error', reject);
    proc.on('close', () => resolve());
  });
  return Buffer.concat(chunks).toString('utf8');
}

function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

export interface TlsMonitor {
  check(routes: IngressRoute[], docker: DockerApi): Promise<IngressCertStatus[]>;
}

interface Entry {
  host: string;
  state: IngressCertStatus['state'];
  since: string;
  /** When the monitor first saw the host: log errors older than this belong to an earlier life of the name. */
  firstSeen: number;
  probedAt: number;
  probeOk: boolean;
  probeError?: string;
  notAfter?: string;
  issuer?: string;
  issuedAt?: number;
  /** Kept until the host is issued, so an error scrolling out of Caddy's log does not turn `failed` back into `pending`. */
  lastError?: IssuanceError;
}

/**
 * Probes lazily: a new or not-yet-issued host every twenty seconds, an issued one hourly, and reads Caddy's log for
 * reasons at most once a minute while any host is not issued. `check` never holds the agent's poll for long: it
 * answers after `checkWaitMs` from what it knows, and probes and the log read (itself time-bounded) finish in the
 * background, one refresh at a time.
 */
export function createTlsMonitor(
  options: {
    probe?: TlsProbe;
    now?: () => number;
    readLog?: (docker: DockerApi) => Promise<string>;
    checkWaitMs?: number;
    logTimeoutMs?: number;
  } = {},
): TlsMonitor {
  const probe = options.probe ?? ((host) => probeTls(host));
  const now = options.now ?? Date.now;
  const readLog = options.readLog ?? ((docker) => readLogs(docker, LOG_TAIL));
  const checkWaitMs = options.checkWaitMs ?? CHECK_WAIT_MS;
  const logTimeoutMs = options.logTimeoutMs ?? LOG_TIMEOUT_MS;
  const known = new Map<string, Entry>();
  let scannedAt = -Infinity;
  let inflight: Promise<void> | undefined;

  /** The state follows from the probe and the latest log error; `since` moves only when it changes. */
  const settle = (entry: Entry) => {
    const state = entry.probeOk ? 'issued' : entry.lastError ? 'failed' : 'pending';
    if (state !== entry.state) entry.since = new Date(now()).toISOString();
    entry.state = state;
  };

  async function refresh(hosts: string[], docker: DockerApi): Promise<void> {
    const due = hosts.filter((host) => {
      const entry = known.get(host);
      if (!entry) return false;
      return now() - entry.probedAt >= (entry.probeOk ? RECHECK_ISSUED_MS : RETRY_UNISSUED_MS);
    });
    for (let i = 0; i < due.length; i += PARALLEL_PROBES)
      await Promise.all(
        due.slice(i, i + PARALLEL_PROBES).map(async (host) => {
          const result = await probe(host).catch((e): TlsProbeResult => ({
            ok: false,
            error: errMessage(e).slice(0, 300),
          }));
          const entry = known.get(host);
          if (!entry) return;
          entry.probedAt = now();
          entry.probeOk = result.ok;
          if (result.ok) {
            entry.notAfter = result.notAfter;
            entry.issuer = result.issuer;
            entry.probeError = undefined;
            entry.issuedAt = now();
            entry.lastError = undefined;
          } else {
            entry.probeError = result.error;
            entry.notAfter = undefined;
            entry.issuer = undefined;
          }
          settle(entry);
        }),
      );
    if (hosts.some((host) => !known.get(host)?.probeOk) && now() - scannedAt >= LOG_SCAN_MS) {
      scannedAt = now();
      const errors = await within(readLog(docker), logTimeoutMs, 'reading the Caddy log').then(
        (text) => parseIssuanceErrors(text, now()),
        () => new Map<string, IssuanceError>(),
      );
      for (const [host, error] of errors) {
        const entry = known.get(host);
        // Only errors from after the host was first seen and after it last had a certificate describe this state.
        if (
          !entry ||
          entry.probeOk ||
          error.at < entry.firstSeen ||
          error.at <= (entry.issuedAt ?? -Infinity) ||
          error.at < (entry.lastError?.at ?? -Infinity)
        )
          continue;
        entry.lastError = error;
        settle(entry);
      }
    }
  }

  return {
    async check(routes, docker) {
      const hosts = tlsHosts(routes);
      for (const host of [...known.keys()]) if (!hosts.includes(host)) known.delete(host);
      for (const host of hosts)
        if (!known.has(host))
          known.set(host, {
            host,
            state: 'pending',
            since: new Date(now()).toISOString(),
            firstSeen: now(),
            probedAt: -Infinity,
            probeOk: false,
          });
      inflight ??= refresh(hosts, docker)
        .catch(() => {})
        .finally(() => {
          inflight = undefined;
        });
      await within(inflight, checkWaitMs, 'the TLS check').catch(() => {});
      return hosts.map((host): IngressCertStatus => {
        const e = known.get(host)!;
        return {
          host,
          state: e.state,
          since: e.since,
          ...(e.state === 'issued'
            ? {
                ...(e.notAfter ? { notAfter: e.notAfter } : {}),
                ...(e.issuer ? { issuer: e.issuer } : {}),
              }
            : { error: e.lastError?.reason ?? e.probeError ?? 'not probed yet' }),
        };
      });
    },
  };
}
