import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as tar from 'tar';
import { scanArchive } from './archive.ts';
import { ensureDir, exists } from '../files.ts';
import { errMessage } from '../errors.ts';

export interface RunResult {
  out: string;
  err: string;
}
export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Kills the process after this long; defaults to {@link RUN_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** Longest a child process may run before it is killed, so a stalled build cannot hold the control writer forever. */
export const RUN_TIMEOUT_MS = 30 * 60 * 1000;
/** Per-stream cap on retained output; the tail is kept because failures are reported last. */
export const RUN_OUTPUT_LIMIT = 1024 * 1024;

const tail = (text: string, chunk: string) =>
  (text + chunk).length > RUN_OUTPUT_LIMIT ? (text + chunk).slice(-RUN_OUTPUT_LIMIT) : text + chunk;
/** The `build:` keys Tug passes to `docker build`; any other key is ignored. */
export const SUPPORTED_BUILD_KEYS = [
  'context',
  'dockerfile',
  'args',
  'target',
  'secrets',
  'additional_contexts',
] as const;

export interface BuildSpec {
  context?: string;
  dockerfile?: string;
  /** `--build-arg`: visible in the image history, so never a credential (use `secrets`). */
  args?: Record<string, unknown> | string[];
  target?: string;
  /** Keys of the top-level `secrets` exposed to `RUN --mount=type=secret`, as in Compose; never written to a layer. */
  secrets?: (string | { source?: string; target?: string })[];
  /** Named extra contexts for `COPY --from=<name>` and `FROM <name>`; needs `docker buildx`. */
  additional_contexts?: Record<string, unknown> | string[];
}

/** Context values that are not paths in the uploaded source: a URL, a git ref or an image. */
const REMOTE_CONTEXT = /^(?:https?:\/\/|git:\/\/|git@|ssh:\/\/|docker-image:\/\/|oci-layout:\/\/)/;

/** `additional_contexts` as `[name, value]` pairs, from either the mapping or the `name=value` list. */
export function additionalContexts(spec: BuildSpec): [string, string][] {
  const raw = spec.additional_contexts;
  if (!raw) return [];
  if (Array.isArray(raw))
    return raw.map((entry) => {
      const text = String(entry);
      const at = text.indexOf('=');
      return at < 1 ? [text, ''] : [text.slice(0, at), text.slice(at + 1)];
    });
  return Object.entries(raw).map(([name, value]) => [name, String(value ?? '')]);
}

/** `--build-arg` pairs; a name without a value is dropped, because Tug never reads the machine's environment for one. */
function buildArgPairs(spec: BuildSpec): [string, string][] {
  const raw = spec.args;
  if (!raw) return [];
  if (Array.isArray(raw))
    return raw.flatMap((entry): [string, string][] => {
      const text = String(entry);
      const at = text.indexOf('=');
      return at < 1 ? [] : [[text.slice(0, at), text.slice(at + 1)]];
    });
  return Object.entries(raw).flatMap(([name, value]): [string, string][] =>
    value === null || value === undefined ? [] : [[name, String(value)]],
  );
}

export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const { timeoutMs = RUN_TIMEOUT_MS, ...spawnOptions } = opts;
    const p = spawn(cmd, args, { ...spawnOptions, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '',
      err = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      p.kill('SIGKILL');
    }, timeoutMs);
    p.stdout.on('data', (d) => (out = tail(out, String(d))));
    p.stderr.on('data', (d) => (err = tail(err, String(d))));
    p.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut)
        reject(
          new Error(`${cmd} ${args.join(' ')} timed out after ${timeoutMs} ms\n${out}\n${err}`),
        );
      else if (code === 0) resolve({ out, err });
      else reject(new Error(`${cmd} ${args.join(' ')} failed (${code})\n${out}\n${err}`));
    });
  });
}

export async function unpackContext(tarball: string, dest: string): Promise<void> {
  await fs.rm(dest, { recursive: true, force: true });
  await ensureDir(dest);
  let expanded = 0;
  let entries = 0;
  await scanArchive(tarball, (entry) => {
    expanded += entry.size;
    entries++;
    if (
      expanded > 20 * 1024 ** 3 ||
      entries > 100000 ||
      path.isAbsolute(entry.path) ||
      entry.path.split('/').includes('..') ||
      !['File', 'Directory'].includes(entry.type)
    )
      throw new Error('source context has unsafe entries or exceeds expanded limits');
  });
  await tar.x({ file: tarball, cwd: dest, strict: true });
}

/** One secret mounted into a build: the BuildKit id the Dockerfile uses and the value control read. */
export interface BuildSecretValue {
  id: string;
  value: string;
}

export interface BuildImageOptions {
  contextDir: string;
  service: string;
  buildSpec: string | BuildSpec;
  imageRef: string;
  /** The environment `docker build` runs in; default this process's. */
  env?: NodeJS.ProcessEnv;
  /** The secrets a build mounts, by BuildKit id, resolved from the Compose declarations. Their values reach Docker only through its environment. */
  secrets?: BuildSecretValue[];
  /** Whether `docker buildx` is installed; checked with `docker buildx version` when not given. */
  hasBuildx?: () => Promise<boolean>;
}

