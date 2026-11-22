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
  /** Things deploy accepts that are probably a mistake; they never fail the lint. */
  warnings?: string[];
}

/** Images that keep a database's files: a volume under one of these is the data, and losing it loses the app. */
const DATABASE_IMAGE =
  /^(?:.*\/)?(?:mysql|mariadb|percona|postgres|postgis|timescaledb|mongo|mongodb|redis|valkey|clickhouse|cassandra|couchdb|influxdb|cockroach)(?:[:@-]|$)/i;

/**
 * Volumes that hold data worth keeping but do not say `x-tug.persistent: true`: one a database service mounts, or one
 * that is a backup target. Without the flag `tug volume remove` does not treat it as precious. An explicit
 * `persistent: false` is a decision and silences the warning.
 */
export function persistentWarnings(compose: ComposeFile): string[] {
  const warnings: string[] = [];
  const volumes = compose.volumes && typeof compose.volumes === 'object' ? compose.volumes : {};
  const reasons = new Map<string, string>();
  for (const [name, volume] of Object.entries(volumes))
    if (volume && typeof volume === 'object' && volume['x-tug']?.backup)
      reasons.set(name, 'is a backup target');
  for (const [service, svc] of Object.entries(compose.services ?? {})) {
    if (!svc || typeof svc !== 'object' || typeof svc.image !== 'string') continue;
    if (!DATABASE_IMAGE.test(svc.image)) continue;
    for (const mount of svc.volumes ?? []) {
      const source = typeof mount === 'string' ? mount.split(':')[0] : mount?.source;
      if (typeof source === 'string' && source in volumes && !reasons.has(source))
        reasons.set(source, `backs the database service ${service}`);
    }
  }
  for (const [name, reason] of reasons) {
    const persistent = (volumes[name] as { 'x-tug'?: { persistent?: unknown } } | null)?.['x-tug']
      ?.persistent;
    if (persistent === undefined)
      warnings.push(
        `volumes.${name} ${reason} but is not marked x-tug.persistent: true; mark it so the intent is written down and tug volume remove keeps refusing without --delete-data even if the volume type changes (persistent: false says the data is disposable)`,
      );
  }
  return warnings;
}

/** `${NAME:-default}` and `${NAME-default}`, with no reference nested in the default. */
const DEFAULTED = /\$\{[A-Za-z_][A-Za-z0-9_]*:?-([^${}]*)\}/g;

/**
 * An `ingress.host` as deploy would read it with nothing set: each default is taken (nested ones from the inside out),
 * `$$` is one dollar. Undefined when a reference without a default remains, because its value is only known to control.
 */
export function hostWithDefaults(host: string): string | undefined {
  let text = host.replaceAll('$$', '\0');
  for (let previous = ''; previous !== text;) {
    previous = text;
    text = text.replace(DEFAULTED, '$1');
  }
  return /\$[{A-Za-z_]/.test(text) ? undefined : text.replaceAll('\0', '$');
}

/**
 * A copy of the file in which every `x-tug.ingress.host` is the name deploy would use: defaults filled in, and a host
 * that depends on a value without a default swapped for a valid placeholder, so only names that are known are checked.
 */
function withResolvedHosts(compose: ComposeFile): ComposeFile {
  const services: ComposeFile['services'] = {};
  for (const [name, svc] of Object.entries(compose.services)) {
    const ingress = svc && typeof svc === 'object' ? svc['x-tug']?.ingress : undefined;
    if (!ingress || typeof ingress !== 'object' || ingress.host === undefined) {
      services[name] = svc;
      continue;
    }
    let unknown = 0;
    const resolve = (host: unknown): unknown => {
      if (typeof host !== 'string') return host;
      return hostWithDefaults(host) ?? `value-from-control-${name}-${unknown++}.invalid`;
    };
    const host = Array.isArray(ingress.host) ? ingress.host.map(resolve) : resolve(ingress.host);
    services[name] = {
      ...svc,
      'x-tug': { ...svc['x-tug'], ingress: { ...ingress, host } },
    } as typeof svc;
  }
  return { ...compose, services };
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
  const others = composeErrors(withResolvedHosts(compose), [], { normalized: false }).filter(
    (error) => !/: env_file is not supported$/.test(error),
  );
  return { file, errors: [...envFiles, ...others], warnings: persistentWarnings(compose) };
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
        for (const warning of result.warnings ?? [])
          err(rt, `warning: ${finding(result.file, warning)}`);
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
