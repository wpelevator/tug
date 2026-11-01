import { Transform } from 'node:stream';
import { redactSecrets } from './backup-destination.ts';
import { LABEL_JOB, LABEL_PROJECT, LABEL_SERVICE } from './container-spec.ts';
import type { AttachedProcess, CreateContainerBody, DockerApi } from './docker-api.ts';
import type {
  BackupCredentialsResponse,
  BackupJobPayload,
  BackupJobResult,
  BackupRetention,
  JobPhase,
} from './protocol.ts';

/** Docker volume holding restic's cache across jobs, so repeated runs do not re-read the repository index. */
export const RESTIC_CACHE_VOLUME = 'tug_restic_cache';
const TAIL_BYTES = 4096;
const OUTPUT_LIMIT = 64 * 1024;

export interface JobContext {
  docker: DockerApi;
  credentials: BackupCredentialsResponse;
  /** Called as the job moves between phases; feeds the agent's heartbeat. */
  onPhase?: (phase: JobPhase, bytes?: number) => void;
  /** Aborts the job (timeout or cancellation); helper containers are removed either way. */
  signal?: AbortSignal;
}

/** `512m`, `2g` or a byte count. */
export function memoryBytes(value: string): number {
  const match = /^(\d+)([kmg]?)$/i.exec(value.trim());
  if (!match) throw new Error(`invalid memory limit ${JSON.stringify(value)}`);
  const unit = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[
    match[2].toLowerCase() as '' | 'k' | 'm' | 'g'
  ];
  return Number(match[1]) * unit;
}

const tagArgs = (tags: string[]): string[] => tags.flatMap((tag) => ['--tag', tag]);

/** `restic forget` arguments applying a retention policy to one target of one node. */
export function forgetArgs(payload: BackupJobPayload, retention: BackupRetention): string[] {
  const keep = (['last', 'hourly', 'daily', 'weekly', 'monthly', 'yearly'] as const).flatMap(
    (key) => (retention[key] ? [`--keep-${key}`, String(retention[key])] : []),
  );
  if (!keep.length) throw new Error('retention would keep no snapshots');
  return [
    'forget',
    '--tag',
    `target:${payload.target}`,
    '--host',
    payload.node,
    '--group-by',
    'host',
    // A safety snapshot taken before a restore must outlive routine retention.
    '--keep-tag',
    'trigger:pre-restore',
    ...keep,
    '--prune',
    '--retry-lock',
    '10m',
  ];
}

/** `restic backup` arguments; `stdinName` selects a dump stream, otherwise `/data` is archived. */
export function backupArgs(payload: BackupJobPayload, stdinName?: string): string[] {
  const common = [
    '--json',
    '--host',
    payload.node,
    ...tagArgs(payload.tags),
    '--retry-lock',
    '10m',
  ];
  if (stdinName) return ['backup', '--stdin', '--stdin-filename', stdinName, ...common];
  const exclude = (payload.volume?.exclude ?? []).flatMap((pattern) => ['--exclude', pattern]);
  return ['backup', '/data', ...exclude, ...common];
}

interface Summary {
  snapshotId?: string;
  addedBytes?: number;
  totalBytes?: number;
}

/** The `summary` line restic prints at the end of `backup --json`. */
export function parseSummary(output: string): Summary {
  for (const line of output.split('\n').reverse()) {
    if (!line.includes('"summary"')) continue;
    try {
      const value = JSON.parse(line) as {
        message_type?: string;
        snapshot_id?: string;
        data_added?: number;
        total_bytes_processed?: number;
      };
      if (value.message_type === 'summary')
        return {
          snapshotId: value.snapshot_id,
          addedBytes: value.data_added,
          totalBytes: value.total_bytes_processed,
        };
    } catch {
      /* a partial line; keep looking */
    }
  }
  return {};
}

interface Collected {
  code: number;
  out: string;
  err: string;
}

