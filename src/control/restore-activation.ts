import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { advanceWhere } from '../db/lifecycle.ts';
import { backupRunLifecycle, commandLifecycle, restoreLifecycle } from '../db/lifecycles.ts';
import type { Db } from '../db/db.ts';

/**
 * Putting a validated control backup in place changes three files that only work together: the database, the master
 * key that decrypts its secrets and the CA that agents and operators trust. They are replaced one after another, so
 * a crash between two of them would leave a database that cannot be read or agents that cannot connect.
 *
 * Activation therefore keeps the previous generation next to the data directory and records what it is doing in a
 * journal. A start that finds \`applying\` puts the previous generation back before anything is opened. A start that
 * finds \`committed\` runs the after-restore work (see {@link retireAfterRestore}) and then forgets the journal.
 */
const JOURNAL = 'restore-activation.json';
const PREVIOUS_PREFIX = 'restore-previous-';
const FILES = ['tug.db', 'master.key'] as const;

export interface Activation {
  state: 'applying' | 'committed';
  previous: string;
  startedAt: string;
}

export type ActivationStep = 'database' | 'master-key' | 'pki';

const exists = async (target: string): Promise<boolean> =>
  Boolean(await fs.stat(target).catch(() => null));

/** Copies through a temporary name so a reader never sees half a file. */
async function replaceFile(from: string, to: string): Promise<void> {
  const temporary = `${to}.restoring-${randomBytes(4).toString('hex')}`;
  await fs.copyFile(from, temporary);
  await fs.chmod(temporary, 0o600);
  await fs.rename(temporary, to);
}

async function removeDatabaseSidecars(dataDir: string): Promise<void> {
  await fs.rm(path.join(dataDir, 'tug.db-wal'), { force: true });
  await fs.rm(path.join(dataDir, 'tug.db-shm'), { force: true });
}

async function writeJournal(dataDir: string, journal: Activation): Promise<void> {
  const target = path.join(dataDir, JOURNAL);
  const temporary = `${target}.tmp`;
  const handle = await fs.open(temporary, 'w', 0o600);
  try {
    await handle.writeFile(JSON.stringify(journal));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, target);
}

/** Puts the files of \`previous\` back, replacing whatever generation is there now. */
async function rollBack(dataDir: string, previous: string): Promise<void> {
  await removeDatabaseSidecars(dataDir);
  for (const name of FILES)
    if (await exists(path.join(previous, name)))
      await replaceFile(path.join(previous, name), path.join(dataDir, name));
  if (await exists(path.join(previous, 'pki'))) {
    await fs.rm(path.join(dataDir, 'pki'), { recursive: true, force: true });
    await fs.cp(path.join(previous, 'pki'), path.join(dataDir, 'pki'), { recursive: true });
  }
}

/**
 * Replaces the database, master key and PKI with the ones staged in \`restoreDir\`. The database must already be
 * closed. On any failure the previous generation is put back before the error is thrown, so the data directory is
 * never left holding a mix.
 */
export async function activateRestore(options: {
  dataDir: string;
  restoreDir: string;
  /** Test hook: runs after each step and may throw to simulate a crash or a failed write. */
  afterStep?: (step: ActivationStep) => void | Promise<void>;
}): Promise<void> {
  const { dataDir, restoreDir } = options;
  const previous = path.join(
    dataDir,
    `${PREVIOUS_PREFIX}${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`,
  );
  await fs.mkdir(previous, { mode: 0o700 });
  for (const name of FILES)
    if (await exists(path.join(dataDir, name)))
      await fs.copyFile(path.join(dataDir, name), path.join(previous, name));
  if (await exists(path.join(dataDir, 'pki')))
    await fs.cp(path.join(dataDir, 'pki'), path.join(previous, 'pki'), { recursive: true });
  const journal: Activation = { state: 'applying', previous, startedAt: new Date().toISOString() };
  await writeJournal(dataDir, journal);
  try {
    await removeDatabaseSidecars(dataDir);
    await replaceFile(path.join(restoreDir, 'tug.db'), path.join(dataDir, 'tug.db'));
    await options.afterStep?.('database');
    await replaceFile(path.join(restoreDir, 'master.key'), path.join(dataDir, 'master.key'));
    await options.afterStep?.('master-key');
    await fs.cp(path.join(restoreDir, 'pki'), path.join(dataDir, 'pki'), {
      recursive: true,
      // The server certificate is regenerated for this control's own address.
      filter: (source) => path.basename(source) !== 'server.json',
    });
    await options.afterStep?.('pki');
  } catch (error) {
    await rollBack(dataDir, previous);
    await fs.rm(path.join(dataDir, JOURNAL), { force: true });
    await fs.rm(previous, { recursive: true, force: true });
    throw error;
  }
  await writeJournal(dataDir, { ...journal, state: 'committed' });
}

