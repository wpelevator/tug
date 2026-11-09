// Native Compose reader: turns a Compose file into the canonical definition that `validateCompose`, control and the
// agents consume, without Docker or the Compose plugin. It covers what `docker compose config --format yaml` did for
// the keys Tug accepts: variable interpolation (process environment, then `.env`), `env_file`, `extends`, profiles,
// and the expansion of short syntax into the long form. A construct it does not implement (`include`, `!reset` and
// `!override` tags, a raw `env_file` format) is rejected with `UnsupportedComposeError` instead of being read halfway;
// `tug deploy --compose-cli` hands such a file to `docker compose config`.
// Control secrets arrive as sentinels in `env` (see normalize.ts) and flow through interpolation like any variable.
import fs from 'node:fs/promises';
import path from 'node:path';
import * as yaml from 'js-yaml';
import type { ComposeFile } from '../protocol.ts';
import { composeDurationMs, formatDuration, sizeBytes } from './units.ts';

/** A Compose construct the native reader does not implement. The file is not read at all, so nothing is silently lost. */
export class UnsupportedComposeError extends Error {
  constructor(message: string) {
    super(
      `${message}; rerun with \`tug deploy --compose-cli\` to read the file with \`docker compose config\``,
    );
    this.name = 'UnsupportedComposeError';
  }
}

export interface LoadOptions {
  /** The Tug project: it is the `name` of the result, as `docker compose -p` made it. */
  project?: string;
  /** Variables for interpolation; defaults to `process.env`. Secret sentinels are set here by the caller. */
  env?: NodeJS.ProcessEnv;
}

type Lookup = (name: string) => string | undefined;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = Record<string, any>;

/** YAML 1.2 core types (`yes` stays a string) plus `<<` merge keys, which Compose files use with anchors. */
const SCHEMA = yaml.CORE_SCHEMA.withTags([yaml.mergeTag]);

const isObject = (value: unknown): value is Obj =>
  !!value && typeof value === 'object' && !Array.isArray(value);

// ---- Interpolation -------------------------------------------------------------------------------------------------

const NAME = /^[A-Za-z_][A-Za-z0-9_]*/;

function braced(body: string, lookup: Lookup, source: string): string {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?+])([\s\S]*))?$/.exec(body);
  if (!m) throw new Error(`invalid interpolation format for "${source}": \${${body}}`);
  const [, name, op, rest = ''] = m;
  const value = lookup(name);
  const empty = value === undefined || value === '';
  const colon = op?.startsWith(':');
  const unset = colon ? empty : value === undefined;
  switch (op?.slice(-1)) {
    case '-':
      return unset ? interpolate(rest, lookup) : (value as string);
    case '+':
      return unset ? '' : interpolate(rest, lookup);
    case '?':
      if (unset)
        throw new Error(
          `required variable ${name} is missing a value${rest ? `: ${interpolate(rest, lookup)}` : ''}`,
        );
      return value as string;
    default:
      return value ?? '';
  }
}

/**
 * Compose interpolation of one string: `$$` is a literal dollar, `$NAME` and `${NAME}` substitute (an unset variable is
 * empty), and `${NAME:-d}`, `-`, `:?`, `?`, `:+`, `+` apply their default, error or replacement, nested to any depth.
 * The result is final: a `$` it contains is literal and is not interpolated again.
 */
export function interpolate(input: string, lookup: Lookup): string {
  let out = '';
  let i = 0;
  while (i < input.length) {
    if (input[i] !== '$') {
      out += input[i++];
      continue;
    }
    const next = input[i + 1];
    if (next === '$') {
      out += '$';
      i += 2;
    } else if (next === '{') {
      let depth = 1;
      let j = i + 2;
      while (j < input.length && depth) {
        if (input[j] === '$' && input[j + 1] === '{') {
          depth++;
          j += 2;
        } else {
          if (input[j] === '}') depth--;
          j++;
        }
      }
      if (depth)
        throw new Error(`invalid interpolation format for "${input}": missing closing brace`);
      out += braced(input.slice(i + 2, j - 1), lookup, input);
      i = j;
    } else {
      const m = NAME.exec(input.slice(i + 1));
      if (!m)
        throw new Error(`invalid interpolation format for "${input}"; write $$ for a literal $`);
      out += lookup(m[0]) ?? '';
      i += 1 + m[0].length;
    }
  }
  return out;
}

