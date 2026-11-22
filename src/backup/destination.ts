import { createHmac } from 'node:crypto';
import type { RetentionMode } from '../protocol.ts';

/** Reserved secrets-table project holding the backup destination's credentials. */
export const BACKUP_SECRET_PROJECT = '_backup';
const MAX_ENV_VARIABLES = 16;
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const RESERVED_ENV = ['RESTIC_PASSWORD', 'RESTIC_REPOSITORY', 'RESTIC_PASSWORD_FILE'];
/** Shorter values would redact ordinary words out of error text. */
const MIN_REDACTED_LENGTH = 4;
/** restic's built-in backends Tug accepts; `local` is an absolute path. `sftp:` and `rclone:` are rejected with their own messages. */
const BACKENDS = ['s3', 'rest', 'b2', 'azure', 'gs', 'swift', 'local'];
const REQUIRED_ENV: Record<string, string[]> = {
  s3: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'],
};

export interface BackupDestinationInput {
  url: string;
  /** Variable name to value; stored encrypted and never returned. */
  env: Record<string, string>;
  /** Who prunes the destination; absent when the request did not say, so the caller decides what to keep. */
  retention?: RetentionMode;
}

export const isBackupProject = (project: string): boolean => project === BACKUP_SECRET_PROJECT;

/** A name starting with `_` is reserved for control's own records and is never a deployable project. */
export const isReservedProject = (project: string): boolean => project.startsWith('_');

/** `managed`, `external` or undefined when absent; anything else is an error naming the choices. */
export function parseRetentionMode(value: unknown): RetentionMode | undefined {
  if (value === undefined) return undefined;
  if (value === 'managed' || value === 'external') return value;
  throw new Error(
    'retention must be "managed" (tug prunes old snapshots) or "external" (an append-only destination pruned from the storage side)',
  );
}

/** A destination URL as stored: trimmed, without trailing slashes; empty when it is not a string. */
export function normalizeDestinationUrl(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
}

/** Throws an `Error` naming the first problem with a destination, or returns it normalized. */
export function parseBackupDestination(input: unknown): BackupDestinationInput {
  const body = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const url = normalizeDestinationUrl(body.url);
  if (!url)
    throw new Error('url is required, such as s3:https://s3.example.com/bucket/tug-backups');
  if (/\s/.test(url)) throw new Error('url must not contain whitespace');
  const scheme = url.startsWith('/') ? 'local' : url.split(':')[0];
  if (scheme === 'sftp')
    throw new Error(
      'sftp: destinations are not supported because Tug cannot give the restic helper SSH keys or a known_hosts file; run a restic rest-server and reach it over a private network or VPN (rest:http://host:8000/path), or use S3',
    );
  if (scheme === 'rclone')
    throw new Error(
      'rclone: destinations are not supported because the restic helper image does not configure rclone; use S3, a rest-server (rest:), or another built-in backend',
    );
  if (!BACKENDS.includes(scheme))
    throw new Error(
      'url must start with s3:, rest:, b2:, azure:, gs: or swift:, or be an absolute path (a path is for development only: it is read on each node, not shared)',
    );
  if (/:\/\/[^/@\s]*:[^/@\s]*@/.test(url))
    throw new Error(
      'url must not contain a username and password; pass credentials as env variables so they are stored encrypted',
    );
  if (scheme === 's3' && !/^s3:https?:\/\/[^/]+\/[^/]+/.test(url))
    throw new Error(
      's3 urls look like s3:https://host/bucket[/prefix] and must name a bucket; AWS S3 uses s3:https://s3.amazonaws.com/bucket',
    );
  const retention = parseRetentionMode(body.retention);
  const rawEnv =
    body.env && typeof body.env === 'object' ? (body.env as Record<string, unknown>) : {};
  const names = Object.keys(rawEnv);
  if (names.length > MAX_ENV_VARIABLES)
    throw new Error(`at most ${MAX_ENV_VARIABLES} env variables are supported`);
  const env: Record<string, string> = {};
  for (const name of names) {
    if (!ENV_NAME_RE.test(name))
      throw new Error(
        `env variable ${JSON.stringify(name)} must be upper case letters, digits and underscores`,
      );
    if (RESERVED_ENV.includes(name)) throw new Error(`${name} is managed by Tug and cannot be set`);
    const value = rawEnv[name];
    if (typeof value !== 'string' || !value) throw new Error(`env variable ${name} needs a value`);
    env[name] = value;
  }
  const missing = (REQUIRED_ENV[scheme] ?? []).filter((name) => !(name in env));
  if (missing.length) throw new Error(`${scheme} destinations need ${missing.join(' and ')}`);
  return { url, env, ...(retention ? { retention } : {}) };
}

/** The restic repository of one project: every node of the project shares it, other projects never do. */
export function projectRepository(destinationUrl: string, project: string): string {
  return `${destinationUrl.replace(/\/+$/, '')}/${project}`;
}

/**
 * The repository password of a project, derived from the control master key so nothing extra is stored and
 * a node only ever holds the passwords of projects it runs backups for. Losing the master key loses every
 * repository, which is why `tug backup password` exists for offline escrow.
 */
export function repositoryPassword(masterKey: string, project: string): string {
  return createHmac('sha256', masterKey).update(`tug-restic:${project}`).digest('hex');
}

/** Removes every known secret value from text that is about to be stored, shown or put in an event. */
export function redactSecrets(text: string, values: Iterable<string>): string {
  const secrets = [...new Set(values)]
    .filter((value) => value.length >= MIN_REDACTED_LENGTH)
    .sort((a, b) => b.length - a.length);
  let result = text;
  for (const secret of secrets) result = result.split(secret).join('[redacted]');
  // A credential embedded in a URL, such as one echoed back in a backend error.
  return result.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1[redacted]@');
}