/**
 * Called before anything in the data directory is opened. An interrupted activation is rolled back; a committed one
 * is returned so the caller can run {@link retireAfterRestore} once the database is open.
 */
export async function recoverActivation(dataDir: string): Promise<Activation | null> {
  const raw = await fs.readFile(path.join(dataDir, JOURNAL), 'utf8').catch(() => null);
  if (raw === null) return null;
  let journal: Activation;
  try {
    journal = JSON.parse(raw) as Activation;
  } catch {
    throw new Error(
      `${path.join(dataDir, JOURNAL)} is unreadable; a control restore may have been interrupted. Restore the data directory from a backup or remove the file if the data is known to be whole`,
    );
  }
  if (journal.state === 'committed') return journal;
  if (
    !path.basename(journal.previous).startsWith(PREVIOUS_PREFIX) ||
    !(await exists(journal.previous))
  )
    throw new Error(
      'a control restore was interrupted and the previous state it kept is missing; restore the data directory from a backup',
    );
  await rollBack(dataDir, journal.previous);
  await fs.rm(path.join(dataDir, JOURNAL), { force: true });
  await fs.rm(journal.previous, { recursive: true, force: true });
  console.error('a control restore was interrupted; the previous state was put back');
  return null;
}

/** Forgets a committed activation and the previous generation it kept. */
export async function finishActivation(dataDir: string, journal: Activation): Promise<void> {
  await fs.rm(path.join(dataDir, JOURNAL), { force: true });
  if (path.basename(journal.previous).startsWith(PREVIOUS_PREFIX))
    await fs.rm(journal.previous, { recursive: true, force: true });
}

export interface Retired {
  commands: number;
  restores: number;
  backupRuns: number;
}

/**
 * A backup holds the commands that were queued or in flight when it was taken, and the workload restores that were
 * under way. Delivering them again after a restore would repeat work against a world that has moved on (a
 * \`volume.delete\` for a volume that has since been recreated under the same name). They stay in the history but
 * are retired before the restored control accepts any agent work: queued commands are cancelled, their backup runs are missed, commands that were
 * delivered fail, a restore that had not touched data fails and a restore that was writing is \`interrupted\`, which
 * keeps its writers stopped until the operator resumes or releases it.
 */
export function retireAfterRestore(db: Db): Retired {
  const at = new Date().toISOString();
  const reason = 'control was restored from a backup; this was not carried over';
  const commands =
    advanceWhere(
      db,
      commandLifecycle,
      'pending',
      'cancelled',
      { sql: '1=1' },
      {
        updated_at: at,
        result_json: JSON.stringify({ error: reason }),
      },
    ) +
    advanceWhere(
      db,
      commandLifecycle,
      'running',
      'failed',
      { sql: '1=1' },
      {
        updated_at: at,
        result_json: JSON.stringify({ error: reason }),
      },
    );
  // A workload backup run is tied to the command that carries it. With the command retired the run would stay queued
  // (or running) for ever and show as a backup in progress, so it is closed too: a run nobody picked up is missed, one
  // that was running fails.
  const backupRuns =
    advanceWhere(
      db,
      backupRunLifecycle,
      'queued',
      'missed',
      { sql: '1=1' },
      { error: reason, finished_at: at },
    ) +
    advanceWhere(
      db,
      backupRunLifecycle,
      'running',
      'failed',
      { sql: '1=1' },
      { error: reason, finished_at: at },
    );
  const untouched = db.all<{ id: string }>(
    "SELECT id FROM restore_runs WHERE state IN ('locking','holding','safety_backup')",
  );
  let restores = 0;
  for (const run of untouched) db.run('DELETE FROM service_holds WHERE restore_id=?', run.id);
  restores += advanceWhere(
    db,
    restoreLifecycle,
    ['locking', 'holding', 'safety_backup'],
    'failed',
    { sql: '1=1' },
    { error: reason, state_changed_at: at, finished_at: at },
  );
  restores += advanceWhere(
    db,
    restoreLifecycle,
    'restoring',
    'interrupted',
    { sql: '1=1' },
    {
      error: `${reason}; the data may be partly restored, resume or release it`,
      state_changed_at: at,
    },
  );
  return { commands, restores, backupRuns };
}
