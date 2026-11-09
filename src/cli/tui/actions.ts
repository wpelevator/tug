import { ROLES } from '../../roles.ts';
import type { Role } from '../../roles.ts';
import { errMessage } from '../../errors.ts';
import type { RowContext } from './types.ts';

export type ActionId = 'restart' | 'rollback' | 'cancel' | 'backup';

/** The control API as the screen uses it: tests substitute a fake. */
export interface Api {
  request<T = unknown>(method: string, route: string, body?: unknown): Promise<T>;
  sleep(ms: number): Promise<void>;
}

export interface ActionDef {
  id: ActionId;
  key: string;
  label: string;
  /** The role the control API requires for the route behind it. */
  role: Role;
  /** Why the selection cannot take this action, or undefined when it can. */
  unavailable(context: RowContext): string | undefined;
  /** The question asked before anything happens. */
  prompt(context: RowContext): string;
  /** Does the work through the same routes as the CLI and returns the message to flash. */
  run(api: Api, context: RowContext): Promise<string>;
}

const rank = (role: Role): number => ROLES.indexOf(role);
/** Whether `role` covers `needed`. An unknown role (an older control without `whoami`) is allowed to try. */
export const roleAllows = (role: Role | undefined, needed: Role): boolean =>
  role === undefined || rank(role) >= rank(needed);

const ACTIVE_DEPLOYMENT = ['building', 'rolling_out'];
const COMMAND_TIMEOUT_MS = 60_000;

export const ACTIONS: ActionDef[] = [
  {
    id: 'restart',
    key: 'r',
    label: 'restart',
    role: 'deploy',
    unavailable: (c) =>
      c.project && c.service && c.service !== '(project)'
        ? undefined
        : 'select a service to restart',
    prompt: (c) => `Restart ${c.project}/${c.service} on every node that runs it?`,
    async run(api, c) {
      const created = await api.request<{ commandId: string }>('POST', '/api/v1/restart', {
        project: c.project,
        service: c.service,
      });
      const deadline = Date.now() + COMMAND_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const command = await api.request<{ state: string; result_json?: string | null } | null>(
          'GET',
          `/api/v1/commands/${encodeURIComponent(created.commandId)}`,
        );
        if (command?.state === 'succeeded') return `restarted ${c.project}/${c.service}`;
        if (command?.state === 'failed')
          throw new Error(
            (JSON.parse(command.result_json || '{}') as { error?: string }).error ??
              'restart failed',
          );
        await api.sleep(1000);
      }
      throw new Error(
        `restart of ${c.project}/${c.service} is still running; the screen will show the result`,
      );
    },
  },
  {
    id: 'rollback',
    key: 'R',
    label: 'roll back',
    role: 'deploy',
    unavailable: (c) => (c.project ? undefined : 'select a project to roll back'),
    prompt: (c) => `Roll ${c.project} back to its previous successful deployment?`,
    async run(api, c) {
      const response = await api.request<{ deployment: { id: string; state: string } }>(
        'POST',
        '/api/v1/rollback',
        { project: c.project, force: false },
      );
      return `rollback of ${c.project} started as deployment ${response.deployment.id}`;
    },
  },
  {
    id: 'cancel',
    key: 'x',
    label: 'cancel deployment',
    role: 'deploy',
    unavailable: (c) =>
      c.deployment && c.deploymentState && ACTIVE_DEPLOYMENT.includes(c.deploymentState)
        ? undefined
        : 'select a deployment that has not finished',
    prompt: (c) => `Cancel deployment ${c.deployment} of ${c.project}?`,
    async run(api, c) {
      await api.request(
        'POST',
        `/api/v1/deployments/${encodeURIComponent(c.deployment!)}/cancel`,
        {},
      );
      return `cancelled deployment ${c.deployment}`;
    },
  },
  {
    id: 'backup',
    key: 'b',
    label: 'back up now',
    role: 'deploy',
    unavailable: (c) => (c.project ? undefined : 'select a project or a backup target'),
    prompt: (c) =>
      c.backupTarget
        ? `Back up ${c.backupTarget} of ${c.project} now?`
        : `Back up every target of ${c.project} now?`,
    async run(api, c) {
      const queued = await api.request<{
        runs: { runId: string; target: string }[];
        errors: string[];
      }>('POST', '/api/v1/backups/run', {
        project: c.project,
        targets: c.backupTarget ? [c.backupTarget] : undefined,
      });
      if (!queued.runs.length)
        throw new Error(queued.errors.join('; ') || 'no backup target to run');
      return `queued ${queued.runs.map((run) => run.target).join(', ')}${queued.errors.length ? `; ${queued.errors.join('; ')}` : ''}`;
    },
  },
];

export const actionByKey = (key: string): ActionDef | undefined =>
  ACTIONS.find((action) => action.key === key);

/** Runs an action and reduces any failure to a message, so the screen never throws from a key press. */
export async function runAction(
  action: ActionDef,
  api: Api,
  context: RowContext,
): Promise<{ ok: boolean; message: string }> {
  try {
    return { ok: true, message: await action.run(api, context) };
  } catch (error) {
    return { ok: false, message: `${action.label} failed: ${errMessage(error)}` };
  }
}
