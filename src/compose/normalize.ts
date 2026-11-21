// Operator-side Compose normalization, so control and agents only ever see the canonical definition. By default the
// native reader (load.ts) does it without Docker; `composeCli` (`tug deploy --compose-cli`) has `docker compose
// config` do the interpolation, `extends`, `env_file` merging and short-syntax expansion instead, for a file that
// uses something the native reader rejects. The CLI path reads Compose's YAML rendering: its `--format json` drops
// every service-level extension (`x-tug`), while the YAML rendering keeps them.
// Control secrets are not resolved on the operator's lifecycle: each one is interpolated as a sentinel
// that the agent replaces with the node's released value when it creates the container.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as yaml from 'js-yaml';
import { run } from '../images/build.ts';
import { loadCompose } from './load.ts';
import type { RunResult } from '../images/build.ts';
import type { ComposeFile } from '../protocol.ts';
import { secretSentinel } from './sentinel.ts';
import {
  canonicalSecrets,
  composeSecretErrors,
  secretDeclarationErrors,
  usedBuildSecrets,
} from './compose.ts';
import type { BuildSecretUse } from './compose.ts';

export type ComposeRunner = (
  cmd: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv },
) => Promise<RunResult>;

/**
 * Arguments of the `docker compose` call that renders `file` canonically (as YAML, which keeps `x-tug`).
 * `envFile` replaces Compose's own implicit `.env` next to the file, which Tug never reads.
 */
export function composeConfigArgs(file: string, project?: string, envFile?: string): string[] {
  return [
    'compose',
    ...(envFile ? ['--env-file', envFile] : []),
    '-f',
    file,
    ...(project ? ['-p', project] : []),
    'config',
    '--format',
    'yaml',
    '--no-path-resolution',
  ];
}

/**
 * `docker compose config` writes every literal `$` as `$$` so its output can be fed back to Compose. Tug does not
 * interpolate again, so a command like `sh -c 'echo $$HOME'` would reach the container with the doubled dollar,
 * where a shell reads `$$` as its own process ID. Undoing the escaping is exact: output never contains a bare `$`.
 */
export function unescapeDollars<T>(value: T): T {
  if (typeof value === 'string') return value.replaceAll('$$', '$') as T;
  if (Array.isArray(value)) return value.map(unescapeDollars) as T;
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, unescapeDollars(item)]),
    ) as T;
  return value;
}

const ENV_FILE_MESSAGE = (file: string) =>
  `${file}: a service uses env_file, which is not read: Tug takes values only from control, never from files on the deploy machine. Store its entries with tug secret import <file> (or tug var import), then list the ones the service needs under environment as ` +
  '${NAME}';

/** Environment variables `docker compose` needs to find Docker and nothing that can supply a value. */
const PASSTHROUGH = /^(PATH|HOME|USER|USERPROFILE|SYSTEMROOT|TMPDIR|TEMP|TMP|DOCKER_\w+)$/;

/**
 * The environment and `--env-file` for `docker compose config`: the operator's shell is scrubbed down to what
 * Docker itself needs, then only control's values and the explicit profiles are added, and Compose's implicit
 * `.env` is replaced by an empty file. `env_file` entries are refused, since Compose would read them.
 */
