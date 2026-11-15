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

/**
 * The latest issuance error Caddy logged per host. Caddy writes JSON lines; the ones that matter come from the `tls.*`
 * loggers at warn or error level and name the host in `identifier` (or `domain`). Best effort: a log format change
 * costs the explanation, never the state.
 */
export function parseIssuanceErrors(logText: string): Map<string, string> {
  const errors = new Map<string, string>();
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
    if (reason) errors.set(host.toLowerCase(), reason.slice(0, 300));
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

export interface TlsMonitor {
  check(routes: IngressRoute[], docker: DockerApi): Promise<IngressCertStatus[]>;
}

/**
 * Probes lazily: a new or not-yet-issued host every twenty seconds, an issued one hourly, and reads Caddy's log for
 * reasons at most once a minute while any host is not issued. The agent polls every few seconds, so most calls reuse
 * the cached state.
 */
export function createTlsMonitor(
  options: {
    probe?: TlsProbe;
    now?: () => number;
    readLog?: (docker: DockerApi) => Promise<string>;
  } = {},
): TlsMonitor {
  const probe = options.probe ?? ((host) => probeTls(host));
  const now = options.now ?? Date.now;
  const readLog = options.readLog ?? ((docker) => readLogs(docker, LOG_TAIL));
  const known = new Map<string, IngressCertStatus & { probedAt: number }>();
  let issuanceErrors = new Map<string, string>();
  let scannedAt = -Infinity;
  return {
    async check(routes, docker) {
      const hosts = tlsHosts(routes);
      for (const host of [...known.keys()]) if (!hosts.includes(host)) known.delete(host);
      const due = hosts.filter((host) => {
        const entry = known.get(host);
        if (!entry) return true;
        return (
          now() - entry.probedAt >=
          (entry.state === 'issued' ? RECHECK_ISSUED_MS : RETRY_UNISSUED_MS)
        );
      });
      const transition = (host: string, state: IngressCertStatus['state']): string => {
        const before = known.get(host);
        return before?.state === state ? before.since : new Date(now()).toISOString();
      };
      for (let i = 0; i < due.length; i += PARALLEL_PROBES)
        await Promise.all(
          due.slice(i, i + PARALLEL_PROBES).map(async (host) => {
            const result = await probe(host).catch((e): TlsProbeResult => ({
              ok: false,
              error: errMessage(e).slice(0, 300),
            }));
            const state = result.ok
              ? 'issued'
              : known.get(host)?.state === 'failed'
                ? 'failed'
                : 'pending';
            known.set(host, {
              host,
              state,
              since: transition(host, state),
              probedAt: now(),
              ...(result.ok
                ? { notAfter: result.notAfter, ...(result.issuer ? { issuer: result.issuer } : {}) }
                : { error: result.error }),
            });
          }),
        );
      if (
        hosts.some((host) => known.get(host)?.state !== 'issued') &&
        now() - scannedAt >= LOG_SCAN_MS
      ) {
        scannedAt = now();
        issuanceErrors = await readLog(docker).then(parseIssuanceErrors, () => issuanceErrors);
      }
      return hosts.map((host) => {
        const entry = known.get(host)!;
        if (entry.state !== 'issued') {
          const reason = issuanceErrors.get(host);
          const state = reason ? 'failed' : 'pending';
          known.set(host, {
            ...entry,
            state,
            since: transition(host, state),
            ...(reason ? { error: reason } : {}),
          });
        }
        const { probedAt: _probedAt, ...reported } = known.get(host)!;
        return reported;
      });
    },
  };
}
