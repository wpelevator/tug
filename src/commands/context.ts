import { canPrompt } from '../cli-prompt.ts';
import { selectOne } from '../cli-selection.ts';
import type { ServiceChoice } from './selection.ts';
import { withProgress } from '../cli-progress.ts';
export { runCapture, runLocal } from '../cli-process.ts';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SKEW_CLIENT_NEWER, VERSION_STAMP_HEADER, compareMajMin, majorMinor } from '../protocol.ts';
import type { ResolvedCliConfig } from '../cli-config.ts';
import { createTransport } from '../agent-credential.ts';
import { createCliLiveTransport } from '../cli-live-transport.ts';
import { caTrustCode, describeCaMismatch } from '../pki.ts';
import { packageVersion } from '../image.ts';
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
/** Version agreements are remembered per control (base + trusted CA mark) per process. */
const versionChecked = new Set<string>();
/** Test isolation helper: forget the remembered version agreements. */
export function resetVersionChecks(): void {
  versionChecked.clear();
}
/** Cache key for one control: address override, base and the credential's CA mark (mismatches change the mark). The
 * process-local set never compares CAs across processes, so the raw values distinguish all it needs to, without
 * cryptographic work and without depending on fingerprintPem with corrupt input. */
function versionKey(c: Config): string {
  const credential = c.credential;
  if (!credential) return '';
  return `${new URL(credential.url).origin}|${c.controlUrl ?? ''}|${credential.ca}`;
}

/** Verdict of the version skew: an error to refuse on (this CLI ahead of the control), or a warning to print once.
 * `controlVersion` comes from the control's `x-tug-version` response stamp; undefined means the control predates
 * stamps and the route alike, which can only be an older control. */
export function versionVerdict(
  controlVersion: string | undefined,
  cliVersion: string,
  base: string,
): { error?: string; warning?: string } {
  const upgrade = 'upgrade the control plane with: tug control setup <control host> --yes';
  if (controlVersion === undefined)
    return {
      error: `the control at ${base} did not report a version; it is older than this CLI (${cliVersion}) — ${upgrade}`,
    };
  const control = majorMinor(controlVersion);
  const mine = majorMinor(cliVersion);
  if (!control || !mine)
    return {
      error: `the control at ${base} reported ${JSON.stringify(controlVersion)}, not a version — ${upgrade}`,
    };
  // The same strict-major.minor rule the control enforces in its version middleware, via the shared comparison.
  if (compareMajMin(control, mine) === -1)
    return {
      error: `the control at ${base} runs ${controlVersion}, this CLI is ${cliVersion}; its commands may rely on newer routes — ${upgrade}`,
    };
  if (compareMajMin(control, mine) === 1)
    return {
      warning: `note: this CLI is ${cliVersion} while the control at ${base} runs ${controlVersion}; update the CLI with: npm i -g @wpelevator/tug@${controlVersion}`,
    };
  return {};
}

/** Apply a decided skew verdict: the one-time warning and the refusal, shared by both judging paths. */
function applyVerdict(verdict: { error?: string; warning?: string }): void {
  if (verdict.warning) console.error(verdict.warning); // once per process: versionChecked gates the callers
  if (verdict.error) throw new Error(verdict.error);
}
/** A control refusal the client should take verbatim: the control's own wording is authoritative, so surface it
 * exactly instead of rewording it with route and status. Returns null when the body is not a skew refusal. */
function skewRefusalBody(text: string): string | null {
  let body: { error?: string; skew?: string } | undefined;
  try {
    body = JSON.parse(text) as { error?: string; skew?: string } | undefined;
  } catch {
    return null;
  }
  return body?.skew === SKEW_CLIENT_NEWER && typeof body.error === 'string' ? body.error : null;
}

/** Explicit skew probe for the flows the header cannot cover: a first request that mutates (the refusal must not
 * arrive after the harm is done) and flows with no HTTP request at all before acting (live commands, `node add`).
 * Deprecated-equivalent of the header check: read-first flows see the `x-tug-version` stamp within their own request.
 * One extra request per control per process; remember it per control (base + trusted CA mark) via versionChecked. */
