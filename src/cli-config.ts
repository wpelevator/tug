import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';
import { decodeCredential } from './pki.ts';
import type { Credential } from './pki.ts';
import { errMessage } from './util.ts';

export type SettingType = 'string' | 'boolean' | 'port' | 'list' | 'path';
export interface Setting {
  type: SettingType;
  /** The flag or positional argument the key stands for; the key is the camelCase of the long flag. */
  flag: string;
  /** Commands that read the key as a default for `flag`. */
  commands: string[];
}

/** Defaults for options of commands that work on the project (top level of the config file). */
export const COMMAND_SETTINGS: Record<string, Setting> = {
  file: { type: 'path', flag: '--file', commands: ['deploy'] },
  buildLocal: { type: 'boolean', flag: '--build-local', commands: ['deploy'] },
  wait: { type: 'boolean', flag: '--no-wait', commands: ['deploy', 'rollback'] },
};
/** Per-node connection data (`nodes.<name>`); `nodeDefaults` takes the subset that is not node-specific. */
export const NODE_SETTINGS: Record<string, Setting> = {
  ssh: {
    type: 'string',
    flag: '<ssh-target>',
    commands: ['node-install', 'node-replace-identity', 'node-repair-identity'],
  },
  address: { type: 'string', flag: '--address', commands: ['node-install', 'node-register'] },
  publicAddress: {
    type: 'string',
    flag: '--public-address',
    commands: ['node-install', 'node-register'],
  },
  label: {
    type: 'list',
    flag: '--label',
    commands: ['node-install', 'node-register', 'node-prepare-enrollment'],
  },
  mesh: {
    type: 'boolean',
    flag: '--mesh',
    commands: [
      'node-install',
      'node-replace-identity',
      'node-repair-identity',
      'node-prepare-enrollment',
    ],
  },
  wgPort: {
    type: 'port',
    flag: '--wg-port',
    commands: ['node-install', 'node-replace-identity', 'node-repair-identity'],
  },
  installDocker: {
    type: 'boolean',
    flag: '--install-docker',
    commands: [
      'node-install',
      'node-replace-identity',
      'node-repair-identity',
      'node-prepare-enrollment',
    ],
  },
  image: {
    type: 'string',
    flag: '--image',
    commands: [
      'node-install',
      'node-replace-identity',
      'node-repair-identity',
      'node-prepare-enrollment',
    ],
  },
  agentControlUrl: {
    type: 'string',
    flag: '--agent-control-url',
    commands: [
      'node-install',
      'node-replace-identity',
      'node-repair-identity',
      'node-prepare-enrollment',
    ],
  },
};
const NODE_SPECIFIC_KEYS = ['ssh', 'address', 'publicAddress'];
const SETTINGS: Record<string, Setting> = { ...COMMAND_SETTINGS, ...NODE_SETTINGS };

/** Default file names, in lookup order; more than one present is an error. */
export const CONFIG_NAMES = ['tug.yml', 'tug.yaml', 'tug.json', '.tug.json'];

export type SettingValues = Record<string, string | boolean | string[]>;
interface ParsedConfig {
  controlUrl?: string;
  /** Path of a credential file; only an untracked overlay may name one. */
  credential?: string;
  project?: string;
  commandDefaults: SettingValues;
  nodeDefaults: SettingValues;
  nodes: Record<string, SettingValues>;
}
export interface ConnectionOptions {
  config?: string;
  controlUrl?: string;
  project?: string;
  credential?: string;
}
export interface ResolvedCliConfig {
  /** The tracked config: selected, discovered, or where `init` creates it. */
  file: string;
  fileExists: boolean;
  /** The untracked overlay next to `file`, the only place a credential path may be stored. */
  localFile: string;
  /** Where connections go: the credential's public URL unless overridden (an override changes the connect target only). */
  controlUrl: string;
  credential?: Credential;
  credentialFile?: string;
  project: string;
  commandDefaults: SettingValues;
  nodeDefaults: SettingValues;
  nodes: Record<string, SettingValues>;
}

