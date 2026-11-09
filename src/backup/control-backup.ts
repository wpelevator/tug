import { createHmac, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
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
  /** The control repository password: {@link controlRepositoryPassword} on control, the escrowed copy on a restore. */
  password: string;
  resticImage: string;
  /** Overrides {@link CONTROL_JOB_LIMIT_MS}. */
  limitMs?: number;
}

/** The control repository sits next to the project repositories, under a name no project can have. */
export const controlRepository = (url: string): string => `${url.replace(/\/+$/, '')}/_control`;

/**
 * The control repository password, derived from the master key like every project's. Nodes are only ever given the
 * passwords of their own projects and the derivation cannot be inverted, so a node that holds the destination
 * credentials still cannot open or forge a control snapshot. The master key is inside the archive, so the derived
 * password (`tug backup password --control`) is the one value an operator must keep off the server: it opens the
 * archive, and the archive restores the master key every project password derives from.
 */
export function controlRepositoryPassword(masterKey: string): string {
  return createHmac('sha256', masterKey).update('tug-control').digest('hex');
}

export class ControlBackupError extends Error {}

const lastLines = (text: string): string => text.trim().split('\n').slice(-6).join(' | ');

type Exec = (cmd: string[]) => Promise<Collected>;

/** Runs `work` against a restic helper container that is always removed afterwards. */
async function withRestic<T>(
  docker: DockerApi,
  access: ControlRepositoryAccess,
  work: (
    exec: Exec,
    run: (cmd: string[], file: string, mode: 'read' | 'write') => Promise<Collected>,
  ) => Promise<T>,
): Promise<T> {
  const redact = (text: string) =>
    redactSecrets(text, [...Object.values(access.env), access.password]);
  const repository = controlRepository(access.url);
  const binds = repository.startsWith('/') ? [`${repository}:${repository}`] : [];
  const limit = access.limitMs ?? CONTROL_JOB_LIMIT_MS;
  let container: string | undefined;
  // One limit covers the image pull, the helper and every restic command.
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(new ControlBackupError(`restic did not finish within ${Math.round(limit / 1000)}s`)),
      limit,
    );
  });
  timeout.catch(() => undefined);
  try {
    await Promise.race([ensureImage(docker, access.resticImage), timeout]);
    container = await docker.createContainer(
      `tug-control-backup-${randomBytes(4).toString('hex')}`,
      {
        Image: access.resticImage,
        Entrypoint: ['sleep'],
        Cmd: ['86400'],
        Env: [
          ...Object.entries(access.env).map(([key, value]) => `${key}=${value}`),
          `RESTIC_REPOSITORY=${repository}`,
          `RESTIC_PASSWORD=${access.password}`,
          'GOMAXPROCS=2',
        ],
        Labels: { 'tug.job': 'control-backup' },
        HostConfig: { Memory: 512 * 1024 ** 2, Binds: binds },
      },
    );
    await docker.startContainer(container);
    const id = container;
    const finish = (result: Collected): Collected => ({
      ...result,
      out: redact(result.out),
      err: redact(result.err),
    });
    const exec: Exec = async (cmd) =>
      finish(await Promise.race([docker.execStart(id, { cmd }).then(collect), timeout]));
    /** `write` streams a local file into restic's stdin; `read` streams restic's stdout into a local file. */
    const run = async (cmd: string[], file: string, mode: 'read' | 'write'): Promise<Collected> => {
      const proc = await docker.execStart(id, { cmd, stdin: mode === 'write' });
      // A read sends stdout to the file; collect() still keeps a bounded copy, which is ignored.
      const done = collect(proc);
      const moved =
        mode === 'write'
          ? pipeline(createReadStream(file), proc.stdin!)
          : pipeline(proc.stdout, createWriteStream(file, { mode: 0o600 }));
      const [transfer, result] = await Promise.race([Promise.allSettled([moved, done]), timeout]);
      if (result.status === 'rejected') throw result.reason;
      // restic that exits early (a lock timeout, a wrong repository) breaks the pipe; its own message is the cause.
      if (transfer.status === 'rejected' && result.value.code === 0) throw transfer.reason;
      return finish(result.value);
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
          : `cannot read the control repository (wrong control password or credentials, or an unreachable store): ${lastLines(probe.err || probe.out)}`,
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
    if (dump.code !== 0) {
      await rm(destination, { force: true });
      throw new ControlBackupError(
        `could not read the latest control backup: ${lastLines(dump.err)}`,
      );
    }
  });
}