function collect(proc: AttachedProcess): Promise<Collected> {
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  let outSize = 0;
  proc.stdout.on('data', (chunk: Buffer) => {
    // Progress output of a long backup would otherwise grow without bound.
    if (outSize < OUTPUT_LIMIT * 4) out.push(chunk);
    outSize += chunk.length;
  });
  proc.stderr.on('data', (chunk: Buffer) => err.push(chunk));
  return new Promise((resolve, reject) => {
    proc.on('error', reject);
    proc.on('close', (code: number | null) =>
      resolve({
        code: code ?? -1,
        out: Buffer.concat(out).toString('utf8'),
        err: Buffer.concat(err).toString('utf8').slice(-OUTPUT_LIMIT),
      }),
    );
  });
}

/** Keeps the end of a stream so the dump trailer can be checked after it passes through. */
class Tail extends Transform {
  tail = Buffer.alloc(0);
  bytes = 0;
  private readonly onBytes: (bytes: number) => void;
  constructor(onBytes: (bytes: number) => void) {
    super();
    this.onBytes = onBytes;
  }
  override _transform(
    chunk: Buffer,
    _encoding: string,
    callback: (error?: Error | null, data?: Buffer) => void,
  ): void {
    this.bytes += chunk.length;
    this.tail = Buffer.concat([this.tail, chunk]).subarray(-TAIL_BYTES);
    this.onBytes(this.bytes);
    callback(null, chunk);
  }
}

export class JobError extends Error {}

async function ensureImage(docker: DockerApi, ref: string): Promise<void> {
  if (await docker.inspectImage(ref)) return;
  await docker.pullImage(ref);
}

function secretValues(credentials: BackupCredentialsResponse): string[] {
  return Object.values(credentials.env);
}

