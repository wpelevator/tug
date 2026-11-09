import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  activateRestore,
  finishActivation,
  recoverActivation,
  retireAfterRestore,
} from './restore-activation.ts';
import { openDb } from '../db/db.ts';

async function generation(dir: string, label: string): Promise<void> {
  await fs.mkdir(path.join(dir, 'pki'), { recursive: true });
  await fs.writeFile(path.join(dir, 'tug.db'), `db-${label}`);
  await fs.writeFile(path.join(dir, 'master.key'), `key-${label}`);
  await fs.writeFile(path.join(dir, 'pki', 'ca.crt'), `ca-${label}`);
}
const read = (dir: string, name: string) => fs.readFile(path.join(dir, name), 'utf8');
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-activate-'));
  const dataDir = path.join(root, 'data');
  const restoreDir = path.join(root, 'staged');
  await generation(dataDir, 'old');
  await generation(restoreDir, 'new');
  return { root, dataDir, restoreDir };
}
const names = async (dir: string) => (await fs.readdir(dir)).sort();

test('activation replaces the database, master key and CA together and is finished at the next start', async () => {
  const { root, dataDir, restoreDir } = await setup();
  try {
    await activateRestore({ dataDir, restoreDir });
    assert.deepEqual(
      [
        await read(dataDir, 'tug.db'),
        await read(dataDir, 'master.key'),
        await read(dataDir, 'pki/ca.crt'),
      ],
      ['db-new', 'key-new', 'ca-new'],
      'all three belong to the restored generation',
    );
    const journal = await recoverActivation(dataDir);
    assert.equal(
      journal?.state,
      'committed',
      'the next start sees a committed activation to finish',
    );
    await finishActivation(dataDir, journal!);
    assert.deepEqual(
      (await names(dataDir)).filter((name) => name.startsWith('restore-')),
      [],
      'finishing forgets the journal and the previous generation',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a failure at any step puts the whole previous generation back before the error surfaces', async () => {
  for (const step of ['database', 'master-key', 'pki'] as const) {
    const { root, dataDir, restoreDir } = await setup();
    try {
      await assert.rejects(
        () =>
          activateRestore({
            dataDir,
            restoreDir,
            afterStep: (reached) => {
              if (reached === step) throw new Error(`failed after ${step}`);
            },
          }),
        new RegExp(`failed after ${step}`),
        `a failure after ${step} is reported`,
      );
      assert.deepEqual(
        [
          await read(dataDir, 'tug.db'),
          await read(dataDir, 'master.key'),
          await read(dataDir, 'pki/ca.crt'),
        ],
        ['db-old', 'key-old', 'ca-old'],
        `after a failure following ${step} every file is from the previous generation`,
      );
      assert.deepEqual(
        (await names(dataDir)).filter((name) => name.startsWith('restore-')),
        [],
        'a rolled-back activation leaves nothing behind',
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});

test('a start that finds an interrupted activation rolls it back before opening anything', async () => {
  const { root, dataDir } = await setup();
  try {
    const previous = path.join(dataDir, 'restore-previous-crashed');
    await generation(previous, 'old');
    // The process died after the database was replaced and before the key was.
    await fs.writeFile(path.join(dataDir, 'tug.db'), 'db-new');
    await fs.writeFile(
      path.join(dataDir, 'restore-activation.json'),
      JSON.stringify({ state: 'applying', previous, startedAt: new Date().toISOString() }),
    );
    assert.equal(
      await recoverActivation(dataDir),
      null,
      'nothing is left to finish after a rollback',
    );
    assert.deepEqual(
      [await read(dataDir, 'tug.db'), await read(dataDir, 'master.key')],
      ['db-old', 'key-old'],
      'the database and key belong to one generation again',
    );
    assert.deepEqual(
      (await names(dataDir)).filter((name) => name.startsWith('restore-')),
      [],
      'the journal and the previous generation are removed',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('an interrupted activation that cannot be rolled back stops the start instead of guessing', async () => {
  const { root, dataDir } = await setup();
  try {
    await fs.writeFile(
      path.join(dataDir, 'restore-activation.json'),
      JSON.stringify({
        state: 'applying',
        previous: path.join(dataDir, 'restore-previous-gone'),
        startedAt: 'x',
      }),
    );
    await assert.rejects(
      () => recoverActivation(dataDir),
      /previous state it kept is missing/,
      'a missing previous state is an error',
    );
    await fs.writeFile(path.join(dataDir, 'restore-activation.json'), '{not json');
    await assert.rejects(
      () => recoverActivation(dataDir),
      /unreadable/,
      'an unreadable journal is an error',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('retiring after a restore keeps the history and stops anything from being replayed', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-retire-'));
  const db = await openDb(path.join(root, 'tug.db'));
  try {
    const insertCommand = (id: string, state: string) =>
      db.run(
        "INSERT INTO commands(id,node_id,project_id,type,state,payload_json,created_at,updated_at) VALUES(?,'n','site','volume.delete',?,'{}','t','t')",
        id,
        state,
      );
    for (const state of ['pending', 'running', 'succeeded']) insertCommand(`cmd_${state}`, state);
    const insertRestore = (id: string, state: string) =>
      db.run(
        "INSERT INTO restore_runs(id,project_id,target,snapshot_id,mode,state,started_at) VALUES(?,'site','db','s','in_place',?,'t')",
        id,
        state,
      );
    for (const state of ['locking', 'holding', 'safety_backup', 'restoring', 'succeeded'])
      insertRestore(`rst_${state}`, state);
    db.run(
      "INSERT INTO service_holds(project_id,service,reason,restore_id,created_at) VALUES('site','db','restore','rst_holding','t')",
    );
    const insertRun = (id: string, state: string) =>
      db.run(
        "INSERT INTO backup_runs(id,project_id,target,type,trigger,state,queued_at) VALUES(?,'site','volume:x','volume','manual',?,'t')",
        id,
        state,
      );
    for (const state of ['queued', 'running', 'succeeded']) insertRun(`bkr_${state}`, state);
    const retired = retireAfterRestore(db);
    const state = (table: string, id: string) =>
      (db.get(`SELECT state FROM ${table} WHERE id=?`, id) as { state: string }).state;
    assert.deepEqual(
      ['pending', 'running', 'succeeded'].map((name) => state('commands', `cmd_${name}`)),
      ['cancelled', 'failed', 'succeeded'],
      'queued commands are cancelled, delivered ones fail and finished ones are history',
    );
    assert.deepEqual(
      ['locking', 'holding', 'safety_backup', 'restoring', 'succeeded'].map((name) =>
        state('restore_runs', `rst_${name}`),
      ),
      ['failed', 'failed', 'failed', 'interrupted', 'succeeded'],
      'a restore that had not written fails; one that was writing is interrupted for the operator to resume or release',
    );
    assert.equal(
      db.get('SELECT COUNT(*) AS n FROM service_holds WHERE restore_id=?', 'rst_holding')?.n,
      0,
      'the holds of a restore that failed are released',
    );
    assert.deepEqual(
      ['queued', 'running', 'succeeded'].map(
        (name) =>
          (db.get('SELECT state FROM backup_runs WHERE id=?', `bkr_${name}`) as { state: string })
            .state,
      ),
      ['missed', 'failed', 'succeeded'],
      'a run nobody picked up is missed and one that was running fails, so none shows as in progress for ever',
    );
    assert.deepEqual(
      retired,
      { commands: 2, restores: 4, backupRuns: 2 },
      'the counts say what was retired',
    );
    assert.deepEqual(
      retireAfterRestore(db),
      { commands: 0, restores: 0, backupRuns: 0 },
      'retiring is repeatable',
    );
  } finally {
    db.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