/** `tug.yml` becomes `tug.local.yml`, `.tug.json` becomes `.tug.local.json`. */
export function localConfigPath(file: string): string {
  const { dir, name, ext } = path.parse(file);
  return path.join(dir, `${name}.local${ext}`);
}

/** Resolve adapter settings once; domain operations receive these explicit values. */
export async function resolveCliConfig(
  options: ConnectionOptions,
  env: NodeJS.ProcessEnv,
  cwd: string,
  creating = false,
): Promise<ResolvedCliConfig> {
  for (const key of ['config', 'controlUrl', 'project', 'credential'] as const)
    if (options[key] !== undefined && (!options[key]!.trim() || /[\r\n\0]/.test(options[key]!)))
      throw new Error(
        `--${key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())} must be a nonempty single-line value`,
      );
  const selected = options.config || env.TUG_CONFIG;
  const file = selected ? path.resolve(cwd, selected) : await discoverConfigFile(cwd);
  const localFile = localConfigPath(file);
  const base = await readConfigFile(file, false);
  if (!base && !creating && selected)
    throw new Error(`Cannot read config ${file}: ENOENT: no such file`);
  const overlay = await readConfigFile(localFile, true);
  const config = mergeConfigs(base ?? emptyConfig(), overlay ?? emptyConfig());
  if (env.TUG_CREDENTIAL && env.TUG_CREDENTIAL_FILE)
    throw new Error('set only one of TUG_CREDENTIAL and TUG_CREDENTIAL_FILE');
  // Precedence: --credential, then the environment, then the untracked overlay's credential path.
  let credentialFile: string | undefined;
  let credentialText: string | undefined;
  if (options.credential) credentialFile = path.resolve(cwd, options.credential);
  else if (env.TUG_CREDENTIAL) credentialText = env.TUG_CREDENTIAL;
  else if (env.TUG_CREDENTIAL_FILE) credentialFile = path.resolve(cwd, env.TUG_CREDENTIAL_FILE);
  else if (config.credential) credentialFile = config.credential;
  let credential: Credential | undefined;
  if (credentialFile || credentialText)
    try {
      credential = decodeCredential(credentialText ?? (await fs.readFile(credentialFile!, 'utf8')));
    } catch (e) {
      if (!creating)
        throw new Error(
          `cannot use credential ${credentialFile ?? 'from TUG_CREDENTIAL'}: ${errMessage(e)}`,
          { cause: e },
        );
    }
  const controlUrl =
    options.controlUrl ||
    env.TUG_CONTROL_URL ||
    config.controlUrl ||
    credential?.url ||
    'https://localhost:8443';
  return {
    file,
    fileExists: Boolean(base),
    localFile,
    controlUrl: normalizeControlUrl(controlUrl),
    credential,
    credentialFile,
    project: options.project || env.TUG_PROJECT || config.project || 'site',
    commandDefaults: config.commandDefaults,
    nodeDefaults: config.nodeDefaults,
    nodes: config.nodes,
  };
}

/** `nodeDefaults` under the node's own keys; a list in the node replaces the default list. */
export function nodeSettings(config: ResolvedCliConfig, name?: string): SettingValues {
  return { ...config.nodeDefaults, ...(name ? config.nodes[name] : undefined) };
}

interface OptionSource {
  name(): string;
  options: readonly { attributeName(): string }[];
  getOptionValueSource(key: string): string | undefined;
}

/**
 * Use config values as defaults for the options of a command: a key applies to a command that lists it
 * and has an option of that name, and never over a value given on the command line.
 */
export function applyConfigDefaults(
  command: OptionSource,
  values: object,
  settings: SettingValues,
): void {
  const attributes = new Set(command.options.map((option) => option.attributeName()));
  for (const [key, value] of Object.entries(settings)) {
    if (
      SETTINGS[key]?.commands.includes(command.name()) &&
      attributes.has(key) &&
      command.getOptionValueSource(key) !== 'cli'
    )
      (values as Record<string, unknown>)[key] = value;
  }
}

function emptyConfig(): ParsedConfig {
  return { commandDefaults: {}, nodeDefaults: {}, nodes: {} };
}

