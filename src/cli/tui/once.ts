import { deriveAttention, deriveCounters } from './derive.ts';
import { ageOf, sanitize } from './format.ts';
import type { Attention, Counters, Snapshot } from './types.ts';

export interface OnceReport {
  /** True when nothing of rank 1 to 3 needs attention. */
  ok: boolean;
  control: { version: string | null; role: string | null };
  counters: Counters;
  attention: {
    rank: number;
    subject: string;
    reason: string;
    since: string | null;
  }[];
}

/** Rank 4 items (public ports, held services) are worth showing but do not fail a monitor. */
export const FAILING_RANK = 3;

export function onceReport(snapshot: Snapshot, now: number, cliVersion: string): OnceReport {
  const attention: Attention[] = deriveAttention(snapshot, now, cliVersion);
  return {
    ok: !attention.some((item) => item.rank <= FAILING_RANK),
    control: { version: snapshot.version.data ?? null, role: snapshot.whoami.data?.role ?? null },
    counters: deriveCounters(snapshot, now, attention),
    attention: attention.map((item) => ({
      rank: item.rank,
      subject: item.subject,
      reason: item.reason,
      since: item.since ?? null,
    })),
  };
}

/** The attention list as text, for a prompt or a cron mail: the same ranking the full screen shows. */
export function formatOnce(report: OnceReport, now: number): string {
  const c = report.counters;
  const lines = [
    `Nodes ${c.nodesOnline}/${c.nodesTotal} online · Projects ${c.projects} · Services ${c.servicesServing}/${c.servicesTotal} serving · Backups ${c.backupProblems ? `${c.backupProblems} problem${c.backupProblems === 1 ? '' : 's'}` : 'ok'} · Events ${c.eventErrors} error, ${c.eventWarnings} warn (24h)`,
    '',
  ];
  if (!report.attention.length) lines.push('All clear: nothing needs attention');
  else {
    lines.push(`Attention (${report.attention.length})`);
    for (const item of report.attention)
      lines.push(
        `  ${item.rank === 1 ? '✖' : item.rank === 4 ? '·' : '▲'} ${sanitize(item.subject)}: ${sanitize(item.reason)}${item.since ? ` (${ageOf(item.since, now)})` : ''}`,
      );
  }
  return lines.join('\n');
}
