/** Input to the Prometheus snapshot renderer. Callers pass only rows visible to the requester. */
export interface MetricsSnapshot {
  now?: number;
  nodes?: Array<{ name: string; lastSeenAt: string | number | null }>;
  deployments?: Array<{ project: string; state: string; count?: number; outcome?: string | null }>;
  backups?: Array<{
    project: string;
    target: string;
    state: string;
    succeededAt?: string | number | null;
  }>;
  queue?: { depth: number; activeSince?: string | number | null };
}

const label = (value: string): string =>
  value.replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('"', '\\"');

const labels = (values: Record<string, string>): string =>
  `{${Object.entries(values)
    .map(([key, value]) => `${key}="${label(value)}"`)
    .join(',')}}`;

const timestamp = (value: string | number | null | undefined): number | undefined => {
  if (value === null || value === undefined) return undefined;
  const result = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(result) ? result : undefined;
};

const age = (now: number, since: string | number | null | undefined): number => {
  const time = timestamp(since);
  return time === undefined ? 0 : Math.max(0, (now - time) / 1000);
};

const finiteState = (value: string, allowed: readonly string[]): string =>
  allowed.includes(value) ? value : 'other';

const countLines = (
  name: string,
  help: string,
  samples: Map<string, { labels: Record<string, string>; count: number }>,
): string[] => [
  `# HELP ${name} ${help}`,
  `# TYPE ${name} gauge`,
  ...[...samples.values()].map((sample) => `${name}${labels(sample.labels)} ${sample.count}`),
];

/** Renders a stable, low-cardinality Prometheus snapshot without resource IDs or error text. */
export function renderMetricsSnapshot(snapshot: MetricsSnapshot): string {
  const now = snapshot.now ?? Date.now();
  const lines = [
    '# HELP tug_node_poll_age_seconds Seconds since a node last reported status; zero means never reported.',
    '# TYPE tug_node_poll_age_seconds gauge',
    ...(snapshot.nodes ?? []).map(
      (node) =>
        `tug_node_poll_age_seconds${labels({ node: node.name })} ${age(now, node.lastSeenAt)}`,
    ),
    '# HELP tug_node_reported Whether a node has ever reported status (1) or has never reported (0).',
    '# TYPE tug_node_reported gauge',
    ...(snapshot.nodes ?? []).map(
      (node) =>
        `tug_node_reported${labels({ node: node.name })} ${timestamp(node.lastSeenAt) === undefined ? 0 : 1}`,
    ),
  ];

  const deploymentCounts = new Map<string, { labels: Record<string, string>; count: number }>();
  for (const deployment of snapshot.deployments ?? []) {
    const state = finiteState(deployment.state, [
      'building',
      'build_failed',
      'rolling_out',
      'succeeded',
      'failed',
      'cancelled',
    ]);
    const outcome = deployment.outcome
      ? finiteState(deployment.outcome, ['success', 'failure', 'cancelled'])
      : '';
    const sampleLabels = { project: deployment.project, state, ...(outcome ? { outcome } : {}) };
    const key = JSON.stringify(sampleLabels);
    const sample = deploymentCounts.get(key) ?? { labels: sampleLabels, count: 0 };
    sample.count += Math.max(0, Math.floor(deployment.count ?? 1));
    deploymentCounts.set(key, sample);
  }
  lines.push(
    ...countLines(
      'tug_deployments',
      'Current deployment count by project and finite deployment state.',
      deploymentCounts,
    ),
  );

  const backupCounts = new Map<string, { labels: Record<string, string>; count: number }>();
  const backupSuccesses = new Map<
    string,
    { labels: Record<string, string>; age: number; hasSuccess: boolean }
  >();
  for (const backup of snapshot.backups ?? []) {
    const state = finiteState(backup.state, [
      'never',
      'disabled',
      'queued',
      'running',
      'succeeded',
      'failed',
      'cancelled',
      'missed',
      'unknown',
    ]);
    const stateLabels = { project: backup.project, target: backup.target, state };
    const stateKey = JSON.stringify(stateLabels);
    const stateSample = backupCounts.get(stateKey) ?? { labels: stateLabels, count: 0 };
    stateSample.count++;
    backupCounts.set(stateKey, stateSample);
    const successLabels = { project: backup.project, target: backup.target };
    const successKey = JSON.stringify(successLabels);
    const successAge = age(now, backup.succeededAt);
    const hasSuccess = timestamp(backup.succeededAt) !== undefined;
    const existing = backupSuccesses.get(successKey);
    if (!existing || (hasSuccess && (!existing.hasSuccess || successAge < existing.age)))
      backupSuccesses.set(successKey, { labels: successLabels, age: successAge, hasSuccess });
  }
  lines.push(
    ...countLines(
      'tug_backup_targets',
      'Configured backup target count by project and finite latest backup state in the supplied snapshot.',
      backupCounts,
    ),
    '# HELP tug_backup_success_age_seconds Seconds since the most recent successful backup per project and target.',
    '# TYPE tug_backup_success_age_seconds gauge',
    ...[...backupSuccesses.values()].map(
      (sample) => `tug_backup_success_age_seconds${labels(sample.labels)} ${sample.age}`,
    ),
    '# HELP tug_backup_has_success Whether a successful backup exists for a configured project target.',
    '# TYPE tug_backup_has_success gauge',
    ...[...backupSuccesses.values()].map(
      (sample) => `tug_backup_has_success${labels(sample.labels)} ${sample.hasSuccess ? 1 : 0}`,
    ),
  );

  if (snapshot.queue)
    lines.push(
      '# HELP tug_writer_queue_depth Number of pending items in the global control writer queue.',
      '# TYPE tug_writer_queue_depth gauge',
      ...(snapshot.queue
        ? [`tug_writer_queue_depth ${Math.max(0, Math.floor(snapshot.queue.depth))}`]
        : []),
      '# HELP tug_writer_active_age_seconds Seconds since the global control writer queue item started; zero means idle or unknown.',
      '# TYPE tug_writer_active_age_seconds gauge',
      ...(snapshot.queue
        ? [`tug_writer_active_age_seconds ${age(now, snapshot.queue.activeSince)}`]
        : []),
    );

  return `${lines.join('\n')}\n`;
}