async function discoverConfigFile(cwd: string): Promise<string> {
  const found: string[] = [];
  for (const name of CONFIG_NAMES) {
    try {
      await fs.stat(path.join(cwd, name));
      found.push(name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  if (found.length > 1)
    throw new Error(
      `Found more than one config file (${found.join(', ')}) in ${cwd}; keep one or select it with --config`,
    );
  return path.join(cwd, found[0] ?? CONFIG_NAMES[0]);
}

function parseText(file: string, content: string): unknown {
  return path.extname(file) === '.json' ? JSON.parse(content) : yaml.load(content);
}

async function readConfigFile(file: string, overlay: boolean): Promise<ParsedConfig | undefined> {
  let content: string;
  try {
    content = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`Cannot read config ${file}: ${(error as Error).message}`, { cause: error });
  }
  try {
    return parseConfig(
      parseText(file, content) ?? {},
      path.dirname(file),
      overlay ? undefined : localConfigPath(file),
    );
  } catch (error) {
    throw new Error(`Cannot read config ${file}: ${(error as Error).message}`, { cause: error });
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function text(value: unknown, where: string): string {
  if (typeof value !== 'string' || !value.trim() || /[\r\n\0]/.test(value))
    throw new Error(`${where} must be a nonempty single-line string`);
  return value;
}

/** Same rule as --name, so a name from the file is as safe as one typed. */
function nodeName(name: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name))
    throw new Error(
      `nodes.${name} must be a node name of letters, numbers, dots, underscores or hyphens`,
    );
  return name;
}

function settingValue(
  setting: Setting,
  value: unknown,
  where: string,
  dir: string,
): string | boolean | string[] {
  switch (setting.type) {
    case 'string':
      return text(value, where);
    case 'path':
      return path.resolve(dir, text(value, where));
    case 'boolean':
      if (typeof value !== 'boolean') throw new Error(`${where} must be true or false`);
      return value;
    case 'port':
      return String(integerOption(String(value), where, 1, 65535));
    case 'list':
      return (Array.isArray(value) ? value : [value]).map((item, index) =>
        text(item, Array.isArray(value) ? `${where}[${index}]` : where),
      );
  }
}

function parseSettings(
  input: unknown,
  table: Record<string, Setting>,
  where: string,
  dir: string,
): SettingValues {
  if (!isObject(input)) throw new Error(`${where} must be a mapping`);
  const settings: SettingValues = {};
  for (const [key, value] of Object.entries(input)) {
    if (!table[key])
      throw new Error(
        `${where}.${key} is not a known setting (known: ${Object.keys(table).join(', ')})`,
      );
    settings[key] = settingValue(table[key], value, `${where}.${key}`, dir);
  }
  return settings;
}

/** `overlay` names the overlay to suggest for a tracked file; undefined means this file is the overlay and may hold a token. */
function parseConfig(input: unknown, dir: string, overlay?: string): ParsedConfig {
  if (!isObject(input)) throw new Error('expected a mapping of settings');
  const config = emptyConfig();
  const nodeDefaultsTable = Object.fromEntries(
    Object.entries(NODE_SETTINGS).filter(([key]) => !NODE_SPECIFIC_KEYS.includes(key)),
  );
  for (const [key, value] of Object.entries(input)) {
    if (key === 'controlUrl' || key === 'project') config[key] = text(value, key);
    else if (key === 'credential') {
      if (overlay)
        throw new Error(
          `credential must not be set in a tracked file; put it in ${overlay}, or use TUG_CREDENTIAL_FILE`,
        );
      config.credential = path.resolve(dir, text(value, key));
    } else if (COMMAND_SETTINGS[key])
      config.commandDefaults[key] = settingValue(COMMAND_SETTINGS[key], value, key, dir);
    else if (key === 'nodeDefaults')
      config.nodeDefaults = parseSettings(value, nodeDefaultsTable, key, dir);
    else if (key === 'nodes') {
      if (!isObject(value)) throw new Error('nodes must be a mapping of node names');
      for (const [name, node] of Object.entries(value))
        config.nodes[nodeName(name)] = parseSettings(
          node ?? {},
          NODE_SETTINGS,
          `nodes.${name}`,
          dir,
        );
    } else {
      const known = [
        'controlUrl',
        'project',
        ...(overlay ? [] : ['credential']),
        ...Object.keys(COMMAND_SETTINGS),
        'nodeDefaults',
        'nodes',
      ];
      throw new Error(`${key} is not a known setting (known: ${known.join(', ')})`);
    }
  }
  return config;
}

/** The overlay wins key by key, including inside `nodeDefaults` and each node. */
function mergeConfigs(base: ParsedConfig, overlay: ParsedConfig): ParsedConfig {
  const nodes: Record<string, SettingValues> = {};
  for (const name of new Set([...Object.keys(base.nodes), ...Object.keys(overlay.nodes)]))
    nodes[name] = { ...base.nodes[name], ...overlay.nodes[name] };
  return {
    controlUrl: overlay.controlUrl ?? base.controlUrl,
    project: overlay.project ?? base.project,
    credential: overlay.credential ?? base.credential,
    commandDefaults: { ...base.commandDefaults, ...overlay.commandDefaults },
    nodeDefaults: { ...base.nodeDefaults, ...overlay.nodeDefaults },
    nodes,
  };
}

function serialize(file: string, data: Record<string, unknown>, notice?: string): string {
  if (path.extname(file) === '.json') return `${JSON.stringify(data, null, 2)}\n`;
  return `${notice ? `# ${notice}\n` : ''}${yaml.dump(data)}`;
}

/**
 * `tug init`: create the tracked file when it is missing and always point the untracked
 * overlay at the credential file, git-ignoring it. An existing tracked file is never rewritten, so its comments survive;
 * connection flags passed to `init` are saved to the overlay instead.
 */
export async function writeInitConfig(
  config: ResolvedCliConfig,
  credentialFile: string,
  explicit: ConnectionOptions,
): Promise<string[]> {
  const written: string[] = [];
  if (!config.fileExists) {
    await fs.mkdir(path.dirname(config.file), { recursive: true });
    await fs.writeFile(
      config.file,
      serialize(
        config.file,
        { controlUrl: config.controlUrl, project: config.project },
        `Safe to commit: keep credentials out of this file (use TUG_CREDENTIAL_FILE or ${path.basename(config.localFile)}).`,
      ),
    );
    written.push(config.file);
  }
  let local: Record<string, unknown> = {};
  try {
    const existing = parseText(config.localFile, await fs.readFile(config.localFile, 'utf8'));
    if (isObject(existing)) local = existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  local.credential = credentialFile;
  if (config.fileExists) {
    if (explicit.controlUrl) local.controlUrl = config.controlUrl;
    if (explicit.project) local.project = config.project;
  }
  await fs.writeFile(config.localFile, serialize(config.localFile, local), { mode: 0o600 });
  await fs.chmod(config.localFile, 0o600);
  written.push(config.localFile);
  await gitIgnore(config.localFile);
  return written;
}

/** Add `file` to the .gitignore next to it when it sits in a git work tree and is not ignored yet. */
async function gitIgnore(file: string): Promise<void> {
  const cwd = path.dirname(file);
  const ignored = spawnSync('git', ['check-ignore', '-q', '--', file], { cwd });
  if (ignored.status !== 1) return; // 0: already ignored; anything else: not a git checkout
  const ignoreFile = path.join(cwd, '.gitignore');
  let current = '';
  try {
    current = await fs.readFile(ignoreFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await fs.writeFile(
    ignoreFile,
    `${current}${current && !current.endsWith('\n') ? '\n' : ''}${path.basename(file)}\n`,
  );
}

export function normalizeControlUrl(value: string): string {
  if (!value.trim() || /[\r\n\0]/.test(value))
    throw new Error('control URL must be a nonempty single-line URL');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('control URL must be an absolute https:// URL');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new Error('control URL must use https:// without credentials, query or fragment');
  return value.replace(/\/+$/, '');
}

export function integerOption(
  value: string,
  name: string,
  minimum = 1,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < minimum ||
    Number(value) > maximum
  )
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  return Number(value);
}