function interpolateDeep<T>(value: T, lookup: Lookup): T {
  if (typeof value === 'string') return interpolate(value, lookup) as T;
  if (Array.isArray(value)) return value.map((item) => interpolateDeep(item, lookup)) as T;
  if (isObject(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, interpolateDeep(item, lookup)]),
    ) as T;
  return value;
}

// ---- dotenv --------------------------------------------------------------------------------------------------------

/**
 * Parses a `.env` or `env_file`: `KEY=value`, `export KEY=value`, `#` comments (also after an unquoted value),
 * single-quoted values taken literally, double-quoted values with `\n`, `\t`, `\"`, `\\` escapes. Values other than
 * single-quoted ones are interpolated with the keys defined above them first, then `lookup`. A bare `KEY` maps to
 * `null` so the caller can take it from the environment.
 */
export function parseDotenv(text: string, lookup: Lookup): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  const scope: Lookup = (name) =>
    name in out && out[name] !== null ? (out[name] as string) : lookup(name);
  const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r?\n/);
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n].replace(/^\s*(?:export\s+)/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Za-z0-9_.-]+)\s*(?:=\s*([\s\S]*))?$/.exec(line);
    if (!m) throw new Error(`invalid line ${n + 1} in env file: ${line.split('=')[0]}`);
    const [, key, raw] = m;
    if (raw === undefined) {
      out[key] = null;
      continue;
    }
    let rest = raw;
    if (rest.startsWith("'")) {
      // Literal, possibly spanning lines until the closing quote.
      let body = rest.slice(1);
      while (!body.includes("'") && n + 1 < lines.length) body += `\n${lines[++n]}`;
      const end = body.indexOf("'");
      if (end < 0) throw new Error(`unterminated single quote for ${key} in env file`);
      out[key] = body.slice(0, end);
    } else if (rest.startsWith('"')) {
      let body = rest.slice(1);
      const closing = (s: string) => /(^|[^\\])(\\\\)*"/.test(s);
      while (!closing(body) && n + 1 < lines.length) body += `\n${lines[++n]}`;
      let value = '';
      let i = 0;
      for (; i < body.length && body[i] !== '"'; i++) {
        if (body[i] === '\\' && i + 1 < body.length) {
          const c = body[++i];
          value += c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c === '$' ? '$$' : c;
        } else value += body[i];
      }
      if (i >= body.length) throw new Error(`unterminated double quote for ${key} in env file`);
      out[key] = interpolate(value, scope);
    } else {
      rest = rest.replace(/(^|\s)#.*$/, '').trim();
      out[key] = interpolate(rest, scope);
    }
  }
  return out;
}

// ---- Short syntax --------------------------------------------------------------------------------------------------

/** Splits a `command` string the way Compose does (words, quotes, backslashes) without any variable expansion. */
export function shellSplit(input: string): string[] {
  const words: string[] = [];
  let word = '';
  let started = false;
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quote === "'") {
      if (c === "'") quote = undefined;
      else word += c;
    } else if (c === '\\') {
      if (i + 1 >= input.length) throw new Error(`invalid command line string "${input}"`);
      word += input[++i];
      started = true;
    } else if (quote === '"') {
      if (c === '"') quote = undefined;
      else word += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      started = true;
    } else if (/\s/.test(c)) {
      if (started || word) words.push(word);
      word = '';
      started = false;
    } else if (';&|<>'.includes(c)) {
      // Compose silently drops everything from here on, which turns `a && b` into `a`. Say so instead.
      throw new Error(
        `command "${input}" uses the shell operator ${c}, which a command string does not run; use a list or sh -c '…'`,
      );
    } else {
      word += c;
      started = true;
    }
  }
  if (quote) throw new Error(`invalid command line string "${input}": unterminated quote`);
  if (started || word) words.push(word);
  return words;
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(String) : value == null ? [] : [String(value)];

