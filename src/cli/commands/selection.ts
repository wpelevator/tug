import { selectMany, selectOne } from '../selection.ts';
import type { Choice } from '../selection.ts';
import { projectOf, request } from './context.ts';

export const projectQuery = async (): Promise<string> =>
  `project=${encodeURIComponent(await projectOf({}))}`;
export interface ServiceChoice {
  name: string;
  nodes: { name: string; status: string }[];
}
export async function services(): Promise<ServiceChoice[]> {
  return (
    await request<{ services: ServiceChoice[] }>('GET', `/api/v1/services?${await projectQuery()}`)
  ).services;
}
export const serviceChoices = async (): Promise<Choice[]> =>
  (await services()).map((service) => ({
    value: service.name,
    label: `${service.name} (${service.nodes.map((node) => `${node.name}: ${node.status}`).join(', ') || 'no nodes'})`,
  }));
export const selectService = (name?: string): Promise<string> =>
  selectOne(name, 'Select a service', serviceChoices);
export const selectNode = (name?: string): Promise<string> =>
  selectOne(name, 'Select a node', async () => {
    const { nodes } = await request<{
      nodes: {
        name: string;
        status: string;
        address: string | null;
        disabled_at: string | null;
        ingress: number;
        labels: string[];
      }[];
    }>('GET', '/api/v1/nodes');
    return nodes.map((node) => ({
      value: node.name,
      label: `${node.name} (${node.disabled_at ? 'disabled' : node.status}, ${node.address || 'no address'}${node.ingress ? ', ingress' : ''}${node.labels.length ? `, ${node.labels.join(', ')}` : ''})`,
    }));
  });
export const selectResource = (
  name: string | undefined,
  resource: 'secrets' | 'volumes' | 'credentials',
): Promise<string> =>
  selectOne(name, `Select a ${resource.slice(0, -1)}`, async () => {
    const listing = await request<
      Record<
        string,
        {
          name: string;
          version?: number;
          node_id?: string;
          node?: string;
          persistent?: boolean;
          usedBy?: string[];
          lastUsedAt?: string;
          type?: string;
          role?: string;
          expiresAt?: string;
          revokedAt?: string | null;
          projects?: string[] | null;
        }[]
      >
    >('GET', `/api/v1/${resource}${resource === 'credentials' ? '' : `?${await projectQuery()}`}`);
    return listing[resource]
      .filter((row) => !row.revokedAt && !row.usedBy?.length)
      .map((row) => {
        const details = [
          row.version !== undefined ? `version ${row.version}` : '',
          row.node || row.node_id,
          row.type,
          row.persistent ? 'persistent; needs --delete-data' : '',
          row.role,
          row.lastUsedAt ? `last used ${row.lastUsedAt}` : '',
          row.projects === null ? 'all projects' : row.projects?.join(', '),
          row.expiresAt ? `expires ${row.expiresAt}` : '',
        ]
          .filter(Boolean)
          .join(', ');
        return { value: row.name, label: details ? `${row.name} (${details})` : row.name };
      });
  });
export const selectDeployment = (id?: string): Promise<string> =>
  selectOne(id, 'Select an active deployment to cancel', async () => {
    const { deployments } = await request<{
      deployments: { id: string; version: string; state: string; created_at: string }[];
    }>('GET', `/api/v1/deployments?${await projectQuery()}`);
    return deployments.map((row) => ({
      value: row.id,
      label: `${row.version} (${row.state}, ${row.created_at}, ${row.id})`,
    }));
  });
export const selectRestore = (id?: string): Promise<string> =>
  selectOne(id, 'Select an interrupted restore', async () => {
    const { restores } = await request<{
      restores: {
        id: string;
        state: string;
        target: string;
        snapshot_id: string;
        started_at: string;
        error: string | null;
      }[];
    }>('GET', `/api/v1/restores?${await projectQuery()}&state=interrupted`);
    return restores
      .filter((row) => row.state === 'interrupted')
      .map((row) => ({
        value: row.id,
        label: `${row.target} (${row.started_at}, snapshot ${row.snapshot_id}, ${row.id}${row.error ? `, ${row.error}` : ''})`,
      }));
  });
export const backupChoices = async (): Promise<Choice[]> => {
  const { targets } = await request<{
    targets: {
      target: string;
      enabled: boolean;
      node: string | null;
      lastSuccessAt: string | null;
    }[];
  }>('GET', `/api/v1/backups?${await projectQuery()}`);
  return targets
    .filter((row) => row.enabled)
    .map((row) => ({
      value: row.target,
      label: `${row.target} (${row.node || 'no node'}, last success ${row.lastSuccessAt || 'never'})`,
    }));
};
export const selectBackup = (target?: string): Promise<string> =>
  selectOne(target, 'Select a backup target', backupChoices);
export const selectBackups = (): Promise<string[]> =>
  selectMany('Select backup targets', backupChoices);
export const selectSnapshot = (target: string): Promise<string> =>
  selectOne(undefined, 'Select a backup snapshot', async () => {
    // Resolve short target names the same way as the restore endpoint, but reject ambiguity.
    const targets = await backupChoices();
    const matching = targets.filter(
      (row) => row.value === target || row.value.split(':').slice(1).join(':') === target,
    );
    if (matching.length !== 1)
      throw new Error(`use a full backup target such as service:${target} or volume:${target}`);
    const { snapshots } = await request<{
      snapshots: {
        id: string;
        snapshot_id: string;
        finished_at: string;
        size_bytes: number | null;
        trigger: string;
      }[];
    }>(
      'GET',
      `/api/v1/backup/snapshots?${await projectQuery()}&target=${encodeURIComponent(matching[0].value)}`,
    );
    return snapshots.map((row) => ({
      value: row.id,
      label: `${row.finished_at} (${row.snapshot_id}, ${row.size_bytes ?? '?'} bytes, ${row.trigger}, ${row.id})`,
    }));
  });
export const selectHolds = (): Promise<string[]> =>
  selectMany('Select move holds to release', async () => {
    const { holds } = await request<{
      holds: { service: string; reason: string; created_at: string }[];
    }>('GET', `/api/v1/holds?${await projectQuery()}`);
    return holds.map((row) => ({
      value: row.service,
      label: `${row.service} (${row.reason}, ${row.created_at})`,
    }));
  });

export const selectNodes = (configured: string[]): Promise<string[]> =>
  selectMany('Select nodes to replace or repair', async () => {
    const { nodes } = await request<{ nodes: { name: string; status: string }[] }>(
      'GET',
      '/api/v1/nodes',
    );
    return nodes
      .filter((node) => configured.includes(node.name))
      .map((node) => ({ value: node.name, label: `${node.name} (${node.status})` }));
  });
