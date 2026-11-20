// The operator-side half of "control is the only source of deployment values": which `${NAME}` a Compose file
// references, which of them control holds (secrets, variables) or the command line supplies (`--var`), what is missing,
// and the record of where each came from. Nothing here reads the deploy machine's shell or `.env` for a value; `.env`
// is only looked at to tell the operator what Tug ignored.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as yaml from 'js-yaml';
import { parseDotenv } from '../compose/load.ts';
import { MAX_VAR_BYTES, RESERVED_VALUE_NAMES, VALUE_NAME, VALUE_NAME_MESSAGE } from '../values.ts';
import type { DeploymentValue } from '../values.ts';
import { prompter } from './prompt.ts';
import type { CliRuntime } from './runtime.ts';
import type { Prompter } from './prompt.ts';

/** `$$` is an escaped dollar; `${NAME}` is required only when it has no `:-`, `-`, `:+`, `+`, `:?` or `?` modifier. */
const REFERENCE = /\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;
/** Every reference, with or without a modifier; a name nested in a default (`${A:-${B}}`) is found by its own `${`. */
const ANY_REFERENCE = /\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)|\$([A-Za-z_][A-Za-z0-9_]*)/g;

function scan(source: string, pattern: RegExp): string[] {
  const names = new Set<string>();
  for (const line of source.split('\n')) {
    if (/^\s*#/.test(line)) continue;
    for (const match of line.matchAll(pattern)) {
      const name = match[1] ?? match[2];
      if (name) names.add(name);
    }
  }
  return [...names];
}

/**
 * The names a service lists under `environment` without a value, as `- KEY` or `KEY:`. Compose passes the value of
 * `KEY` through from the shell; Tug reads it from control instead, so such an entry is a reference like `${KEY}`.
 * `KEY: ""` and `- KEY=` carry a value (the empty string) and are not references.
 */
export function bareEnvironmentKeys(source: string): string[] {
  let doc: unknown;
  try {
    doc = yaml.load(source, { schema: yaml.CORE_SCHEMA.withTags([yaml.mergeTag]) });
  } catch {
    return [];
  }
  const names = new Set<string>();
  const services = (doc as { services?: unknown } | null)?.services;
  if (services && typeof services === 'object')
    for (const service of Object.values(services)) {
      const environment = (service as { environment?: unknown } | null)?.environment;
      if (Array.isArray(environment))
        for (const entry of environment) {
          if (typeof entry === 'string' && !entry.includes('=') && VALUE_NAME.test(entry.trim()))
            names.add(entry.trim());
        }
      else if (environment && typeof environment === 'object')
        for (const [key, value] of Object.entries(environment))
          if ((value === null || value === undefined) && VALUE_NAME.test(key)) names.add(key);
    }
  return [...names];
}

const merged = (first: string[], second: string[]): string[] => [...new Set([...first, ...second])];

/**
 * Variable names a Compose file requires, in order of appearance: `${NAME}` without a default, then bare `environment`
 * keys. Ones with a default are optional.
 */
export const requiredVariables = (source: string): string[] =>
  merged(scan(source, REFERENCE), bareEnvironmentKeys(source));

/** Every variable name a Compose file references, defaults and bare `environment` keys included, in order of appearance. */
export const referencedVariables = (source: string): string[] =>
  merged(scan(source, ANY_REFERENCE), bareEnvironmentKeys(source));

/** What control holds for a project, as the deploy needs it. */
export interface ProjectValues {
  secrets: { name: string; version: number }[];
  vars: { name: string; version: number; value: string }[];
}

/** Parses repeated `--var NAME=value` options; the first `=` splits, so values may contain `=`. */
export function parseVarFlags(entries: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of entries) {
    const at = entry.indexOf('=');
    if (at < 1) throw new Error(`--var ${entry} must be NAME=value`);
    const name = entry.slice(0, at);
    const value = entry.slice(at + 1);
    if (!VALUE_NAME.test(name)) throw new Error(`--var ${name}: ${VALUE_NAME_MESSAGE}`);
    if (RESERVED_VALUE_NAMES.includes(name)) throw new Error(`--var ${name} is reserved`);
    if (name in out) throw new Error(`--var ${name} is given twice`);
    if (Buffer.byteLength(value) > MAX_VAR_BYTES)
      throw new Error(`--var ${name} is larger than ${MAX_VAR_BYTES} bytes`);
    out[name] = value;
  }
  return out;
}

