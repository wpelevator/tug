import { createHmac, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { redactSecrets } from './destination.ts';
import { collect, ensureImage, parseSummary } from './job.ts';
import type { Collected } from './job.ts';
import type { AttachedProcess, DockerApi } from '../docker-api.ts';

/** Name of the stdin stream restic stores the archive under; `restic dump` reads it back by this path. */
export const CONTROL_ARCHIVE_NAME = 'control.tar.gz';
/** restic host and tag every control snapshot carries, so retention and restore never touch anything else. */
const CONTROL_HOST = 'control';
const CONTROL_TAG = 'control';
/** One control backup or fetch may take this long before its helper container is removed. */
export const CONTROL_JOB_LIMIT_MS = 30 * 60_000;
/**
 * restic retries a backend that errors (a missing bucket, a refused login, an unreachable store) for many minutes and
 * says nothing but notices while it does, so a job would look busy until its limit. Failing after this long without any
 * other output, once a notice has been seen, reports the cause instead.
 */
export const CONTROL_STALL_MS = 2 * 60_000;
/** Removing the helper gets this long; a leftover one is removed at the next control start. */
const REMOVE_LIMIT_MS = 30_000;
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
/**
 * restic appends "Is there a repository at the following location?" to every failure to open the config, whatever
 * the cause, so that line says nothing. A repository counts as missing only on positive evidence that the config
 * object itself is absent: S3 `NoSuchKey`, a local `no such file`, an SFTP missing file or a 404 from a REST server.
 * Anything else (a wrong bucket, a refused login, an unreachable store, a wrong password, an answer nobody has seen
 * before) is a backend error, so it is neither initialized over nor reported as "no control backup". The denylist
 * stays as a second guard for messages that mention both.
 */
const CONFIG_IS_ABSENT =
  /specified key does not exist|NoSuchKey|no such file or directory|file does not exist|unexpected HTTP response \(404\)|\b404 (page )?not found/i;
const NOT_A_MISSING_REPOSITORY =
  /NoSuchBucket|bucket does not exist|AccessDenied|Forbidden|Unauthorized|InvalidAccessKey|SignatureDoesNotMatch|dial tcp|no such host|timeout|timed out|connection refused|connection reset|certificate|wrong password|\(40[13]\)/i;
/**
 * restic keeps retrying a failing backend and prints one notice per attempt ("Stat(<config/>) returned error,
 * retrying after 8s: ..."), then ends with its final `Fatal:` message. The notices are history: a bucket that
 * did not exist a minute ago and was created since ends in "repository does not exist", and only that final state
 * says what to do. Classification and summaries therefore ignore the notices.
 */
const RETRY_NOTICE = /returned error, retrying after [^:]*:\s*/i;
function splitRetries(text: string): { notices: string[]; rest: string[] } {
  const lines = text.split('\n').filter((line) => line.trim());
  return {
    notices: lines.filter((line) => RETRY_NOTICE.test(line)),
    rest: lines.filter((line) => !RETRY_NOTICE.test(line)),
  };
}
export const isMissingRepository = (stderr: string): boolean => {
  const final = splitRetries(stderr).rest.join('\n');
  return CONFIG_IS_ABSENT.test(final) && !NOT_A_MISSING_REPOSITORY.test(final);
};

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
  /** A restic command that only prints backend retry notices for this long is failed; defaults to {@link CONTROL_STALL_MS}. */
  stallMs?: number;
  /** Cancels the job (a client that went away); the helper is removed either way. */
  signal?: AbortSignal;
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

const isPipeBreak = (error: unknown): boolean =>
  ['EPIPE', 'ERR_STREAM_PREMATURE_CLOSE', 'ERR_STREAM_DESTROYED', 'ECONNRESET'].includes(
    (error as NodeJS.ErrnoException | undefined)?.code ?? '',
  );

/** restic's final message, with the retry history reduced to a count and the last error (not pages of notices). */
function summarize(text: string): string {
  const { notices, rest } = splitRetries(text);
  const final = rest.slice(-4).join(' | ');
  if (!notices.length) return final;
  const last = notices[notices.length - 1].replace(
    /^.*?returned error, retrying after [^:]*:\s*/i,
    '',
  );
  const retried = `restic retried ${notices.length} time${notices.length === 1 ? '' : 's'}; last error: ${last}`;
  return final ? `${final} (${retried})` : retried;
}

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
  let finished = false;
  // One limit covers the image pull, the helper and every restic command.
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(new ControlBackupError(`restic did not finish within ${Math.round(limit / 1000)}s`)),
      limit,
    );
    // Not unref'd: while a job is pending its limit is what ends it, and the timer is cleared as soon as it finishes.
    const cancel = () => reject(new ControlBackupError('the control backup was cancelled'));
    if (access.signal?.aborted) cancel();
    else access.signal?.addEventListener('abort', cancel, { once: true });
  });
  timeout.catch(() => undefined);
  try {
    await Promise.race([ensureImage(docker, access.resticImage), timeout]);
    // The name is fixed before the helper exists, so a create that hangs and later succeeds is still removed by name.
    const name = `tug-control-backup-${randomBytes(4).toString('hex')}`;
    container = name;
    const creating = docker.createContainer(name, {
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
    });
    // A create that finishes after the job is over (it timed out or was cancelled) must not leave a helper behind.
    creating.then(
      () => {
        if (finished) void docker.removeContainer(name).catch(() => undefined);
      },
      () => undefined,
    );
    await Promise.race([creating, timeout]);
    await Promise.race([docker.startContainer(name), timeout]);
    const id = name;
    const finish = (result: Collected): Collected => ({
      ...result,
      out: redact(result.out),
      err: redact(result.err),
    });
    const stallMs = access.stallMs ?? CONTROL_STALL_MS;
    /** Fails when restic has only been retrying for `stallMs`; any other output counts as progress. */
    const watchStall = (proc: AttachedProcess): { stalled: Promise<never>; stop: () => void } => {
      let lastProgress = Date.now();
      let retrying = false;
      let tail = '';
      let pending = '';
      const seen = (chunk: Buffer) => {
        pending += chunk.toString('utf8');
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          tail = (tail + '\n' + line).slice(-4096);
          if (RETRY_NOTICE.test(line)) retrying = true;
          else {
            lastProgress = Date.now();
            retrying = false;
          }
        }
      };
      proc.stdout.on('data', seen);
      proc.stderr.on('data', seen);
      let interval: NodeJS.Timeout | undefined;
      const stalled = new Promise<never>((_, reject) => {
        interval = setInterval(
          () => {
            if (!retrying || Date.now() - lastProgress < stallMs) return;
            reject(
              new ControlBackupError(
                `restic made no progress for ${Math.round(stallMs / 1000)}s: ${redact(summarize(tail))}`,
              ),
            );
          },
          Math.max(10, Math.min(1000, stallMs / 4)),
        );
      });
      stalled.catch(() => undefined);
      return { stalled, stop: () => clearInterval(interval) };
    };
    const exec: Exec = async (cmd) => {
      const proc = await Promise.race([docker.execStart(id, { cmd }), timeout]);
      const watch = watchStall(proc);
      try {
        return finish(await Promise.race([collect(proc), timeout, watch.stalled]));
      } finally {
        watch.stop();
      }
    };
    /** `write` streams a local file into restic's stdin; `read` streams restic's stdout into a local file. */
    const run = async (cmd: string[], file: string, mode: 'read' | 'write'): Promise<Collected> => {
      const starting = docker.execStart(id, { cmd, stdin: mode === 'write' });
      starting.then(
        (late) => {
          if (finished) late.kill();
        },
        () => undefined,
      );
      const proc = await Promise.race([starting, timeout]);
      // A read sends stdout to the file; collect() still keeps a bounded copy, which is ignored.
      const done = collect(proc);
      const moved =
        mode === 'write'
          ? pipeline(createReadStream(file), proc.stdin!)
          : pipeline(proc.stdout, createWriteStream(file, { mode: 0o600 }));
      const watch = watchStall(proc);
      let settled;
      try {
        settled = await Promise.race([Promise.allSettled([moved, done]), timeout, watch.stalled]);
      } finally {
        watch.stop();
      }
      const [transfer, result] = settled;
      if (result.status === 'rejected') throw result.reason;
      // restic that exits early (a lock timeout, a wrong repository) breaks the pipe and its own message is the cause;
      // any other transfer failure (a full disk, an unreadable archive) is the cause itself.
      if (
        transfer.status === 'rejected' &&
        (result.value.code === 0 || !isPipeBreak(transfer.reason))
      )
        throw transfer.reason;
      return finish(result.value);
    };
    return await work(exec, run);
  } catch (error) {
    if (error instanceof ControlBackupError) throw error;
    throw new ControlBackupError(redact(error instanceof Error ? error.message : String(error)), {
      cause: error,
    });
  } finally {
    finished = true;
    clearTimeout(timer);
    // Bounded, so a Docker daemon that hangs here cannot wedge the job (and with it every later control backup).
    if (container)
      await Promise.race([
        docker.removeContainer(container).catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, REMOVE_LIMIT_MS).unref()),
      ]);
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
  options: { tags?: string[] } = {},
): Promise<ControlPush> {
  return withRestic(docker, access, async (exec, run) => {
    let repository: ControlPush['repository'] = 'ok';
    const probe = await exec(['restic', 'cat', 'config']);
    if (probe.code !== 0) {
      // Only a missing repository is created; a wrong password or an unreachable bucket must fail the backup.
      if (!isMissingRepository(probe.err))
        throw new ControlBackupError(
          `repository check failed: ${summarize(probe.err || probe.out)}`,
        );
      const init = await exec(['restic', 'init']);
      if (init.code !== 0)
        throw new ControlBackupError(`repository init failed: ${summarize(init.err || init.out)}`);
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
        ...(options.tags ?? []).flatMap((tag) => ['--tag', tag]),
        '--retry-lock',
        '10m',
      ],
      archivePath,
      'write',
    );
    if (backup.code !== 0)
      throw new ControlBackupError(`backup failed: ${summarize(backup.err || backup.out)}`);
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
        : { warning: `retention failed: ${summarize(forget.err || forget.out)}` }),
    };
  });
}

