// Operator-side Compose normalization. `docker compose config` does the interpolation, `extends`,
// `env_file` merging and short-syntax expansion, so control and agents only ever see canonical JSON.
// The CLI reads Compose's YAML rendering: its `--format json` drops every service-level extension
// (`x-tug`), while the YAML rendering keeps them.
// Control secrets are not resolved on the operator's machine: each one is interpolated as a sentinel
// that the agent replaces with the node's released value when it creates the container.
import yaml from 'js-yaml';
import { run } from './build.ts';
import type { RunResult } from './build.ts';
import type { ComposeFile } from './protocol.ts';

export type ComposeRunner = (
  cmd: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv },
) => Promise<RunResult>;

const SECRET_NAME = '[A-Za-z_][A-Za-z0-9_]*';
const SENTINEL = new RegExp(`@@tug:secret:(${SECRET_NAME})@@`, 'g');

export const secretSentinel = (name: string): string => `@@tug:secret:${name}@@`;

/** Names of the control secrets that `value` references through sentinels, in order of appearance. */
export function sentinelNames(value: unknown): string[] {
  const names = new Set<string>();
  const visit = (v: unknown): void => {
    if (typeof v === 'string') for (const m of v.matchAll(SENTINEL)) names.add(m[1]);
    else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === 'object') Object.values(v).forEach(visit);
  };
  visit(value);
  return [...names];
}

/** `value` with every sentinel replaced by the secret's value; a sentinel with no value becomes empty. */
export function substituteSentinels(value: string, secrets: Record<string, string>): string {
  return value.replace(SENTINEL, (_all, name: string) => secrets[name] ?? '');
}

/** Arguments of the `docker compose` call that renders `file` canonically (as YAML, which keeps `x-tug`). */
export function composeConfigArgs(file: string, project?: string): string[] {
  return [
    'compose',
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
 * Renders `file` with Compose and returns the canonical definition. Every name in `secretNames` is set to
 * its sentinel in the environment, so it wins over a same-named local variable.
 */
export async function normalizeCompose(
  file: string,
  secretNames: readonly string[],
  options: { project?: string; runner?: ComposeRunner } = {},
): Promise<ComposeFile> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of secretNames) env[name] = secretSentinel(name);
  const runner = options.runner ?? ((cmd, args, opts) => run(cmd, args, opts));
  let result: RunResult;
  try {
    result = await runner('docker', composeConfigArgs(file, options.project), { env });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT' || /docker: .*not found/i.test(message))
      throw new Error(
        'tug deploy needs Docker with the Compose plugin on this machine to read the Compose file (`docker compose config`); install Docker Compose v2',
        { cause: error },
      );
    throw new Error(`docker compose config failed for ${file}: ${message}`, { cause: error });
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
  return parsed;
}
