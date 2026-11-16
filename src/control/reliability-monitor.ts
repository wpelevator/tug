import type { Db } from '../db/db.ts';
import type { NotificationEvent } from './notifications.ts';

/** Observes committed state without running network work or joining the control writer. */
export function createReliabilityMonitor(
  db: Db,
  emit: (event: NotificationEvent) => void,
  clock = Date.now,
) {
  let cursor = db.get<{ seq: number }>('SELECT MAX(rowid) AS seq FROM events')?.seq ?? 0;
  let deployments = new Map(
    db
      .all<{ id: string; state: string }>(
        'SELECT id,state FROM deployments ORDER BY created_at DESC LIMIT 1000',
      )
      .map((row) => [row.id, row.state]),
  );
  const nodes = new Map<string, boolean>();
  const ingressStates = new Map<string, string>();
  let controlBackups = new Set(
    db
      .all<{ id: string }>(
        "SELECT id FROM backups WHERE project_id='_control' ORDER BY created_at DESC LIMIT 100",
      )
      .map((row) => row.id),
  );
  const event = (
    id: string,
    type: string,
    project: string | null,
    node: string | null = null,
  ): NotificationEvent => ({
    id,
    type,
    project_id: project,
    node_id: node,
    message: '',
    metadata_json: null,
  });
  return {
    tick() {
      const latest = db.get<{ seq: number }>('SELECT MAX(rowid) AS seq FROM events')?.seq ?? 0;
      if (latest < cursor) cursor = 0; // Retention may empty the table and SQLite can reuse rowids.
      for (const row of db.all<NotificationEvent & { seq: number }>(
        'SELECT rowid AS seq,* FROM events WHERE rowid>? ORDER BY rowid LIMIT 100',
        cursor,
      )) {
        emit(row);
        cursor = row.seq;
      }
      const current = db.all<{ id: string; project_id: string; state: string }>(
        'SELECT id,project_id,state FROM deployments ORDER BY created_at DESC LIMIT 1000',
      );
      for (const row of current) {
        if (
          deployments.get(row.id) !== row.state &&
          ['succeeded', 'failed', 'build_failed', 'cancelled'].includes(row.state)
        )
          emit(
            event(`deployment:${row.id}:${row.state}`, `deployment.${row.state}`, row.project_id),
          );
      }
      deployments = new Map(current.map((row) => [row.id, row.state]));
      const recentBackups = db.all<{ id: string; state: string }>(
        "SELECT id,state FROM backups WHERE project_id='_control' ORDER BY created_at DESC LIMIT 100",
      );
      for (const row of recentBackups)
        if (!controlBackups.has(row.id) && row.state === 'failed')
          emit(event('control-backup:' + row.id, 'control.backup_failed', null));
      controlBackups = new Set(recentBackups.map((row) => row.id));
      const live = new Set<string>();
      const staleMs = Number(process.env.TUG_STALE_SECONDS || 60) * 1000;
      for (const row of db.all<{
        id: string;
        last_seen_at: string | null;
        ingress_status_json: string | null;
      }>('SELECT id,last_seen_at,ingress_status_json FROM nodes WHERE disabled_at IS NULL')) {
        live.add(row.id);
        const stale = !row.last_seen_at || clock() - Date.parse(row.last_seen_at) > staleMs;
        const before = nodes.get(row.id);
        if ((before === undefined && stale) || (before !== undefined && before !== stale))
          emit(
            event(
              `node:${row.id}:${stale ? 'stale' : 'recovered'}:${clock()}`,
              stale ? 'node.stale' : 'node.recovered',
              null,
              row.id,
            ),
          );
        nodes.set(row.id, stale);
        let ingressState = '';
        try {
          ingressState = JSON.parse(row.ingress_status_json ?? '{}').state ?? '';
        } catch {
          /* malformed state supplies no healthy evidence */
        }
        if (ingressState === 'failed' && ingressStates.get(row.id) !== 'failed')
          emit(event('ingress:' + row.id + ':' + clock(), 'ingress.failed', null, row.id));
        ingressStates.set(row.id, ingressState);
      }
      for (const id of nodes.keys())
        if (!live.has(id)) {
          nodes.delete(id);
          ingressStates.delete(id);
        }
    },
  };
}