export async function preflightVersion(c: Config): Promise<void> {
  const key = versionKey(c);
  if (!key || versionChecked.has(key)) return;
  const transport = createTransport(c.credential!, c.controlUrl);
  try {
    let res;
    try {
      res = await transport.http(`${transport.base}/api/v1/version`, { method: 'GET' });
    } catch (e) {
      // The preflight may be the first TLS connection a command opens, so the CA-mismatch diagnosis must happen HERE,
      // not only in request(): mapping it there would make the mismatch message unreachable in practice.
      const code = caTrustCode(e);
      throw new Error(
        `GET /api/v1/version: could not reach control at ${transport.base}: ` +
          (code
            ? `${describeCaMismatch(c.credential!, transport.base)} (${code})`
            : describeFetchError(e)),
        { cause: e },
      );
    }
    // The control refuses a client that declares itself newer before any handler runs; its own wording is
    // authoritative there. Without that marker, a 404/405 on a route a current control always keeps (or an origin
    // without the route at all) means the control predates the stamp: refused like a missing version. An
    // unclassified failure (401, 503) belongs to the command's own request and is left to surface its proper error
    // right after — and the control is left unremembered, so the next request probes again.
    if (!res.ok) {
      const refusal = skewRefusalBody(await res.text().catch(() => ''));
      if (refusal) throw new Error(refusal);
      if (res.status === 404 || res.status === 405)
        throw new Error(versionVerdict(undefined, packageVersion(), transport.base).error);
      return;
    }
    // Judged: remember the control for the rest of the process.
    versionChecked.add(key);
    // The probe judges the same stamp the read path does; a stampless 200 without the `{ v }` route's own stamp is
    // refused the same as on the read path, keeping one rule for both directions of the check.
    applyVerdict(
      versionVerdict(
        res.headers.get(VERSION_STAMP_HEADER) ?? undefined,
        packageVersion(),
        transport.base,
      ),
    );
  } finally {
    void transport.close();
  }
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
  if (!c.credential)
    throw new Error(
      'no credential: run `tug init <credential-file>`, set TUG_CREDENTIAL_FILE or pass --credential',
    );
  const key = versionKey(c);
  const unseen = !!key && !versionChecked.has(key);
  // The skew check rides on ordinary traffic: a read's response carries the control's `x-tug-version` stamp and is
  // judged after the fact (reads are safe to have run against an old control). A mutating first request is judged
  // BEFORE it is sent, against the version route, because the harm of new-CLI-old-control semantics is already done
  // once the old control received the mutation.
  const firstRead = unseen && method === 'GET';
  if (unseen && method !== 'GET') await preflightVersion(c);
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
      const mismatch = caTrustCode(error);
      if (mismatch)
        throw new Error(
          `${method} ${route}: could not reach control at ${transport.base}: ${describeCaMismatch(c.credential!, transport.base)} (${mismatch})`,
          { cause: error },
        );
      throw new Error(
        `${method} ${route}: could not reach control at ${transport.base}: ${describeFetchError(error)}`,
        { cause: error },
      );
    }
    if (firstRead) {
      // First read answered: judge the stamp here so the refusal (or one-time pin warning) lands before the command
      // does anything else with the control. Missing or garbage stamps get the same verdict as an old control.
      versionChecked.add(key!);
      applyVerdict(
        versionVerdict(
          res.headers.get(VERSION_STAMP_HEADER) ?? undefined,
          packageVersion(),
          transport.base,
        ),
      );
    }
    if (!res.ok) {
      // A control may refuse the request itself when this CLI is newer than it; its own wording is authoritative.
      const text = await res.text().catch(() => '');
      throw new Error(skewRefusalBody(text) ?? `${method} ${route}: ${res.status} ${text}`);
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
  // Commands that skip the HTTP service listing (an explicit service name) would otherwise reach an old control on the
  // live channel alone; the same per-control preflight as ordinary API requests applies here.
  await preflightVersion(cfg);
  process.exitCode = await runCliLive(
    parseLiveRequest(operation, { ...input, project: cfg.project || 'site' }),
    createCliLiveTransport(cfg.credential, cfg.controlUrl),
  );
}
