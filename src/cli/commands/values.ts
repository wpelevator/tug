import fs from 'node:fs/promises';
import type { Command } from 'commander';
import { describeValues, requiredVariables } from '../values.ts';
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

/** Every name the file references, in order of appearance, resolved against what control holds. */
export async function projectValueRows(
  rt: CliRuntime,
  file: string,
  project: string,
): Promise<ValueRow[]> {
  const { secrets, vars } = await loadDeployValues(
    (method, route) => request(rt, method, route),
    project,
  );
  const described = await describeValues(rt.cwd, file, {
    secrets: new Set(secrets.map((secret) => secret.name)),
    vars: new Map(vars.map((row) => [row.name, { version: row.version, value: row.value }])),
    flags: {},
  });
  const source = await fs.readFile(resolvePath(rt, file), 'utf8').catch(() => '');
  const required = new Set(requiredVariables(source));
  return described.map((entry): ValueRow => {
    if (entry.source === 'secret') return { name: entry.name, status: 'secret' };
    if (entry.source === 'var') return { name: entry.name, status: 'var', value: entry.value };
    return { name: entry.name, status: required.has(entry.name) ? 'missing' : 'default' };
  });
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

export function registerValues(rt: CliRuntime, program: Command): void {
  program
    .command('values')
    .description(
      'list every ${NAME} and bare environment key the Compose file references, and whether control holds it as a secret, a variable, or neither',
    )
    .option('-f, --file <file>', 'compose file', defaultComposeFile(rt))
    .option('--json', 'print the rows as JSON')
    .action(async (o: CommonOpts & { file: string; json?: boolean }) => {
      const project = deployProject(rt, o);
      const rows = await projectValueRows(rt, o.file, project);
      const missing = rows.filter((row) => row.status === 'missing');
      if (o.json) out(rt, JSON.stringify({ project, values: rows }, null, 2));
      else
        out(
          rt,
          rows.length
            ? formatValueRows(rows)
            : `${o.file} references no values: nothing to set on control`,
        );
      if (missing.length) rt.exitCode = 1;
    });
}
