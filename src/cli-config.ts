import fs from 'node:fs/promises';
import path from 'node:path';

export interface CliConfig { controlUrl?: string; operatorToken?: string; project?: string }
export interface ConnectionOptions { config?: string; controlUrl?: string; project?: string }
export interface ResolvedCliConfig { file: string; controlUrl: string; operatorToken?: string; project: string }

/** Resolve adapter settings once; domain operations receive these explicit values. */
export async function resolveCliConfig(options: ConnectionOptions, env: NodeJS.ProcessEnv, cwd: string, creating = false): Promise<ResolvedCliConfig> {
  for (const key of ['config', 'controlUrl', 'project'] as const) if (options[key] !== undefined && (!options[key]!.trim() || /[\r\n\0]/.test(options[key]!))) throw new Error(`--${key.replace(/[A-Z]/g, c => '-' + c.toLowerCase())} must be a nonempty single-line value`);
  const file = path.resolve(cwd, options.config || env.TUG_CONFIG || '.tug.json');
  let config: CliConfig = {};
  try {
    const input: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('expected a JSON object');
    for (const key of ['controlUrl', 'operatorToken', 'project'] as const) {
      const value = (input as CliConfig)[key];
      if (value !== undefined && (typeof value !== 'string' || !value.trim())) throw new Error(`${key} must be a nonempty string`);
    }
    config = input as CliConfig;
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    if (!missing || (!creating && Boolean(options.config || env.TUG_CONFIG))) throw new Error(`Cannot read config ${file}: ${(error as Error).message}`, { cause: error });
  }
  const controlUrl = options.controlUrl || env.TUG_CONTROL_URL || config.controlUrl || 'http://localhost:8080';
  return { file, controlUrl: normalizeControlUrl(controlUrl), operatorToken: env.TUG_TOKEN || config.operatorToken, project: options.project || env.TUG_PROJECT || config.project || 'site' };
}

export function normalizeControlUrl(value: string): string {
  if (!value.trim() || /[\r\n\0]/.test(value)) throw new Error('control URL must be a nonempty single-line URL');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('control URL must be an absolute http:// or https:// URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('control URL must use http:// or https:// without credentials, query or fragment');
  return value.replace(/\/+$/, '');
}

export function integerOption(value: string, name: string, minimum = 1, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < minimum || Number(value) > maximum) throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  return Number(value);
}