/** A restic snapshot id as `tug control backup list` prints it: 8 to 64 hex digits. */
export const CONTROL_SNAPSHOT_ID = /^[0-9a-f]{8,64}$/;

export interface ControlSnapshot {
  id: string;
  shortId: string;
  time: string;
  tags: string[];
  /** Bytes of the archive, when restic reports it (0.17 and newer). */
  sizeBytes?: number;
}

interface ResticSnapshot {
  id?: string;
  short_id?: string;
  time?: string;
  tags?: string[];
  summary?: { total_bytes_processed?: number };
}

/** The snapshots restic printed, whether flat or grouped, newest first; anything unparseable is an error. */
function parseSnapshots(output: string): ControlSnapshot[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new ControlBackupError(
      `restic listed snapshots in an unexpected format: ${summarize(output)}`,
    );
  }
  const list = (Array.isArray(parsed) ? parsed : []).flatMap(
    (entry: ResticSnapshot & { snapshots?: ResticSnapshot[] }) => entry.snapshots ?? [entry],
  );
  return list
    .filter(
      (snapshot): snapshot is Required<Pick<ResticSnapshot, 'id' | 'time'>> & ResticSnapshot =>
        Boolean(snapshot.id && snapshot.time),
    )
    .map((snapshot) => ({
      id: snapshot.id,
      shortId: snapshot.short_id ?? snapshot.id.slice(0, 8),
      time: snapshot.time,
      tags: snapshot.tags ?? [],
      ...(snapshot.summary?.total_bytes_processed === undefined
        ? {}
        : { sizeBytes: snapshot.summary.total_bytes_processed }),
    }))
    .sort((x, y) => y.time.localeCompare(x.time));
}