/** The `docker` invocation of one build: its arguments and the environment that carries the secret values. */
export interface BuildCommand {
  args: string[];
  env: NodeJS.ProcessEnv;
}

const inside = (root: string, target: string) =>
  target === root || target.startsWith(`${root}${path.sep}`);

/**
 * The `docker build` (or `docker buildx build` for `additional_contexts`) arguments for a build spec. Secret values go into
 * environment variables that BuildKit reads with `--secret id=...,env=...`, never into the arguments, so they are not in
 * the process list, the command text of an error, or an image layer.
 */
export function buildCommand(
  options: Pick<BuildImageOptions, 'contextDir' | 'service' | 'buildSpec' | 'imageRef'> & {
    env?: NodeJS.ProcessEnv;
    secrets?: BuildSecretValue[];
  },
): BuildCommand {
  const { contextDir, service, buildSpec, imageRef } = options;
  const root = path.resolve(contextDir);
  const spec: BuildSpec =
    typeof buildSpec === 'string' ? { context: buildSpec } : (buildSpec ?? {});
  const buildPath = spec.context || '.';
  const dockerfilePath = spec.dockerfile
    ? path.resolve(contextDir, buildPath, spec.dockerfile)
    : undefined;
  if (dockerfilePath && !dockerfilePath.startsWith(`${root}${path.sep}`))
    throw new Error(`Dockerfile escapes uploaded root for ${service}`);
  const fullContext = path.resolve(contextDir, buildPath);
  if (!inside(root, fullContext))
    throw new Error(`build context escapes uploaded root for ${service}`);
  const args: string[] = [];
  if (dockerfilePath) args.push('-f', dockerfilePath);
  if (spec.target) args.push('--target', String(spec.target));
  for (const [name, value] of buildArgPairs(spec)) args.push('--build-arg', `${name}=${value}`);
  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env) };
  const secrets = options.secrets ?? [];
  secrets.forEach((secret, index) => {
    const variable = `TUG_BUILD_SECRET_${index}`;
    env[variable] = secret.value;
    args.push('--secret', `id=${secret.id},env=${variable}`);
  });
  const contexts = additionalContexts(spec);
  for (const [name, value] of contexts) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name) || !value)
      throw new Error(
        `build.additional_contexts entry ${JSON.stringify(name)} of ${service} needs a name and a value`,
      );
    if (/^service:/.test(value))
      throw new Error(
        `build.additional_contexts ${name} of ${service} points at another service (${value}), which Tug does not support; build that image in CI and use docker-image://<image> instead`,
      );
    if (REMOTE_CONTEXT.test(value)) args.push('--build-context', `${name}=${value}`);
    else {
      const local = path.resolve(contextDir, value);
      if (!inside(root, local))
        throw new Error(
          `build.additional_contexts ${name} of ${service} escapes the uploaded root`,
        );
      args.push('--build-context', `${name}=${local}`);
    }
  }
  if (secrets.length || contexts.length) env.DOCKER_BUILDKIT = '1';
  args.push('-t', imageRef, fullContext);
  return { args, env };
}

/** True when `docker buildx` answers; `additional_contexts` (`--build-context`) is a buildx feature. */
export async function dockerHasBuildx(env?: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    await run('docker', ['buildx', 'version'], { env, timeoutMs: 30_000 });
    return true;
  } catch {
    return false;
  }
}

/** `text` with every secret value replaced by `***`, for build output that is shown to the operator. */
function redact(text: string, secrets: readonly BuildSecretValue[] | undefined): string {
  let result = text;
  for (const { value } of secrets ?? []) if (value) result = result.split(value).join('***');
  return result;
}

export async function buildImage({
  contextDir,
  service,
  buildSpec,
  imageRef,
  env,
  secrets,
  hasBuildx,
}: BuildImageOptions): Promise<void> {
  const command = buildCommand({ contextDir, service, buildSpec, imageRef, env, secrets });
  const context = command.args.at(-1)!;
  if (!(await exists(context)))
    throw new Error(
      `build context not found for ${service}: ${path.relative(contextDir, context) || '.'}`,
    );
  const buildx = typeof buildSpec === 'object' && additionalContexts(buildSpec).length > 0;
  if (buildx && !(await (hasBuildx ?? (() => dockerHasBuildx(env)))()))
    throw new Error(
      `${service}: build.additional_contexts needs docker buildx, which is not installed where the image is built; install the Docker buildx plugin there, or remove additional_contexts`,
    );
  try {
    await run(
      'docker',
      [...(buildx ? ['buildx', 'build', '--load'] : ['build']), ...command.args],
      {
        env: command.env,
      },
    );
  } catch (error) {
    if (!secrets?.length) throw error;
    // Build output can echo a secret a Dockerfile printed; never hand that back to the operator.
    // No cause: it would carry the unredacted output.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(redact(errMessage(error), secrets));
  }
}
