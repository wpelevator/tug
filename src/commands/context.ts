import { canPrompt } from '../cli-prompt.ts';
import { selectOne } from '../cli-selection.ts';
import type { ServiceChoice } from './selection.ts';
import { withProgress } from '../cli-progress.ts';
export { runCapture, runLocal } from '../cli-process.ts';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ResolvedCliConfig } from '../cli-config.ts';
import { createTransport } from '../agent-credential.ts';
import { createCliLiveTransport } from '../cli-live-transport.ts';
import { parseLiveRequest, runCliLive } from '../cli-live.ts';
import type { LiveInput, LiveRequest } from '../cli-live.ts';
import { TERMINAL_DEPLOYMENT_STATES } from '../protocol.ts';
import { describeFetchError, errMessage } from '../util.ts';
import type { DeploymentState } from '../protocol.ts';

// Templates live next to the commands' parent: src/templates in dev (`node src/cli.ts`), dist/templates in the
// built image (`node dist/cli.js`; tools/scripts/copy-templates.js puts them there).
export const templatesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'templates',
);

export interface DeploymentRecord {
  id: string;
  state: DeploymentState;
  error_message?: string | null;
}
export interface CommandRecord {
  state: string;
  result_json?: string | null;
}
export interface DeployResponse {
  deployment: DeploymentRecord;
  desiredState?: unknown;
}

/** One line for a person: which project and version reached which state, and how many services it runs. */
export function formatDeployment(response: DeployResponse): string {
  const { deployment } = response;
  const state = response.desiredState as
    { project?: string; version?: string; services?: Record<string, unknown> } | undefined;
  const services = Object.keys(state?.services ?? {}).length;
  const label = [state?.project, state?.version].filter(Boolean).join(' ');
  return `${label ? `${label}: ` : ''}deployment ${deployment.id} ${deployment.state}${
    services ? `, ${services} service${services === 1 ? '' : 's'}` : ''
  }${deployment.error_message ? ` (${deployment.error_message})` : ''}`;
}

/** Prints the full API result with `--json`, otherwise the human summary. */
export function printResult<T>(json: boolean | undefined, value: T, summary: (value: T) => string) {
  if (json) print(value);
  else console.log(summary(value));
}
export interface CommonOpts {
  project?: string;
}
export interface WaitOpts {
  wait: boolean;
  timeout: string;
}
export interface InstallOpts {
  buildLocalImage?: boolean;
  image?: string;
  installDocker?: boolean;
}

export const CONFIG_HELP =
  'CLI config file, YAML or JSON (default: TUG_CONFIG, else tug.yml, tug.yaml, tug.json or .tug.json)';

type Config = ResolvedCliConfig;
let resolvedConfig: Config | undefined;
/** Set by the root `preAction` hook before any command runs. */
export function setResolvedConfig(config: Config): void {
  resolvedConfig = config;
}
export async function loadCfg(): Promise<Config> {
  return resolvedConfig!;
}
export const collect = (v: string, a: string[]): string[] => [...a, v];
export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}
/** The pinned mTLS transport for the resolved credential; an address override only changes the connect target. */
export async function transportFor(c: Config) {
  if (!c.credential)
    throw new Error(
      'no credential: run `tug init <credential-file>`, set TUG_CREDENTIAL_FILE or pass --credential',
    );
  return createTransport(c.credential, c.controlUrl);
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function request<T = any>(
  method: string,
  route: string,
  body?: unknown,
  multipart = false,
): Promise<T> {
  const c = await loadCfg();
  const transport = await transportFor(c);
  const headers: Record<string, string> = {};
  if (!multipart) headers['content-type'] = 'application/json';
  try {
    let res: Response;
    try {
      res = await transport.http(`${transport.base}${route}`, {
        method,
        headers,
        body: multipart ? (body as FormData) : body ? JSON.stringify(body) : undefined,
      });
    } catch (error) {
      throw new Error(
        `${method} ${route}: could not reach control at ${transport.base}: ${describeFetchError(error)}`,
        { cause: error },
      );
    }
    if (!res.ok) throw new Error(`${method} ${route}: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  } finally {
    void transport.close();
  }
}
/** The project a project-scoped command works on: `--project`, then the resolved config, then `site`. */
export async function projectOf(o: CommonOpts): Promise<string> {
  return o.project || (await loadCfg()).project || 'site';
}
export const print = (value: unknown): void => console.log(JSON.stringify(value, null, 2));
export async function waitForDeployment(
  deploymentId: string,
  timeoutSeconds = 300,
  onProgress?: (deployment: DeploymentRecord) => void,
): Promise<DeploymentRecord> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    let deployment: DeploymentRecord;
    try {
      deployment = await request<DeploymentRecord>(
        'GET',
        `/api/v1/deployments/${encodeURIComponent(deploymentId)}`,
      );
    } catch (error) {
      throw new Error(
        `lost contact with control while waiting for deployment ${deploymentId} (${errMessage(error)}); it may still be rolling out: check tug status, or stop it with: tug deploy cancel ${deploymentId}`,
        { cause: error },
      );
    }
    onProgress?.(deployment);
    if ((TERMINAL_DEPLOYMENT_STATES as readonly string[]).includes(deployment.state)) {
      if (deployment.state !== 'succeeded')
        throw new Error(
          `deployment ${deploymentId} ${deployment.state}${deployment.error_message ? `: ${deployment.error_message}` : ''}`,
        );
      return deployment;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(
    `timed out waiting for deployment ${deploymentId}; it is still rolling out: check tug status, or stop it with: tug deploy cancel ${deploymentId}`,
  );
}
export async function waitForCommand(
  commandId: string,
  timeoutSeconds = 60,
): Promise<CommandRecord> {
  return withProgress(`Waiting for command ${commandId}`, async (progress) => {
    const deadline = Date.now() + timeoutSeconds * 1000;
    while (Date.now() < deadline) {
      const cmd = await request<CommandRecord | null>('GET', `/api/v1/commands/${commandId}`);
      if (cmd) progress.stage(`Command ${commandId}: ${cmd.state}`);
      if (cmd?.state === 'succeeded' || cmd?.state === 'failed') return cmd;
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`timed out waiting for command ${commandId}`);
  });
}
export async function runLive(
  operation: LiveRequest['operation'],
  input: Omit<LiveInput, 'project'>,
): Promise<void> {
  const cfg = await loadCfg();
  if (!input.node && canPrompt()) {
    const { services: listing } = await request<{ services: ServiceChoice[] }>(
      'GET',
      `/api/v1/services?project=${encodeURIComponent(cfg.project || 'site')}`,
    );
    const candidates = new Map(
      listing
        .filter((service) => operation === 'ps' || service.name === input.service)
        .flatMap((service) => service.nodes)
        .map((node) => [node.name, node]),
    );
    if (candidates.size > 1)
      input.node = await selectOne(undefined, 'Select a node for this operation', async () =>
        [...candidates.values()].map((node) => ({
          value: node.name,
          label: `${node.name} (${node.status})`,
        })),
      );
  }
  process.exitCode = await runCliLive(
    parseLiveRequest(operation, { ...input, project: cfg.project || 'site' }),
    createCliLiveTransport(cfg.credential, cfg.controlUrl),
  );
}