const SNAPSHOT_FILTER = ['--host', CONTROL_HOST, '--tag', CONTROL_TAG];

/** What the control repository really holds, from the destination itself; `missing` when nothing was ever stored. */
export async function listControlSnapshots(
  docker: DockerApi,
  access: ControlRepositoryAccess,
): Promise<{ state: 'ok' | 'missing'; snapshots: ControlSnapshot[] }> {
  return withRestic(docker, access, async (exec) => {
    const probe = await exec(['restic', 'cat', 'config']);
    if (probe.code !== 0) {
      if (isMissingRepository(probe.err)) return { state: 'missing' as const, snapshots: [] };
      throw new ControlBackupError(
        `cannot read the control repository (wrong control password or credentials, or an unreachable store): ${summarize(probe.err || probe.out)}`,
      );
    }
    const listed = await exec(['restic', 'snapshots', '--json', ...SNAPSHOT_FILTER]);
    if (listed.code !== 0)
      throw new ControlBackupError(
        `could not list the control backups: ${summarize(listed.err || listed.out)}`,
      );
    return { state: 'ok' as const, snapshots: parseSnapshots(listed.out) };
  });
}

/** Writes a control archive of the destination (the newest unless `snapshot` names one) to `destination` (mode 0600). */
export async function fetchControlArchive(
  docker: DockerApi,
  access: ControlRepositoryAccess,
  destination: string,
  snapshot = 'latest',
): Promise<void> {
  if (snapshot !== 'latest' && !CONTROL_SNAPSHOT_ID.test(snapshot))
    throw new ControlBackupError(
      'the snapshot must be an id from `tug control backup list` (8 to 64 hex digits)',
    );
  await withRestic(docker, access, async (exec, run) => {
    const probe = await exec(['restic', 'cat', 'config']);
    if (probe.code !== 0)
      throw new ControlBackupError(
        isMissingRepository(probe.err)
          ? `no control backup was found at ${controlRepository(access.url)}`
          : `cannot read the control repository (wrong control password or credentials, or an unreachable store): ${summarize(probe.err || probe.out)}`,
      );
    if (snapshot !== 'latest') {
      // Only snapshots control itself stored may be restored into control, whatever else the repository holds.
      const listed = await exec(['restic', 'snapshots', snapshot, '--json', ...SNAPSHOT_FILTER]);
      if (listed.code !== 0 || !parseSnapshots(listed.out).length)
        throw new ControlBackupError(
          `snapshot ${snapshot} is not a control backup in ${controlRepository(access.url)}; see \`tug control backup list\``,
        );
    }
    const dump = await run(
      ['restic', 'dump', snapshot, `/${CONTROL_ARCHIVE_NAME}`, ...SNAPSHOT_FILTER],
      destination,
      'read',
    );
    if (dump.code !== 0) {
      await rm(destination, { force: true });
      throw new ControlBackupError(
        `could not read ${snapshot === 'latest' ? 'the latest' : `snapshot ${snapshot} of the`} control backup: ${summarize(dump.err)}`,
      );
    }
  });
}
