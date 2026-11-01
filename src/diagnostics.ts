import { BACKDATE_MS } from './pki.ts';

const DAY = 86_400_000;

/** Days of remaining validity below which each certificate kind is reported as expiring (renewal is overdue). */
export const EXPIRY_WARN_DAYS = { ca: 90, server: 30, node: 14 } as const;
/** A clock this far from control's is worth a look; it is far below the five-minute certificate back-dating. */
export const SKEW_WARN_MS = 30_000;
/** At this skew new certificates look not yet valid (or old ones expired) to the node, so renewal and TLS break. */
export const SKEW_FAIL_MS = BACKDATE_MS;

export type ExpiryState = 'ok' | 'expiring' | 'expired';

export interface CertificateExpiry {
  notAfter: string;
  daysLeft: number;
  state: ExpiryState;
}

export function certificateExpiry(
  notAfter: Date,
  nowMs: number,
  warnDays: number,
): CertificateExpiry {
  const left = notAfter.getTime() - nowMs;
  return {
    notAfter: notAfter.toISOString(),
    daysLeft: Math.floor(left / DAY),
    state: left <= 0 ? 'expired' : left < warnDays * DAY ? 'expiring' : 'ok',
  };
}

/** Clock skew is only known for a node that is reporting now; an offline node has an unknown clock, not a zero skew. */
export type ClockSkew =
  | { state: 'observed'; ms: number; observedAt: string }
  | { state: 'unknown'; reason: 'offline' | 'never reported' | 'disabled' };

export type Connectivity = 'online' | 'stale' | 'never-seen' | 'disabled';

export interface NodeDiagnosticInput {
  name: string;
  disabled_at: string | null;
  last_seen_at: string | null;
  cert_not_after: string | null;
  clock_skew_ms: number | null;
  clock_observed_at: string | null;
}

export interface NodeDiagnostic {
  name: string;
  connectivity: Connectivity;
  certificate: CertificateExpiry | null;
  clockSkew: ClockSkew;
  problems: string[];
  warnings: string[];
}

export function diagnoseNode(
  node: NodeDiagnosticInput,
  nowMs: number,
  staleSeconds: number,
): NodeDiagnostic {
  const staleBefore = nowMs - staleSeconds * 1000;
  const fresh = (iso: string | null) => !!iso && Date.parse(iso) >= staleBefore;
  const connectivity: Connectivity = node.disabled_at
    ? 'disabled'
    : !node.last_seen_at
      ? 'never-seen'
      : fresh(node.last_seen_at)
        ? 'online'
        : 'stale';
  const certificate = node.cert_not_after
    ? certificateExpiry(new Date(node.cert_not_after), nowMs, EXPIRY_WARN_DAYS.node)
    : null;
  let clockSkew: ClockSkew;
  if (connectivity === 'online' && node.clock_skew_ms !== null && fresh(node.clock_observed_at))
    clockSkew = {
      state: 'observed',
      ms: node.clock_skew_ms,
      observedAt: node.clock_observed_at!,
    };
  else
    clockSkew = {
      state: 'unknown',
      reason:
        connectivity === 'disabled'
          ? 'disabled'
          : connectivity === 'online'
            ? 'never reported'
            : connectivity === 'never-seen'
              ? 'never reported'
              : 'offline',
    };
  const problems: string[] = [];
  const warnings: string[] = [];
  // A disabled node's certificate is irrelevant until it is replaced, so it never fails the diagnostics.
  const report = connectivity === 'disabled' ? warnings : problems;
  if (certificate?.state === 'expired')
    report.push(
      `certificate expired ${certificate.notAfter}; run node-replace-identity ${node.name}`,
    );
  else if (certificate?.state === 'expiring')
    warnings.push(
      `certificate expires in ${certificate.daysLeft} days and has not renewed; check the agent logs on node ${node.name}`,
    );
  if (clockSkew.state === 'observed') {
    const abs = Math.abs(clockSkew.ms);
    const seconds = Math.round(clockSkew.ms / 1000);
    if (abs >= SKEW_FAIL_MS)
      problems.push(
        `clock differs from the control plane by ${seconds}s (certificates are back-dated ${BACKDATE_MS / 60_000} minutes); fix time sync on node ${node.name}`,
      );
    else if (abs >= SKEW_WARN_MS)
      warnings.push(`clock differs from the control plane by ${seconds}s`);
  }
  return { name: node.name, connectivity, certificate, clockSkew, problems, warnings };
}
