import { selectMany as pickMany, selectOne as pickOne, terminalSelection } from '../selection.ts';
import type { Choice } from '../selection.ts';
import type { CliRuntime } from '../runtime.ts';
import { projectOf, request } from './context.ts';

type Load = () => Promise<Choice[]>;
const one = (rt: CliRuntime, value: string | undefined, question: string, load: Load) =>
  pickOne(value, question, load, terminalSelection(rt));
const many = (rt: CliRuntime, question: string, load: Load) =>
  pickMany(question, load, terminalSelection(rt));

export const projectQuery = (rt: CliRuntime): string =>
  `project=${encodeURIComponent(projectOf(rt, {}))}`;
export interface ServiceChoice {
  name: string;
  nodes: { name: string; status: string }[];
}
export async function services(rt: CliRuntime): Promise<ServiceChoice[]> {
  return (
    await request<{ services: ServiceChoice[] }>(rt, 'GET', `/api/v1/services?${projectQuery(rt)}`)
  ).services;
}
export const serviceChoices = async (rt: CliRuntime): Promise<Choice[]> =>
  (await services(rt)).map((service) => ({
    value: service.name,
    label: `${service.name} (${service.nodes.map((node) => `${node.name}: ${node.status}`).join(', ') || 'no nodes'})`,
  }));
export const selectService = (rt: CliRuntime, name?: string): Promise<string> =>
  one(rt, name, 'Select a service', () => serviceChoices(rt));
export const selectNode = (rt: CliRuntime, name?: string): Promise<string> =>
  one(rt, name, 'Select a node', async () => {
    const { nodes } = await request<{
      nodes: {
        name: string;
        status: string;
        address: string | null;
        disabled_at: string | null;
        ingress: number;
        labels: string[];
      }[];
    }>(rt, 'GET', '/api/v1/nodes');
    return nodes.map((node) => ({
      value: node.name,
      label: `${node.name} (${node.disabled_at ? 'disabled' : node.status}, ${node.address || 'no address'}${node.ingress ? ', ingress' : ''}${node.labels.length ? `, ${node.labels.join(', ')}` : ''})`,
    }));
  });
/** Offers only enabled ingress nodes: the picker for `tug ingress` commands. */
export const selectIngressNode = (rt: CliRuntime, name?: string): Promise<string> =>
  one(rt, name, 'Select an ingress node', async () => {
    const { nodes } = await request<{
      nodes: { name: string; status: string; disabled_at: string | null; ingress: number }[];
    }>(rt, 'GET', '/api/v1/nodes');
    return nodes
      .filter((node) => node.ingress && !node.disabled_at)
      .map((node) => ({ value: node.name, label: `${node.name} (${node.status})` }));
  });
export const selectResource = (
  rt: CliRuntime,
  name: string | undefined,
  resource: 'secrets' | 'vars' | 'volumes' | 'credentials',
): Promise<string> =>
  one(rt, name, `Select a ${resource.slice(0, -1)}`, async () => {
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
    >(rt, 'GET', `/api/v1/${resource}${resource === 'credentials' ? '' : `?${projectQuery(rt)}`}`);
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
export const selectDeployment = (rt: CliRuntime, id?: string): Promise<string> =>
  one(rt, id, 'Select an active deployment to cancel', async () => {
    const { deployments } = await request<{
      deployments: { id: string; version: string; state: string; created_at: string }[];
    }>(rt, 'GET', `/api/v1/deployments?${projectQuery(rt)}`);
    return deployments.map((row) => ({
      value: row.id,
      label: `${row.version} (${row.state}, ${row.created_at}, ${row.id})`,
    }));
  });
export const selectRestore = (rt: CliRuntime, id?: string): Promise<string> =>
  one(rt, id, 'Select an interrupted restore', async () => {
    const { restores } = await request<{
      restores: {
        id: string;
        state: string;
        target: string;
        snapshot_id: string;
        started_at: string;
        error: string | null;
      }[];
    }>(rt, 'GET', `/api/v1/restores?${projectQuery(rt)}&state=interrupted`);
    return restores
      .filter((row) => row.state === 'interrupted')
      .map((row) => ({
        value: row.id,
        label: `${row.target} (${row.started_at}, snapshot ${row.snapshot_id}, ${row.id}${row.error ? `, ${row.error}` : ''})`,
      }));
  });
export const backupChoices = async (rt: CliRuntime): Promise<Choice[]> => {
  const { targets } = await request<{
    targets: {
      target: string;
      enabled: boolean;
      node: string | null;
      lastSuccessAt: string | null;
    }[];
  }>(rt, 'GET', `/api/v1/backups?${projectQuery(rt)}`);
  return targets
    .filter((row) => row.enabled)
    .map((row) => ({
      value: row.target,
      label: `${row.target} (${row.node || 'no node'}, last success ${row.lastSuccessAt || 'never'})`,
    }));
};
export const selectBackup = (rt: CliRuntime, target?: string): Promise<string> =>
  one(rt, target, 'Select a backup target', () => backupChoices(rt));
export const selectBackups = (rt: CliRuntime): Promise<string[]> =>
  many(rt, 'Select backup targets', () => backupChoices(rt));
export const selectSnapshot = (rt: CliRuntime, target: string): Promise<string> =>
  one(rt, undefined, 'Select a backup snapshot', async () => {
    // Resolve short target names the same way as the restore endpoint, but reject ambiguity.
    const targets = await backupChoices(rt);
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
      rt,
      'GET',
      `/api/v1/backup/snapshots?${projectQuery(rt)}&target=${encodeURIComponent(matching[0].value)}`,
    );
    return snapshots.map((row) => ({
      value: row.id,
      label: `${row.finished_at} (${row.snapshot_id}, ${row.size_bytes ?? '?'} bytes, ${row.trigger}, ${row.id})`,
    }));
  });
export const selectHolds = (rt: CliRuntime): Promise<string[]> =>
  many(rt, 'Select move holds to release', async () => {
    const { holds } = await request<{
      holds: { service: string; reason: string; created_at: string }[];
    }>(rt, 'GET', `/api/v1/holds?${projectQuery(rt)}`);
    return holds.map((row) => ({
      value: row.service,
      label: `${row.service} (${row.reason}, ${row.created_at})`,
    }));
  });

export const selectNodes = (rt: CliRuntime, configured: string[]): Promise<string[]> =>
  many(rt, 'Select nodes to replace or repair', async () => {
    const { nodes } = await request<{ nodes: { name: string; status: string }[] }>(
      rt,
      'GET',
      '/api/v1/nodes',
    );
    return nodes
      .filter((node) => configured.includes(node.name))
      .map((node) => ({ value: node.name, label: `${node.name} (${node.status})` }));
  });