function command(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  return typeof value === 'string' ? shellSplit(value) : strings(value);
}

/** `KEY=value` or bare `KEY` entries, or a mapping, as a mapping of strings; `fromEnv` resolves values left empty. */
function keyValues(value: unknown, fromEnv?: Lookup): Record<string, string | null> | undefined {
  if (value === undefined || value === null) return undefined;
  const out: Record<string, string | null> = {};
  const set = (key: string, v: unknown) => {
    if (v === undefined || v === null) out[key] = fromEnv ? (fromEnv(key) ?? null) : '';
    else out[key] = String(v);
  };
  if (Array.isArray(value))
    for (const entry of value) {
      const text = String(entry);
      const at = text.indexOf('=');
      if (at < 0) set(text, undefined);
      else out[text.slice(0, at)] = text.slice(at + 1);
    }
  else if (isObject(value)) for (const [key, v] of Object.entries(value)) set(key, v);
  else throw new Error('expected a list or a mapping');
  return out;
}

const PORT = /^\d+$/;

function portRange(text: string, what: string): number[] {
  const [from, to = from] = text.split('-');
  if (!PORT.test(from) || !PORT.test(to) || Number(to) < Number(from))
    throw new Error(`invalid ${what} port "${text}"`);
  const ports: number[] = [];
  for (let p = Number(from); p <= Number(to); p++) ports.push(p);
  return ports;
}

/** One `ports` entry (short syntax, a bare number or a long-syntax mapping) as the long-syntax entries it stands for. */
function portEntries(entry: unknown): Obj[] {
  if (isObject(entry))
    return [
      {
        mode: 'ingress',
        ...(entry.host_ip ? { host_ip: String(entry.host_ip) } : {}),
        target: Number(entry.target),
        ...(entry.published !== undefined && entry.published !== ''
          ? { published: String(entry.published) }
          : {}),
        protocol: entry.protocol ?? 'tcp',
        ...Object.fromEntries(
          Object.entries(entry).filter(
            ([key]) => !['mode', 'host_ip', 'target', 'published', 'protocol'].includes(key),
          ),
        ),
      },
    ];
  const text = String(entry);
  const [spec, protocol = 'tcp'] = text.split('/');
  if (!['tcp', 'udp', 'sctp'].includes(protocol))
    throw new Error(`invalid port "${text}": unknown protocol ${protocol}`);
  const parts: string[] = [];
  let current = '';
  let inBrackets = false;
  for (const c of spec) {
    if (c === '[') inBrackets = true;
    if (c === ']') inBrackets = false;
    if (c === ':' && !inBrackets) {
      parts.push(current);
      current = '';
    } else current += c;
  }
  parts.push(current);
  if (parts.length > 3) throw new Error(`invalid port "${text}"`);
  const target = portRange(parts[parts.length - 1], 'container');
  const published =
    parts.length >= 2 && parts[parts.length - 2] !== '' ? parts[parts.length - 2] : undefined;
  const hostIp = parts.length === 3 ? parts[0].replace(/^\[|\]$/g, '') : undefined;
  const host = published ? portRange(published, 'published') : undefined;
  if (host && host.length !== 1 && host.length !== target.length)
    throw new Error(
      `invalid port "${text}": the published range must be as long as the container range`,
    );
  return target.map((port, index) => ({
    mode: 'ingress',
    ...(hostIp ? { host_ip: hostIp } : {}),
    target: port,
    ...(host
      ? {
          published: String(host.length === 1 && target.length > 1 ? host[0] + index : host[index]),
        }
      : {}),
    protocol,
  }));
}

