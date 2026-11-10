// Where a deployment's `${NAME}` values come from. Control is the only source: a name is a project secret (never
// shown, substituted by the agent), a project variable (`tug var`, visible, resolved when the deployment is created),
// a per-deploy `--var`, or the default written in the Compose file. The deploy machine's shell and `.env` are not read.
import { sentinelNames } from './compose/normalize.ts';
import type { ComposeFile } from './protocol.ts';

export type ValueSource = 'secret' | 'var' | '--var' | 'default';
export const VALUE_SOURCES: readonly ValueSource[] = ['secret', 'var', '--var', 'default'];

/** One referenced name of a deployment and what supplied it. `value` is set for variables and `--var`, never for secrets. */
export interface DeploymentValue {
  name: string;
  source: ValueSource;
  version?: number;
  value?: string;
}

/** The names a secret or variable may have: what Compose accepts after `$`. */
export const VALUE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const VALUE_NAME_MESSAGE =
  'names start with a letter or underscore and contain only letters, digits and underscores';

/** A project secret that the agent releases only for registry authentication; it cannot be a variable either. */
export const RESERVED_VALUE_NAMES: readonly string[] = ['TUG_REGISTRY_AUTH'];

/** The largest variable value, in bytes. Variables end up in the deployment record, so they stay configuration-sized. */
export const MAX_VAR_BYTES = 64 * 1024;

/**
 * Names that read like credentials (`DB_PASSWORD`, `S3_SECRET_KEY`, `AUTH_SALT`, `API_TOKEN`). A hint for imports and
 * `--var`, never a security boundary: the operator confirms the split.
 */
export function looksSensitive(name: string): boolean {
  return (
    /PASSWORD|PASSWD|PASSPHRASE|SECRET|TOKEN|CREDENTIAL|PRIVATE/i.test(name) ||
    name
      .toUpperCase()
      .split('_')
      .some((part) => part === 'KEY' || part === 'SALT' || part === 'AUTH' || part === 'PASS')
  );
}

/** The service fields in which the agent substitutes a secret and control never parses the result. */
const SECRET_FIELDS = new Set(['environment', 'command', 'entrypoint']);

/**
 * Places a secret sentinel appears that cannot take one: the agent only substitutes container environment, command,
 * entrypoint and health-check commands, and control parses everything else (`image`, `ports`, `volumes`, labels,
 * `x-tug`). Returns each as a dotted path, so the error can name the field and suggest `tug var`.
 */
export function misplacedSecrets(compose: ComposeFile): string[] {
  const found: string[] = [];
  const check = (path: string, value: unknown): void => {
    const names = sentinelNames(value);
    if (names.length) found.push(`${path} (${names.join(', ')})`);
  };
  for (const [name, service] of Object.entries(compose.services ?? {})) {
    for (const [key, value] of Object.entries(service as unknown as Record<string, unknown>)) {
      if (SECRET_FIELDS.has(key)) continue;
      if (key === 'healthcheck' && value && typeof value === 'object') {
        for (const [part, inner] of Object.entries(value as Record<string, unknown>))
          if (part !== 'test') check(`services.${name}.healthcheck.${part}`, inner);
        continue;
      }
      check(`services.${name}.${key}`, value);
    }
  }
  const { services: _services, ...rest } = compose as unknown as Record<string, unknown>;
  void _services;
  for (const [key, value] of Object.entries(rest)) check(key, value);
  return found;
}

/** `4 secrets, 2 vars, 1 --var (TAG), 1 default`: one line for the deploy output. */
export function summarizeValues(values: readonly DeploymentValue[]): string {
  if (!values.length) return 'none referenced';
  const count = (source: ValueSource) => values.filter((v) => v.source === source);
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const parts: string[] = [];
  const secrets = count('secret');
  if (secrets.length) parts.push(plural(secrets.length, 'secret', 'secrets'));
  const vars = count('var');
  if (vars.length) parts.push(plural(vars.length, 'var', 'vars'));
  const flags = count('--var');
  if (flags.length) parts.push(`${flags.length} --var (${flags.map((v) => v.name).join(', ')})`);
  const defaults = count('default');
  if (defaults.length) parts.push(plural(defaults.length, 'default', 'defaults'));
  return parts.join(', ');
}

/** A table of every referenced name for `deploy --dry-run`: secrets as bullets, variables with their values. */
export function formatValuesTable(values: readonly DeploymentValue[]): string {
  const rows = values.map((v) => [
    v.name,
    v.source,
    v.source === 'secret'
      ? '•••'
      : v.source === 'default'
        ? '(from the Compose file)'
        : (v.value ?? ''),
  ]);
  const header = ['NAME', 'SOURCE', 'VALUE'];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => c.padEnd(widths[i]))
      .join('  ')
      .trimEnd();
  return [line(header), ...rows.map(line)].join('\n');
}
