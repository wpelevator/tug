import { createHmac } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { redactSecrets } from './destination.ts';
import { collect, ensureImage, parseSummary } from './job.ts';
import type { Collected } from './job.ts';
import type { DockerApi } from '../docker-api.ts';

/** Name of the stdin stream restic stores the archive under; `restic dump` reads it back by this path. */
export const CONTROL_ARCHIVE_NAME = 'control.tar.gz';
/** restic host and tag every control snapshot carries, so retention and restore never touch anything else. */
const CONTROL_HOST = 'control';
const CONTROL_TAG = 'control';
/** One control backup or fetch may take this long before its helper container is removed. */
export const CONTROL_JOB_LIMIT_MS = 30 * 60_000;
const RETENTION = [
  '--keep-last',
  '3',
  '--keep-daily',
  '7',
  '--keep-weekly',
  '4',
  '--keep-monthly',
  '6',
];
const MISSING_REPOSITORY =
  /Is there a repository at the following location|does not exist|no such file/i;

export interface ControlRepositoryAccess {
  /** The destination URL as stored, such as `s3:https://host/bucket/prefix`. */
  url: string;
  /** The destination's credential variables, decrypted. */
  env: Record<string, string>;
  resticImage: string;
  /** Overrides {@link CONTROL_JOB_LIMIT_MS}. */
  limitMs?: number;
}

/** The control repository sits next to the project repositories, under a name no project can have. */
export const controlRepository = (url: string): string => `${url.replace(/\/+$/, '')}/_control`;

/**
 * The control repository password. It is derived from the destination's own secret, never from the master key
 * (which is inside the archive), so the bucket login is the whole recovery kit. Rotating the secret starts a new
 * repository; older snapshots need the old secret.
 */
export function controlRepositoryPassword(env: Record<string, string>): string {
  const secret =
    env.AWS_SECRET_ACCESS_KEY ??
    Object.keys(env)
      .sort()
      .map((name) => `${name}=${env[name]}`)
      .join('\n');
  return createHmac('sha256', secret).update('tug-control').digest('hex');
}

export class ControlBackupError extends Error {}

const lastLines = (text: string): string => text.trim().split('\n').slice(-6).join(' | ');

type Exec = (cmd: string[], options?: { input?: string }) => Promise<Collected>;

/** Runs `work` against a restic helper container that is always removed afterwards. */
async function withRestic<T>(
  docker: DockerApi,
  access: ControlRepositoryAccess,
  work: (
    exec: Exec,
    run: (cmd: string[], file: string, mode: 'read' | 'write') => Promise<Collected>,
  ) => Promise<T>,
): Promise<T> {
  const password = controlRepositoryPassword(access.env);
  const redact = (text: string) => redactSecrets(text, [...Object.values(access.env), password]);
  const repository = controlRepository(access.url);
  const binds = repository.startsWith('/') ? [`${repository}:${repository}`] : [];
  const limit = access.limitMs ?? CONTROL_JOB_LIMIT_MS;
  let container: string | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    await ensureImage(docker, access.resticImage);
    container = await docker.createContainer(`tug-control-backup-${Date.now().toString(36)}`, {
      Image: access.resticImage,
      Entrypoint: ['sleep'],
      Cmd: ['86400'],
      Env: [
        ...Object.entries(access.env).map(([key, value]) => `${key}=${value}`),
        `RESTIC_REPOSITORY=${repository}`,
        `RESTIC_PASSWORD=${password}`,
        'GOMAXPROCS=2',
      ],
      Labels: { 'tug.job': 'control-backup' },
      HostConfig: { Memory: 512 * 1024 ** 2, Binds: binds },
    });
    await docker.startContainer(container);
    const id = container;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new ControlBackupError(`restic did not finish within ${Math.round(limit / 1000)}s`),
          ),
        limit,
      );
    });
    timeout.catch(() => undefined);
    const finish = async (result: Collected): Promise<Collected> => ({
      ...result,
      out: redact(result.out),
      err: redact(result.err),
    });
    const exec: Exec = async (cmd) =>
      finish(await Promise.race([docker.execStart(id, { cmd }).then(collect), timeout]));
    /** `write` streams a local file into restic's stdin; `read` streams restic's stdout into a local file. */
    const run = async (cmd: string[], file: string, mode: 'read' | 'write'): Promise<Collected> => {
      const proc = await docker.execStart(id, { cmd, stdin: mode === 'write' });
      const done = collect(proc);
      const moved =
        mode === 'write'
          ? pipeline(createReadStream(file), proc.stdin!)
          : pipeline(proc.stdout, createWriteStream(file, { mode: 0o600 }));
      // Collecting stdout would buffer a whole archive, so a read leaves stdout to the file and collects only stderr.
      const result = await Promise.race([Promise.all([moved, done]).then(([, r]) => r), timeout]);
      return finish(result);
    };
    return await work(exec, run);
  } catch (error) {
    if (error instanceof ControlBackupError) throw error;
    throw new ControlBackupError(redact(error instanceof Error ? error.message : String(error)), {
      cause: error,
    });
  } finally {
    clearTimeout(timer);
    if (container) await docker.removeContainer(container).catch(() => undefined);
  }
}

