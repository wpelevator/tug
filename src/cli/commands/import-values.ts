import fs from 'node:fs/promises';
import { ask, canPrompt } from '../prompt.ts';
import { classifyEnvFile } from '../values.ts';
import type { ImportEntry } from '../values.ts';
import { projectOf, request } from './context.ts';
import type { CommonOpts } from './context.ts';

const word = (kind: 'secret' | 'var'): string => (kind === 'var' ? 'variable' : 'secret');

export interface ImportOpts extends CommonOpts {
  vars: string[];
  secrets: string[];
  select?: boolean;
  overwrite?: boolean;
  yes?: boolean;
}

/**
 * `secret import` and `var import`: store each entry of a dotenv file in the project. `secret import` sorts: in a
 * terminal names that look like credentials are proposed as secrets and the rest as variables, and the operator
 * confirms or edits the split; without a terminal an entry is a secret unless `--vars` names it, the safe default.
 * `var import` makes every entry a variable unless `--secrets` names it. Values are never printed, and a name that
 * already exists is skipped unless `--overwrite`.
 */
export async function importValues(
  file: string | undefined,
  o: ImportOpts,
  mode: 'secret' | 'var',
): Promise<void> {
  const project = await projectOf(o);
  const path = file ?? '.env';
  let text: string;
  try {
    text = await fs.readFile(path, 'utf8');
  } catch (error) {
    throw new Error(`could not read ${path}: ${(error as Error).message}`, { cause: error });
  }
  const interactive = canPrompt();
  const sorted = mode === 'secret' && interactive;
  const { entries, skipped } = classifyEnvFile(text, {
    vars: o.vars,
    secrets: o.secrets,
    sorted,
    fallback: mode,
  });
  const query = `?project=${encodeURIComponent(project)}`;
  const [{ secrets }, { vars }] = await Promise.all([
    request<{ secrets: { name: string }[] }>('GET', `/api/v1/secrets${query}`),
    request<{ vars: { name: string }[] }>('GET', `/api/v1/vars${query}`),
  ]);
  const existing = new Map<string, 'secret' | 'var'>([
    ...secrets.map((row) => [row.name, 'secret'] as const),
    ...vars.map((row) => [row.name, 'var'] as const),
  ]);
  const unknown = [...o.vars, ...o.secrets].filter((name) => !entries.some((e) => e.name === name));
  if (unknown.length) throw new Error(`${path} has no entry named ${unknown.join(', ')}`);
  let todo: ImportEntry[] = [];
  const notes: string[] = skipped.map((reason) => `skipped ${reason}`);
  for (const entry of entries) {
    const there = existing.get(entry.name);
    if (there && (there !== entry.kind || !o.overwrite)) {
      notes.push(
        there === entry.kind
          ? `skipped ${entry.name}: already a ${word(there)} (use --overwrite to replace it)`
          : `skipped ${entry.name}: already a ${word(there)}, not a ${word(entry.kind)}; remove it first with tug ${there} remove ${entry.name}`,
      );
      continue;
    }
    todo.push(entry);
  }
  if (!todo.length) {
    for (const note of notes) console.error(note);
    console.log(`nothing to import from ${path}`);
    return;
  }
  if (interactive && !o.yes) {
    if (o.select) {
      const chosen: ImportEntry[] = [];
      for (const entry of todo) {
        const answer = (
          await ask(
            `${entry.name} → ${entry.kind}. [s]ecret, [v]ariable, e[x]clude, or Enter to keep ${entry.kind}? `,
          )
        )
          .trim()
          .toLowerCase();
        if (answer === 'x') continue;
        chosen.push({
          ...entry,
          kind: answer === 's' ? 'secret' : answer === 'v' ? 'var' : entry.kind,
        });
      }
      todo = chosen;
    } else {
      console.error(`From ${path} into project ${project}:`);
      for (const entry of todo) console.error(`  ${entry.name.padEnd(32)} ${word(entry.kind)}`);
      const answer = (await ask(`Store these ${todo.length}? [Y/n] `)).trim().toLowerCase();
      if (answer === 'n' || answer === 'no') {
        console.error('nothing stored');
        return;
      }
    }
  }
  for (const note of notes) console.error(note);
  for (const entry of todo) {
    const result = await request<{ version: number }>(
      'POST',
      entry.kind === 'secret' ? '/api/v1/secrets' : '/api/v1/vars',
      { project, name: entry.name, value: entry.value },
    );
    console.log(
      `${entry.name.padEnd(32)} ${word(entry.kind).padEnd(8)} stored (version ${result.version})`,
    );
  }
}