/** Runs one backup job to completion. Helper containers carry the `tug.job` label and are always removed. */
export async function runBackupJob(
  payload: BackupJobPayload,
  commandId: string,
  ctx: JobContext,
  kind: 'backup.run' | 'backup.check' | 'backup.restore' = 'backup.run',
): Promise<BackupJobResult> {
  const started = Date.now();
  const { docker, credentials } = ctx;
  const phase = (value: JobPhase, bytes?: number) => ctx.onPhase?.(value, bytes);
  const redact = (text: string) => redactSecrets(text, secretValues(credentials));
  const created: string[] = [];
  const labels = { [LABEL_JOB]: commandId };
  const name = (suffix: string) => `tug-job-${payload.runId}-${suffix}`;
  const fail = (what: string, detail: string): JobError =>
    new JobError(`${what}: ${redact(detail).trim().split('\n').slice(-6).join(' | ')}`);

  const helper = async (suffix: string, body: CreateContainerBody): Promise<string> => {
    const id = await docker.createContainer(name(suffix), { ...body, Labels: labels });
    created.push(id);
    await docker.startContainer(id);
    return id;
  };

  try {
    phase('pulling');
    await ensureImage(docker, payload.resticImage);
    ctx.signal?.throwIfAborted();

    const binds = [`${RESTIC_CACHE_VOLUME}:/cache`];
    if (payload.repository.startsWith('/'))
      binds.push(`${payload.repository}:${payload.repository}`);
    if (payload.volume) {
      const scratch = kind === 'backup.restore' && payload.restore?.mode === 'scratch';
      const dockerVolume = scratch
        ? (payload.restore?.scratchVolume ?? '')
        : payload.volume.dockerVolume;
      if (scratch) {
        if (!dockerVolume) throw new JobError('a scratch restore needs a scratch volume name');
        if (!(await docker.inspectVolume(dockerVolume)))
          await docker.createVolume(dockerVolume, {
            labels: { 'tug.project': payload.project, 'tug.restore': payload.runId },
          });
      } else if (!(await docker.inspectVolume(dockerVolume)))
        // Docker would silently create an empty volume for a missing name and the backup would succeed with nothing in it.
        throw new JobError(
          `volume ${dockerVolume} does not exist on this node; a volume is created when a service that uses it is placed here`,
        );
      binds.push(`${dockerVolume}:/data${kind === 'backup.restore' ? '' : ':ro'}`);
    }
    const restic = await helper('restic', {
      Image: payload.resticImage,
      Entrypoint: ['sleep'],
      Cmd: ['86400'],
      Env: [
        ...Object.entries(credentials.env).map(([key, value]) => `${key}=${value}`),
        `RESTIC_REPOSITORY=${payload.repository}`,
        'RESTIC_CACHE_DIR=/cache',
        `GOMAXPROCS=2`,
      ],
      HostConfig: { Memory: memoryBytes(payload.limits.memory), Binds: binds },
    });
    const exec = async (cmd: string[]): Promise<Collected> =>
      collect(await docker.execStart(restic, { cmd }));

    const version = (await exec(['restic', 'version'])).out.match(/restic (\d+\.\d+\.\d+)/)?.[1];

    phase('checking');
    let repository: 'ok' | 'initialized' = 'ok';
    const probe = await exec(['restic', 'cat', 'config']);
    if (probe.code !== 0) {
      // Only a missing repository is initialized; a wrong password or an unreachable bucket must fail the job.
      if (
        kind === 'backup.restore' ||
        !/Is there a repository at the following location|does not exist|no such file/i.test(
          probe.err,
        )
      )
        throw fail('repository check failed', probe.err || probe.out);
      const init = await exec(['restic', 'init']);
      if (init.code !== 0) throw fail('repository init failed', init.err || init.out);
      repository = 'initialized';
    }
    if (kind === 'backup.check')
      return {
        runId: payload.runId,
        durationMs: Date.now() - started,
        resticVersion: version,
        repository,
      };

    if (kind === 'backup.restore') {
      const restore = payload.restore;
      if (!restore) throw new JobError('the restore job names no snapshot');
      phase('restoring');
      // Only snapshots this target produced may be restored into it.
      const listed = await exec(['restic', 'snapshots', restore.snapshotId, '--json']);
      const snapshot = (() => {
        try {
          return (JSON.parse(listed.out) as { tags?: string[] }[])[0];
        } catch {
          return undefined;
        }
      })();
      if (listed.code !== 0 || !snapshot)
        throw fail(`snapshot ${restore.snapshotId} was not found in the repository`, listed.err);
      for (const tag of [`project:${payload.project}`, `target:${payload.target}`])
        if (!snapshot.tags?.includes(tag))
          throw new JobError(
            `snapshot ${restore.snapshotId} is not a ${payload.target} backup of project ${payload.project} (missing tag ${tag})`,
          );
      if (payload.command) {
        const { service, filename, restoreArgv } = payload.command;
        if (!restoreArgv)
          throw new JobError(
            `${service} has no x-tug.backup.restore command, so Tug does not know how to load the backup back`,
          );
        const running = (
          await docker.listContainers({
            label: [`${LABEL_PROJECT}=${payload.project}`, `${LABEL_SERVICE}=${service}`],
          })
        ).find((container) => container.State === 'running');
        if (!running) throw new JobError(`service ${service} is not running on this node`);
        const dump = await docker.execStart(restic, {
          cmd: ['restic', 'dump', restore.snapshotId, filename],
        });
        const loader = await docker.execStart(running.Id, { cmd: restoreArgv, stdin: true });
        const reading = collect(dump);
        const loading = collect(loader);
        dump.stdout.pipe(loader.stdin!);
        const [read, loaded] = await Promise.all([reading, loading]);
        if (read.code !== 0) throw fail('could not read the snapshot', read.err);
        if (loaded.code !== 0)
          throw fail(
            `the restore command exited with code ${loaded.code}`,
            loaded.err || loaded.out,
          );
      } else {
        // Replace the volume's contents with the snapshot's; a scratch volume starts empty.
        if (restore.mode === 'in-place') {
          const clear = await exec(['find', '/data', '-mindepth', '1', '-delete']);
          if (clear.code !== 0) throw fail('could not empty the volume', clear.err);
        }
        const result = await exec([
          'restic',
          'restore',
          restore.snapshotId,
          '--target',
          '/',
          '--verify',
        ]);
        if (result.code !== 0) throw fail('restic restore failed', result.err || result.out);
      }
      return {
        runId: payload.runId,
        durationMs: Date.now() - started,
        resticVersion: version,
      };
    }

    let summary: Summary;
    if (payload.command) {
      phase('dumping');
      const { service, argv, filename, verify } = payload.command;
      // The command runs where the service runs: its environment, network, files and installed tools are all there.
      const running = (
        await docker.listContainers({
          label: [`${LABEL_PROJECT}=${payload.project}`, `${LABEL_SERVICE}=${service}`],
        })
      ).find((container) => container.State === 'running');
      if (!running)
        throw new JobError(
          `service ${service} is not running on this node, so there is nothing to back up`,
        );
      const producer = await docker.execStart(running.Id, { cmd: argv });
      const proc = await docker.execStart(restic, {
        cmd: ['restic', ...backupArgs(payload, filename)],
        stdin: true,
      });
      const uploaded = collect(proc);
      const tap = new Tail((bytes) => phase('uploading', bytes));
      const commandStderr: Buffer[] = [];
      producer.stderr.on('data', (chunk: Buffer) => commandStderr.push(chunk));
      producer.stdout.pipe(tap).pipe(proc.stdin!);
      const exit = new Promise<number>((resolve, reject) => {
        producer.on('error', reject);
        producer.on('close', (code: number | null) => resolve(code ?? -1));
      });
      const aborted = new Promise<never>((_, reject) =>
        ctx.signal?.addEventListener('abort', () => {
          producer.kill();
          reject(ctx.signal!.reason);
        }),
      );
      const [result, exitCode] = await Promise.race([Promise.all([uploaded, exit]), aborted]);
      summary = parseSummary(result.out);
      const output = tap.tail.toString('utf8');
      const problem =
        exitCode !== 0
          ? `the command exited with code ${exitCode}`
          : tap.bytes === 0
            ? 'the command produced no output'
            : verify && !output.includes(verify)
              ? `the end of the output does not contain ${JSON.stringify(verify)}, so it was cut short`
              : result.code !== 0
                ? 'the upload to the repository failed'
                : undefined;
      if (problem) {
        // restic snapshots whatever it received, so a failed or cut-short stream must not stay in the catalog.
        let note = '';
        if (summary.snapshotId) {
          const forget = await exec(['restic', 'forget', summary.snapshotId]);
          if (forget.code !== 0) note = ' (the partial snapshot could not be forgotten)';
        }
        throw fail(
          `${problem}${note}`,
          `${Buffer.concat(commandStderr).toString('utf8')}\n${result.err}`,
        );
      }
    } else {
      phase('uploading');
      const result = await exec(['restic', ...backupArgs(payload)]);
      if (result.code !== 0) throw fail('backup failed', result.err || result.out);
      summary = parseSummary(result.out);
    }
    if (!summary.snapshotId)
      throw fail('backup finished without a snapshot', 'restic reported no snapshot id');

    const warnings: string[] = [];
    if (payload.retention) {
      phase('forgetting');
      const forget = await exec(['restic', ...forgetArgs(payload, payload.retention)]);
      // The snapshot is safe; failing to apply retention is reported without failing the backup.
      if (forget.code !== 0)
        warnings.push(
          `retention failed: ${redact(forget.err || forget.out)
            .trim()
            .slice(-300)}`,
        );
    }
    return {
      runId: payload.runId,
      snapshotId: summary.snapshotId,
      addedBytes: summary.addedBytes,
      totalBytes: summary.totalBytes,
      durationMs: Date.now() - started,
      resticVersion: version,
      ...(warnings.length ? { warnings } : {}),
    };
  } finally {
    for (const id of created.reverse()) await docker.removeContainer(id).catch(() => {});
  }
}

/** Removes helper containers left behind by an agent that stopped mid-job. */
export async function removeStaleJobContainers(docker: DockerApi): Promise<number> {
  const stale = await docker.listContainers({ label: [LABEL_JOB] }, true);
  for (const container of stale) await docker.removeContainer(container.Id).catch(() => {});
  return stale.length;
}