/** Variables a Compose file requires that control, `--var` and nothing else supplies. */
export async function findMissingValues(
  cwd: string,
  file: string,
  known: ReadonlySet<string>,
): Promise<string[]> {
  // An unreadable file is reported by the Compose reader with its own message.
  const source = await fs.readFile(path.resolve(cwd, file), 'utf8').catch(() => '');
  return requiredVariables(source).filter((name) => !known.has(name));
}

/**
 * For each missing name that appears (with a single `$`) inside an `x-tug.backup.*` string, that string. A backup
 * `command` or `restore` runs in the container, so `$NAME` there is almost always meant for the container's own
 * environment and needs `$$NAME`; Compose would otherwise ask control for a value.
 */
export function backupReferences(source: string, names: readonly string[]): Map<string, string> {
  const found = new Map<string, string>();
  let doc: unknown;
  try {
    doc = yaml.load(source, { schema: yaml.CORE_SCHEMA.withTags([yaml.mergeTag]) });
  } catch {
    return found;
  }
  const visitStrings = (node: unknown, fn: (text: string) => void): void => {
    if (typeof node === 'string') fn(node);
    else if (Array.isArray(node)) for (const item of node) visitStrings(item, fn);
    else if (node && typeof node === 'object')
      for (const item of Object.values(node)) visitStrings(item, fn);
  };
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node)) {
      if (key === 'x-tug' && child && typeof child === 'object' && 'backup' in child)
        visitStrings((child as { backup: unknown }).backup, (text) => {
          for (const name of requiredVariables(text))
            if (names.includes(name) && !found.has(name)) found.set(name, text);
        });
      else walk(child);
    }
  };
  walk(doc);
  return found;
}

/** `text` with each single-`$` reference to `name` doubled to `$$`, the line to put in the Compose file instead. */
export function escapeReference(text: string, name: string): string {
  return text.replace(
    new RegExp(`\\$\\$|\\$(\\{${name}\\}|${name}(?![A-Za-z0-9_]))`, 'g'),
    (match) => (match === '$$' ? match : `$${match}`),
  );
}

/**
 * The message for a deploy whose file needs values control does not hold. A name found inside an `x-tug.backup.*`
 * field gets the container-variable hint with the corrected line; the rest keep the standard guidance.
 */
export function missingValuesMessage(
  file: string,
  source: string,
  missing: readonly string[],
  dryRun: boolean,
): string {
  const inBackup = backupReferences(source, missing);
  const bare = bareEnvironmentKeys(source).filter((name) => missing.includes(name));
  const base = `${file} needs values that are not set on control: ${missing.join(', ')}. Tug does not read your shell environment or .env; set each with tug secret set <name> (private) or tug var set <name> (visible), pass --var NAME=value for this deploy only, or import a file with tug secret import .env${
    dryRun ? '' : ' (or run tug deploy in a terminal to be prompted)'
  }`;
  const bareHint = bare.length
    ? [
        `${bare.join(', ')} ${bare.length === 1 ? 'is' : 'are'} listed under environment without a value, which reads it from control like \${NAME}; to pass an empty string write NAME: "" instead`,
      ]
    : [];
  if (!inBackup.size) return [base, ...bareHint].join('\n');
  const hints = [...inBackup].map(
    ([name, text]) =>
      `${name} is used in an x-tug.backup field. If it is a variable of the container and not a value from control, write $$${name} so the container expands it: ${escapeReference(text, name).trim()}`,
  );
  return [base, ...bareHint, ...hints].join('\n');
}

/**
 * The record of where each name the file references got its value: a `--var`, a project secret or variable, or
 * nothing (the default written in the file). Order follows the file.
 */
export async function describeValues(
  cwd: string,
  file: string,
  sources: {
    secrets: ReadonlySet<string>;
    vars: ReadonlyMap<string, { version: number; value: string }>;
    flags: Readonly<Record<string, string>>;
  },
): Promise<DeploymentValue[]> {
  const source = await fs.readFile(path.resolve(cwd, file), 'utf8').catch(() => '');
  return referencedVariables(source).map((name): DeploymentValue => {
    if (name in sources.flags) return { name, source: '--var', value: sources.flags[name] };
    if (sources.secrets.has(name)) return { name, source: 'secret' };
    const variable = sources.vars.get(name);
    if (variable) return { name, source: 'var', version: variable.version, value: variable.value };
    return { name, source: 'default' };
  });
}