function volumeEntry(entry: unknown): Obj {
  if (isObject(entry)) {
    const type =
      entry.type ?? (entry.source && /^[./~]/.test(String(entry.source)) ? 'bind' : 'volume');
    const extra =
      type === 'volume' && !entry.volume
        ? { volume: {} }
        : type === 'bind' && !entry.bind
          ? { bind: {} }
          : {};
    return { ...entry, type, ...extra };
  }
  const text = String(entry);
  const parts = text.split(':');
  if (parts.length > 3 || !parts[0]) throw new Error(`invalid volume "${text}"`);
  const [source, target, options] = parts.length === 1 ? [undefined, parts[0], undefined] : parts;
  const bind = source !== undefined && /^[./~]/.test(source);
  const volume: Obj = {};
  const bindOptions: Obj = {};
  let readOnly = false;
  for (const option of options ? options.split(',') : []) {
    if (option === 'ro') readOnly = true;
    else if (option === 'rw') readOnly = false;
    else if (option === 'z' || option === 'Z') bindOptions.selinux = option;
    else if (option === 'nocopy') volume.nocopy = true;
    else if (/^r?(shared|slave|private)$/.test(option)) bindOptions.propagation = option;
    else throw new Error(`invalid volume "${text}": unknown option ${option}`);
  }
  return {
    type: bind ? 'bind' : 'volume',
    ...(source !== undefined ? { source } : {}),
    target,
    ...(readOnly ? { read_only: true } : {}),
    ...(bind ? { bind: bindOptions } : { volume }),
  };
}

function dependsOn(value: unknown): Obj | undefined {
  if (value === undefined || value === null) return undefined;
  const out: Obj = {};
  if (Array.isArray(value))
    for (const name of value) out[String(name)] = { condition: 'service_started', required: true };
  else if (isObject(value))
    for (const [name, spec] of Object.entries(value))
      out[name] = { condition: 'service_started', required: true, ...(isObject(spec) ? spec : {}) };
  else throw new Error('depends_on must be a list or a mapping');
  return out;
}

/** A size such as `1g` as the byte count Compose renders. */
function byteSize(service: string, key: string, value: unknown): string {
  const bytes = sizeBytes(value);
  if (bytes === undefined)
    throw new Error(`${service}: ${key} "${String(value)}" is not a size such as 512m or 1g`);
  return String(bytes);
}

/** A duration such as `90s` in the form Compose renders (`1m30s`); other values are left to validation. */
function duration(service: string, key: string, value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const ms = composeDurationMs(value);
  if (ms === undefined)
    throw new Error(`${service}: ${key} "${value}" is not a duration such as 30s or 1m30s`);
  return formatDuration(ms);
}

function extraHosts(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (isObject(value)) return Object.entries(value).map(([host, ip]) => `${host}=${ip}`);
  return strings(value).map((entry) => (entry.includes('=') ? entry : entry.replace(':', '=')));
}

// ---- Services ------------------------------------------------------------------------------------------------------

interface Context {
  lookup: Lookup;
  docs: Map<string, Promise<Obj>>;
}

async function readDocument(file: string, ctx: Context): Promise<Obj> {
  const key = path.resolve(file);
  let doc = ctx.docs.get(key);
  if (!doc) {
    doc = (async () => {
      let text: string;
      try {
        text = await fs.readFile(key, 'utf8');
      } catch (error) {
        throw new Error(
          `could not read ${file}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      let parsed: unknown;
      try {
        parsed = text.trim() ? yaml.load(text, { schema: SCHEMA }) : undefined;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/unknown \w* ?tag/i.test(message))
          throw new UnsupportedComposeError(
            `${file} uses a custom YAML tag such as !reset or !override`,
          );
        throw new Error(`${file} is not valid YAML: ${message}`, { cause: error });
      }
      if (!isObject(parsed)) throw new Error(`${file} defines no services`);
      if ('include' in parsed) throw new UnsupportedComposeError(`${file} uses include`);
      try {
        return interpolateDeep(parsed, ctx.lookup);
      } catch (error) {
        throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`, {
          cause: error,
        });
      }
    })();
    ctx.docs.set(key, doc);
  }
  return doc;
}

async function envFiles(
  value: unknown,
  dir: string,
  ctx: Context,
  name: string,
): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  if (value === undefined || value === null) return out;
  for (const entry of Array.isArray(value) ? value : [value]) {
    const spec = isObject(entry) ? entry : { path: entry };
    if (spec.format && spec.format !== 'dotenv')
      throw new UnsupportedComposeError(`${name}: env_file format ${spec.format} is not supported`);
    const file = path.resolve(dir, String(spec.path));
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && spec.required === false) continue;
      throw new Error(`${name}: env file ${spec.path} could not be read`, { cause: error });
    }
    for (const [key, v] of Object.entries(parseDotenv(text, ctx.lookup)))
      out[key] = v === null ? (ctx.lookup(key) ?? null) : v;
  }
  return out;
}