export interface ControlPush {
  snapshotId?: string;
  repository: 'ok' | 'initialized';
  /** Retention could not run; the backup itself succeeded. */
  warning?: string;
}

/** Stores the archive file as a new snapshot in the `_control` repository, creating it when it does not exist yet. */
export async function pushControlArchive(
  docker: DockerApi,
  access: ControlRepositoryAccess,
  archivePath: string,
): Promise<ControlPush> {
  return withRestic(docker, access, async (exec, run) => {
    let repository: ControlPush['repository'] = 'ok';
    const probe = await exec(['restic', 'cat', 'config']);
    if (probe.code !== 0) {
      // Only a missing repository is created; a wrong password or an unreachable bucket must fail the backup.
      if (!MISSING_REPOSITORY.test(probe.err))
        throw new ControlBackupError(
          `repository check failed: ${lastLines(probe.err || probe.out)}`,
        );
      const init = await exec(['restic', 'init']);
      if (init.code !== 0)
        throw new ControlBackupError(`repository init failed: ${lastLines(init.err || init.out)}`);
      repository = 'initialized';
    }
    const backup = await run(
      [
        'restic',
        'backup',
        '--stdin',
        '--stdin-filename',
        CONTROL_ARCHIVE_NAME,
        '--json',
        '--host',
        CONTROL_HOST,
        '--tag',
        CONTROL_TAG,
        '--retry-lock',
        '10m',
      ],
      archivePath,
      'write',
    );
    if (backup.code !== 0)
      throw new ControlBackupError(`backup failed: ${lastLines(backup.err || backup.out)}`);
    const forget = await exec([
      'restic',
      'forget',
      '--tag',
      CONTROL_TAG,
      '--host',
      CONTROL_HOST,
      '--group-by',
      'host',
      ...RETENTION,
      '--prune',
      '--retry-lock',
      '10m',
    ]);
    return {
      snapshotId: parseSummary(backup.out).snapshotId,
      repository,
      ...(forget.code === 0
        ? {}
        : { warning: `retention failed: ${lastLines(forget.err || forget.out)}` }),
    };
  });
}

/** Writes the newest control archive of the destination to `destination` (mode 0600); fails when there is none. */
export async function fetchControlArchive(
  docker: DockerApi,
  access: ControlRepositoryAccess,
  destination: string,
): Promise<void> {
  await withRestic(docker, access, async (exec, run) => {
    const probe = await exec(['restic', 'cat', 'config']);
    if (probe.code !== 0)
      throw new ControlBackupError(
        MISSING_REPOSITORY.test(probe.err)
          ? `no control backup was found at ${controlRepository(access.url)}`
          : `cannot read the control repository (wrong credentials or unreachable store): ${lastLines(probe.err || probe.out)}`,
      );
    const dump = await run(
      [
        'restic',
        'dump',
        'latest',
        `/${CONTROL_ARCHIVE_NAME}`,
        '--host',
        CONTROL_HOST,
        '--tag',
        CONTROL_TAG,
      ],
      destination,
      'read',
    );
    if (dump.code !== 0)
      throw new ControlBackupError(
        `could not read the latest control backup: ${lastLines(dump.err)}`,
      );
  });
}
