import fs from 'node:fs/promises';
import type { Command } from 'commander';
import * as yaml from 'js-yaml';
import { composeErrors } from '../compose.ts';
import { errMessage } from '../util.ts';
import type { ComposeFile } from '../protocol.ts';
import { defaultComposeFile } from './deploy.ts';

/** What `tug lint` found in one file: deploy's rejection reasons, or an empty list. */
export interface LintResult {
  file: string;
  /** One finding per rejected rule; none means the file passes. */
  errors: string[];
}

/** The prefix `tug lint` prints before every finding, so one line names both looks. */
const finding = (file: string, error: string) => `${file}: ${error}`;

/**
 * Reads `file` as YAML and runs the same `x-tug` schema checks deploy makes control apply, without
 * Docker, a control connection or a credential. The file is linted as written: `docker compose
 * config` expands short syntax when deploy normalizes, so short-form volumes are not reported here.
 */
export async function lintComposeFile(file: string): Promise<LintResult> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    return { file, errors: [`could not be read: ${errMessage(error)}`] };
  }
  let compose: ComposeFile | undefined;
  try {
    // An empty file parses to YAML null; report it below as a file without services.
    compose = (text.trim() ? yaml.load(text) : undefined) as ComposeFile | undefined;
  } catch (error) {
    return { file, errors: [`is not valid YAML: ${errMessage(error)}`] };
  }
  if (!compose?.services || typeof compose.services !== 'object')
    return { file, errors: ['compose file must define services'] };
  return { file, errors: composeErrors(compose, [], { normalized: false }) };
}

export function registerLint(program: Command): void {
  program
    .command('lint')
    .description(
      'check a Compose file against the x-tug schema without deploying or talking to control',
    )
    .option('-f, --file <file>', 'compose file', defaultComposeFile())
    .option('--json', 'print the findings as JSON for scripts and editors')
    .action(async (o: { file: string; json?: boolean }) => {
      const result = await lintComposeFile(o.file);
      if (o.json) {
        console.log(JSON.stringify({ ok: !result.errors.length, ...result }, null, 2));
      } else {
        // One finding per line on stderr, keeping any piped stdout clean for editors and scripts;
        // findings already name their service or volume, so the prefix only adds the file.
        for (const error of result.errors) console.error(finding(result.file, error));
      }
      if (result.errors.length) {
        process.exitCode = 1;
        return;
      }
      if (!o.json) console.log(`${result.file}: ok`);
    });
}