async function normalizeService(name: string, raw: Obj, dir: string, ctx: Context): Promise<Obj> {
  if (!isObject(raw)) throw new Error(`services.${name} must be a mapping`);
  const svc: Obj = { ...raw };
  delete svc.extends;
  const fileEnv = await envFiles(svc.env_file, dir, ctx, name);
  delete svc.env_file;
  const environment = { ...fileEnv, ...(keyValues(raw.environment, ctx.lookup) ?? {}) };
  if (Object.keys(environment).length || raw.environment !== undefined)
    svc.environment = environment;
  else delete svc.environment;
  if (svc.labels !== undefined) svc.labels = keyValues(svc.labels);
  if (svc.build !== undefined && svc.build !== null) {
    const build: Obj = typeof svc.build === 'string' ? { context: svc.build } : { ...svc.build };
    build.context ??= '.';
    if (!build.dockerfile && !build.dockerfile_inline) build.dockerfile = 'Dockerfile';
    if (build.args !== undefined) {
      const args = keyValues(build.args, ctx.lookup) ?? {};
      build.args = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== null));
    }
    if (build.labels !== undefined) build.labels = keyValues(build.labels);
    svc.build = build;
  }
  for (const key of ['command', 'entrypoint'])
    if (key in svc) {
      const value = command(svc[key]);
      if (value === undefined) delete svc[key];
      else svc[key] = value;
    }
  if (svc.ports !== undefined) svc.ports = (svc.ports as unknown[]).flatMap(portEntries);
  if (svc.expose !== undefined) svc.expose = strings(svc.expose);
  if (svc.volumes !== undefined) svc.volumes = (svc.volumes as unknown[]).map(volumeEntry);
  if (svc.tmpfs !== undefined) svc.tmpfs = strings(svc.tmpfs);
  if ('depends_on' in svc) {
    const value = dependsOn(svc.depends_on);
    if (value) svc.depends_on = value;
    else delete svc.depends_on;
  }
  for (const key of ['mem_limit', 'mem_reservation', 'memswap_limit', 'shm_size'])
    if (svc[key] !== undefined && svc[key] !== null) svc[key] = byteSize(name, key, svc[key]);
  if (svc.stop_grace_period !== undefined)
    svc.stop_grace_period = duration(name, 'stop_grace_period', svc.stop_grace_period);
  if (svc.extra_hosts !== undefined) svc.extra_hosts = extraHosts(svc.extra_hosts);
  if (isObject(svc.healthcheck) && typeof svc.healthcheck.test === 'string')
    svc.healthcheck = { ...svc.healthcheck, test: ['CMD-SHELL', svc.healthcheck.test] };
  if (isObject(svc.healthcheck))
    for (const key of ['interval', 'timeout', 'start_period', 'start_interval'])
      if (svc.healthcheck[key] !== undefined)
        svc.healthcheck[key] = duration(name, `healthcheck.${key}`, svc.healthcheck[key]);
  return svc;
}

/** Sequences that `extends` appends to; every other sequence (`command`, `entrypoint`, `healthcheck.test`) is replaced. */
const APPENDED = new Set([
  'ports',
  'expose',
  'tmpfs',
  'cap_add',
  'cap_drop',
  'dns',
  'dns_search',
  'external_links',
  'security_opt',
]);

function merge(base: Obj, over: Obj, top = false): Obj {
  const out: Obj = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const before = out[key];
    if (isObject(before) && isObject(value)) out[key] = merge(before, value);
    else if (top && key === 'volumes' && Array.isArray(before) && Array.isArray(value)) {
      const targets = new Set(value.map((mount) => (mount as Obj).target));
      out[key] = [...before.filter((mount) => !targets.has((mount as Obj).target)), ...value];
    } else if (top && APPENDED.has(key) && Array.isArray(before) && Array.isArray(value)) {
      const seen = new Set(before.map((item) => JSON.stringify(item)));
      out[key] = [...before, ...value.filter((item) => !seen.has(JSON.stringify(item)))];
    } else out[key] = value;
  }
  return out;
}

