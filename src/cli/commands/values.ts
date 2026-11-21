import fs from 'node:fs/promises';
import type { Command } from 'commander';
import { buildSecretProblems, describeValues, requiredVariables } from '../values.ts';
import { describeBuildSecret } from '../../compose/compose.ts';
import type { BuildSecretUse } from '../../compose/compose.ts';
import { normalizeCompose } from '../../compose/normalize.ts';
import { defaultComposeFile, deployProject, loadDeployValues } from './deploy.ts';
import { request } from './context.ts';
import type { CommonOpts } from './context.ts';
import { out } from '../runtime.ts';
import { resolvePath } from '../runtime.ts';
import type { CliRuntime } from '../runtime.ts';

/** What one name the Compose file references resolves to with nothing but control's values. */
export interface ValueRow {
  name: string;
  /** `secret` and `var` are set on control; `default` falls back to the file; `missing` fails a deploy. */
  status: 'secret' | 'var' | 'default' | 'missing';
  value?: string;
}

/** A Compose secret a build uses: its mapping to a tug secret, and whether control holds that secret. */
export interface BuildSecretRow extends BuildSecretUse {
  status: 'set' | 'missing';
  /** What to run, when the secret is missing. */
  problem?: string;
}

/** Every name the file references, in order of appearance, resolved against what control holds. */
export async function projectValueRows(
  rt: CliRuntime,
  file: string,
  project: string,
): Promise<{ rows: ValueRow[]; buildSecrets: BuildSecretRow[] }> {
  const { secrets, vars } = await loadDeployValues(
    (method, route) => request(rt, method, route),
    project,
  );
  const secretNames = new Set(secrets.map((secret) => secret.name));
  const described = await describeValues(rt.cwd, file, {
    secrets: secretNames,
    vars: new Map(vars.map((row) => [row.name, { version: row.version, value: row.value }])),
    flags: {},
  });
  const source = await fs.readFile(resolvePath(rt, file), 'utf8').catch(() => '');
  const required = new Set(requiredVariables(source));
  const rows = described.map((entry): ValueRow => {
    if (entry.source === 'secret') return { name: entry.name, status: 'secret' };
    if (entry.source === 'var') return { name: entry.name, status: 'var', value: entry.value };
    return { name: entry.name, status: required.has(entry.name) ? 'missing' : 'default' };
  });
  // The Compose secrets need the file read, which fails while a required value is missing: the table says that first.
  let uses: BuildSecretUse[] = [];
  try {
    await normalizeCompose(resolvePath(rt, file), [...secretNames], {
      project,
      hostEnv: rt.env,
      vars: Object.fromEntries(vars.map((row) => [row.name, row.value])),
      onSecrets: (found) => {
        uses = found;
      },
    });
  } catch {
    uses = [];
  }
  const varNames = new Set(vars.map((row) => row.name));
  const buildSecrets = uses.map((use): BuildSecretRow => {
    const [problem] = buildSecretProblems([use], secretNames, varNames);
    return { ...use, status: problem ? 'missing' : 'set', ...(problem ? { problem } : {}) };
  });
  return { rows, buildSecrets };
}

/** The table `tug values` prints: secrets as bullets, variables with their values, and what each missing name needs. */
export function formatValueRows(rows: readonly ValueRow[]): string {
  const cells = rows.map((row) => [
    row.name,
    row.status,
    row.status === 'secret'
      ? '•••'
      : row.status === 'var'
        ? (row.value ?? '')
        : row.status === 'default'
          ? '(default from the Compose file)'
          : `not set: tug secret set ${row.name}, or tug var set ${row.name}`,
  ]);
  const header = ['NAME', 'STATUS', 'VALUE'];
  const widths = header.map((h, i) => Math.max(h.length, ...cells.map((r) => r[i].length)));
  const line = (row: string[]) =>
    row
      .map((c, i) => c.padEnd(widths[i]))
      .join('  ')
      .trimEnd();
  return [line(header), ...cells.map(line)].join('\n');
}

/** The Compose secrets a build uses, one line each with the mapping and, when missing, the command that sets it. */
export function formatBuildSecrets(rows: readonly BuildSecretRow[]): string {
  return rows
    .map((row) => `build secret  ${row.status === 'set' ? describeBuildSecret(row) : row.problem}`)
    .join('\n');
}

export function registerValues(rt: CliRuntime, program: Command): void {
  program
    .command('values')
    .description(
      'list every ${NAME} and bare environment key the Compose file references, and whether control holds it as a secret, a variable, or neither; also the Compose secrets a build uses and the tug secret each maps to',
    )
    .option('-f, --file <file>', 'compose file', defaultComposeFile(rt))
    .option('--json', 'print the rows as JSON')
    .action(async (o: CommonOpts & { file: string; json?: boolean }) => {
      const project = deployProject(rt, o);
      const { rows, buildSecrets } = await projectValueRows(rt, o.file, project);
      const missing =
        rows.some((row) => row.status === 'missing') ||
        buildSecrets.some((row) => row.status === 'missing');
      if (o.json) out(rt, JSON.stringify({ project, values: rows, buildSecrets }, null, 2));
      else {
        out(
          rt,
          rows.length
            ? formatValueRows(rows)
            : `${o.file} references no values: nothing to set on control`,
        );
        if (buildSecrets.length) out(rt, formatBuildSecrets(buildSecrets));
      }
      if (missing) rt.exitCode = 1;
    });
}
