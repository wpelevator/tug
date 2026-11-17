import fs from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import * as yaml from 'js-yaml';
import { composeErrors } from '../../compose/compose.ts';
import { errMessage } from '../../errors.ts';
import type { ComposeFile } from '../../protocol.ts';
import { defaultComposeFile } from './deploy.ts';
import { out, err } from '../runtime.ts';
import type { CliRuntime } from '../runtime.ts';

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
 * Docker, a control connection or a credential. The file is linted as written: deploy expands short
 * syntax when it reads the file, so short-form volumes are not reported here.
 */
export async function lintComposeFile(file: string, cwd: string): Promise<LintResult> {
  let text: string;
  try {
    text = await fs.readFile(path.resolve(cwd, file), 'utf8');
  } catch (error) {
    // Name the file as it was typed, as the error did when it was opened relative to the process directory.
    const reason = errMessage(error).split(path.resolve(cwd, file)).join(file);
    return { file, errors: [`could not be read: ${reason}`] };
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
  // `tug deploy` takes values only from control and refuses env_file, so lint says so before a deploy does.
  const envFiles = Object.entries(compose.services)
    .filter(([, service]) => service && typeof service === 'object' && 'env_file' in service)
    .map(
      ([name]) =>
        `${name}: env_file is not read by tug deploy (values come only from control); store its entries with tug secret import <file> or tug var import <file> and list them under environment`,
    );
  const others = composeErrors(compose, [], { normalized: false }).filter(
    (error) => !/: env_file is not supported$/.test(error),
  );
  return { file, errors: [...envFiles, ...others] };
}

export function registerLint(rt: CliRuntime, program: Command): void {
  program
    .command('lint')
    .description(
      'check a Compose file against the x-tug schema without deploying or talking to control',
    )
    .option('-f, --file <file>', 'compose file', defaultComposeFile(rt))
    .option('--json', 'print the findings as JSON for scripts and editors')
    .action(async (o: { file: string; json?: boolean }) => {
      const result = await lintComposeFile(o.file, rt.cwd);
      if (o.json) {
        out(rt, JSON.stringify({ ok: !result.errors.length, ...result }, null, 2));
      } else {
        // One finding per line on stderr, keeping any piped stdout clean for editors and scripts;
        // findings already name their service or volume, so the prefix only adds the file.
        for (const error of result.errors) err(rt, finding(result.file, error));
      }
      if (result.errors.length) {
        rt.exitCode = 1;
        return;
      }
      if (!o.json) out(rt, `${result.file}: ok`);
    });
}