async function resolveService(
  file: string,
  name: string,
  ctx: Context,
  chain: string[] = [],
): Promise<Obj> {
  const doc = await readDocument(file, ctx);
  const raw = doc.services?.[name];
  if (raw === undefined) throw new Error(`service ${name} is not defined in ${file}`);
  const dir = path.dirname(path.resolve(file));
  const own = await normalizeService(name, raw ?? {}, dir, ctx);
  const extend = isObject(raw) ? raw.extends : undefined;
  if (extend === undefined || extend === null) return own;
  const spec = typeof extend === 'string' ? { service: extend } : extend;
  if (!isObject(spec) || !spec.service) throw new Error(`${name}: extends needs a service`);
  const baseFile = spec.file ? path.resolve(dir, String(spec.file)) : path.resolve(file);
  const id = `${baseFile}#${spec.service}`;
  if (chain.includes(id))
    throw new Error(`${name}: extends forms a cycle (${[...chain, id].join(' -> ')})`);
  const base = await resolveService(baseFile, String(spec.service), ctx, [
    ...chain,
    `${path.resolve(file)}#${name}`,
  ]);
  return merge(base, own, true);
}

// ---- Project -------------------------------------------------------------------------------------------------------

function activeProfiles(env: NodeJS.ProcessEnv): Set<string> {
  return new Set(
    (env.COMPOSE_PROFILES ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean),
  );
}

/** The project name Compose derives from a directory: lower case, with only letters, digits, `-` and `_`. */
const directoryProject = (dir: string): string =>
  path
    .basename(dir)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '');

/**
 * Reads `file` into the canonical definition. Variables come from `options.env` (default `process.env`), then from
 * the `.env` next to the file; `COMPOSE_PROFILES` selects profiles as it does for Compose.
 */
export async function loadCompose(file: string, options: LoadOptions = {}): Promise<ComposeFile> {
  const env = options.env ?? process.env;
  const dir = path.dirname(path.resolve(file));
  let dotenv: Record<string, string | null> = {};
  try {
    dotenv = parseDotenv(await fs.readFile(path.join(dir, '.env'), 'utf8'), (name) => env[name]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new Error(
        `could not read .env next to ${file}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
  }
  const lookup: Lookup = (name) => env[name] ?? dotenv[name] ?? undefined;
  const ctx: Context = { lookup, docs: new Map() };
  const doc = await readDocument(file, ctx);
  if (!isObject(doc.services) || !Object.keys(doc.services).length)
    throw new Error(`${file} defines no services`);
  const profiles = activeProfiles(env);
  const services: Obj = {};
  for (const name of Object.keys(doc.services)) {
    const declared = isObject(doc.services[name]) ? strings(doc.services[name].profiles) : [];
    if (declared.length && !profiles.has('*') && !declared.some((profile) => profiles.has(profile)))
      continue;
    services[name] = await resolveService(file, name, ctx);
  }
  const used = new Set<string>();
  for (const svc of Object.values(services))
    for (const mount of (svc.volumes ?? []) as Obj[])
      if (mount.type === 'volume' && mount.source) used.add(String(mount.source));
  const volumes: Obj = {};
  for (const [key, def] of Object.entries((isObject(doc.volumes) ? doc.volumes : {}) as Obj)) {
    if (!used.has(key)) continue;
    const volume: Obj = isObject(def) ? { ...def } : {};
    if (isObject(volume.external)) {
      if (volume.external.name) volume.name = volume.external.name;
      volume.external = true;
    }
    if (volume.labels !== undefined) volume.labels = keyValues(volume.labels);
    volumes[key] = volume;
  }
  const {
    version: _version,
    services: _services,
    volumes: _volumes,
    name: declaredName,
    ...rest
  } = doc;
  void _version;
  void _services;
  void _volumes;
  return {
    name: options.project || declaredName || directoryProject(dir),
    services,
    ...(Object.keys(volumes).length ? { volumes } : {}),
    ...rest,
  } as ComposeFile;
}