/** The names a `.env` next to the Compose file defines, or none when there is no such file. */
async function dotEnvNames(dir: string): Promise<string[]> {
  try {
    const text = await fs.readFile(path.join(dir, '.env'), 'utf8');
    return [
      ...new Set(
        text
          .split('\n')
          .map((line) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1])
          .filter((name): name is string => !!name),
      ),
    ];
  } catch {
    return [];
  }
}

/**
 * Notes about local sources Tug ignored, so a value that quietly went missing is explained: the `.env` next to the
 * file (with the names control does not hold) and `COMPOSE_PROFILES` in the shell.
 */
export async function ignoredSourceNotes(
  cwd: string,
  file: string,
  controlNames: ReadonlySet<string>,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const notes: string[] = [];
  const names = await dotEnvNames(path.dirname(path.resolve(cwd, file)));
  if (names.length) {
    const unset = names.filter((name) => !controlNames.has(name));
    const count = `${names.length} name${names.length === 1 ? '' : 's'}`;
    notes.push(
      unset.length
        ? `Ignored .env (Tug reads values only from control): ${count}, ${unset.length} not set there; tug secret import .env stores them`
        : `Ignored .env (Tug reads values only from control): ${count}, all already set there`,
    );
  }
  if (env.COMPOSE_PROFILES)
    notes.push(
      `Ignored COMPOSE_PROFILES=${env.COMPOSE_PROFILES} (Tug does not read your shell); select profiles with tug deploy --profile <name>`,
    );
  return notes;
}

/** A URL-safe random secret with 192 bits of entropy. */
export function generateSecret(): string {
  return crypto.randomBytes(24).toString('base64url');
}

/** A value to store for a name that was missing: a secret (never shown) or a variable (visible). */
export interface NewValue {
  kind: 'secret' | 'var';
  value: string;
}

/** Resolve each missing name interactively; returns what to store, and as which kind. */
export async function promptForValues(
  rt: CliRuntime,
  names: readonly string[],
  prompt: Prompter = prompter(rt),
): Promise<Record<string, NewValue>> {
  const values: Record<string, NewValue> = {};
  for (const name of names) {
    for (;;) {
      const choice = (
        await prompt(
          `${name} is not set on control. [g]enerate a strong secret, [e]nter it as a secret, or enter it as a [v]ariable (visible)? (g) `,
        )
      )
        .trim()
        .toLowerCase();
      if (choice === '' || choice === 'g') {
        values[name] = { kind: 'secret', value: generateSecret() };
        break;
      }
      if (choice === 'e' || choice === 'v') {
        const value = await prompt(`${name}: `, choice === 'e');
        if (value) {
          values[name] = { kind: choice === 'e' ? 'secret' : 'var', value };
          break;
        }
      }
    }
  }
  return values;
}

/** One entry of a dotenv file proposed for import. */
export interface ImportEntry {
  name: string;
  value: string;
  kind: 'secret' | 'var';
}

/**
 * The entries of a dotenv file and where each should go. Tug does not guess from a name or a value: an entry is
 * whatever `fallback` says (`secret` for `secret import`, `var` for `var import`) unless `vars` or `secrets` name it.
 * A bare `KEY` with no value is skipped.
 */
export function classifyEnvFile(
  text: string,
  options: {
    vars?: readonly string[];
    secrets?: readonly string[];
    fallback: 'secret' | 'var';
  },
): { entries: ImportEntry[]; skipped: string[] } {
  const parsed = parseDotenv(text, () => undefined);
  const entries: ImportEntry[] = [];
  const skipped: string[] = [];
  for (const [name, value] of Object.entries(parsed)) {
    if (value === null) {
      skipped.push(`${name} (no value)`);
      continue;
    }
    if (!VALUE_NAME.test(name) || RESERVED_VALUE_NAMES.includes(name)) {
      skipped.push(`${name} (not a usable name)`);
      continue;
    }
    const kind: 'secret' | 'var' = options.secrets?.includes(name)
      ? 'secret'
      : options.vars?.includes(name)
        ? 'var'
        : options.fallback;
    entries.push({ name, value, kind });
  }
  return { entries, skipped };
}