async function composeCliEnv(
  file: string,
  hostEnv: NodeJS.ProcessEnv,
  values: NodeJS.ProcessEnv,
  profiles: readonly string[],
): Promise<{ env: NodeJS.ProcessEnv; emptyEnvFile: string; cleanup: () => Promise<void> }> {
  const text = await fs.readFile(file, 'utf8').catch(() => '');
  if (/^[^#\n]*\benv_file\s*:/m.test(text)) throw new Error(ENV_FILE_MESSAGE(file));
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(hostEnv)) if (PASSTHROUGH.test(key)) env[key] = value;
  Object.assign(env, values);
  if (profiles.length) env.COMPOSE_PROFILES = profiles.join(',');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-compose-env-'));
  const emptyEnvFile = path.join(dir, 'empty.env');
  await fs.writeFile(emptyEnvFile, '');
  return { env, emptyEnvFile, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

/** The options of `normalizeCompose`. */
export { secretSentinel, sentinelNames, substituteSentinels } from './sentinel.ts';

export interface NormalizeOptions {
  project?: string;
  runner?: ComposeRunner;
  composeCli?: boolean;
  /** Variable values from control and `--var`; the only plain values the file can see. */
  vars?: Readonly<Record<string, string>>;
  /** Active profiles, in place of `COMPOSE_PROFILES`. */
  profiles?: readonly string[];
  /** The environment of the machine running the CLI, of which only what Docker needs reaches `docker compose`; default `process.env`. */
  hostEnv?: NodeJS.ProcessEnv;
  /** Called with the declarations a build uses and the local source each one names, which tug ignores. */
  onSecrets?: (uses: BuildSecretUse[]) => void;
}

/**
 * Reads `file` as `readCompose` does, checks its Compose secrets, and rewrites each used declaration to the canonical
 * form control receives, so a laptop path or a project-prefixed name never reaches the deployed file or its hash.
 */
export async function normalizeCompose(
  file: string,
  secretNames: readonly string[],
  options: NormalizeOptions = {},
): Promise<ComposeFile> {
  // A `name:` written as a variable reference is gone once the file is interpolated, so read the declarations as written.
  const written = await fs
    .readFile(file, 'utf8')
    .then((text) => yaml.load(text) as { secrets?: unknown } | undefined)
    .catch(() => undefined);
  const writtenErrors =
    written && typeof written === 'object' ? secretDeclarationErrors(written.secrets) : [];
  if (writtenErrors.length) throw new Error(`${file}: ${writtenErrors.join('; ')}`);
  const compose = await readCompose(file, secretNames, options);
  const errors = composeSecretErrors(compose);
  if (errors.length) throw new Error(`${file}: ${errors.join('; ')}`);
  options.onSecrets?.(usedBuildSecrets(compose));
  return canonicalSecrets(compose);
}

/**
 * Reads `file` and returns the definition. Every name in `secretNames` is set to its sentinel in the
 * environment, next to the `vars` control supplied; nothing is read from the deploy machine. `composeCli` (or `TUG_COMPOSE_CLI=1`) renders it with
 * `docker compose config` instead of the native reader.
 */
async function readCompose(
  file: string,
  secretNames: readonly string[],
  options: NormalizeOptions,
): Promise<ComposeFile> {
  // Nothing here comes from the deploy machine: not its shell, not `.env`, not `env_file`. The names control holds
  // are the whole environment, so two machines that run the same deploy read the same values.
  const env: NodeJS.ProcessEnv = { ...options.vars };
  for (const name of secretNames) env[name] = secretSentinel(name);
  const hostEnv = options.hostEnv ?? process.env;
  if (!(options.composeCli ?? hostEnv.TUG_COMPOSE_CLI === '1'))
    return loadCompose(file, {
      project: options.project,
      env,
      localSources: 'ignore',
      profiles: options.profiles ?? [],
    });
  const runner = options.runner ?? ((cmd, args, opts) => run(cmd, args, opts));
  let result: RunResult;
  const cliEnv = await composeCliEnv(file, hostEnv, env, options.profiles ?? []);
  try {
    result = await runner('docker', composeConfigArgs(file, options.project, cliEnv.emptyEnvFile), {
      env: cliEnv.env,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT' || /docker: .*not found/i.test(message))
      throw new Error(
        'tug deploy needs Docker with the Compose plugin on this lifecycle to read the Compose file (`docker compose config`); install Docker Compose v2',
        { cause: error },
      );
    throw new Error(`docker compose config failed for ${file}: ${message}`, { cause: error });
  } finally {
    await cliEnv.cleanup();
  }
  let parsed: ComposeFile;
  try {
    parsed = yaml.load(result.out) as ComposeFile;
  } catch (error) {
    throw new Error(`docker compose config returned unreadable output for ${file}`, {
      cause: error,
    });
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.services)
    throw new Error(`${file} defines no services`);
  return unescapeDollars(parsed);
}
