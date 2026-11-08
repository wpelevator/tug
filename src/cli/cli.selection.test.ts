import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { createTransport } from '../transport.ts';
import { openDb } from '../db/db.ts';
import { startMtlsControl } from '../../tests/helpers.ts';
import { keysFor, menuCount } from './test-keys.ts';

const exec = promisify(execFile);
const terminal = `data:text/javascript,${encodeURIComponent('process.stdin.isTTY = true; process.stdout.isTTY = true;')}`;

test('CLI selections mutate only chosen resources, preserve output and abort without mutations', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-cli-selection-'));
  const control = await startMtlsControl(dir);
  const db = await openDb(path.join(dir, 'tug.db'));
  const transport = createTransport(control.root, control.url);
  const requiredRow = <T>(sql: string): T => {
    const row = db.get<T>(sql);
    assert.ok(row, `the expected database row must exist for: ${sql}`);
    return row;
  };
  const entry = path.resolve('src/cli.ts');
  const api = async (method: string, route: string, body?: unknown) => {
    const response = await transport.http(transport.base + route, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.equal(response.status, 200, `fixture request ${method} ${route} should succeed`);
    return (await response.json()) as Record<string, any>;
  };
  const run = (args: string[], answers: string[] = [], interactive = true) => {
    const running = exec(
      process.execPath,
      [...(interactive ? ['--import', terminal] : []), entry, ...args],
      {
        cwd: dir,
        env: {
          ...process.env,
          ...control.env,
          TUG_CREDENTIAL: '',
          TUG_PROJECT: 'site',
          CI: '',
          FORCE_COLOR: '0',
        },
        timeout: 15000,
      },
    );
    let output = '';
    let answered = 0;
    running.child.stderr!.on('data', (data) => {
      output += String(data);
      const questions = menuCount(output);
      while (answered < questions && answered < answers.length)
        running.child.stdin!.write(keysFor(answers[answered++], output));
    });
    return running;
  };
  try {
    for (const [args, pattern] of [
      [['backup', 'run', 'db', '--select'], /--select cannot be combined/],
      [['hold', 'release', 'web', '--select'], /--select cannot be combined/],
      [['node', 'replace', '--all', '--select'], /--select and --all/],
      [['node', 'repair', 'n1', '--select'], /--all\/--select cannot/],
      [['restore', 'run', '--from', 'latest', '--select-snapshot'], /--select-snapshot cannot/],
      [['restore', 'run', '--writers', 'web', '--select-writers'], /--select-writers cannot/],
      [['restore', 'run', '--scratch', '--select-writers'], /does not apply to scratch/],
      [
        ['credential', 'create', 'invalid', '--role', 'admin', '--select-projects'],
        /requires read\/deploy/,
      ],
    ] as [string[], RegExp][])
      await assert.rejects(
        run(args),
        pattern,
        'conflicting selection flags must fail before prompting or mutation',
      );
    await control.registerNode('n1');
    await control.registerNode('n2');
    await api('POST', '/api/v1/projects', { name: 'site' });
    await api('POST', '/api/v1/projects', { name: 'other' });
    await api('POST', '/api/v1/secrets', { project: 'site', name: 'A', value: 'never-show-me' });
    await api('POST', '/api/v1/secrets', {
      project: 'site',
      name: 'B',
      value: 'never-show-me-either',
    });
    await assert.rejects(
      run(['secret', 'remove'], ['q']),
      /cancelled/,
      'cancelling a resource selection should abort',
    );
    assert.equal(
      requiredRow<{ count: number }>('SELECT count(*) AS count FROM secrets').count,
      2,
      'cancellation must preserve every secret',
    );
    const removed = await run(['secret', 'remove'], ['2']);
    assert.equal(
      JSON.parse(removed.stdout).ok,
      true,
      'selection menus must leave stdout as parseable JSON',
    );
    assert.match(removed.stderr, /A.*version/, 'secret choices should show names and versions');
    assert.ok(!removed.stderr.includes('never-show-me'), 'secret choices must not display values');
    assert.deepEqual(
      (await api('GET', '/api/v1/secrets?project=site')).secrets.map(
        (row: { name: string }) => row.name,
      ),
      ['A'],
      'selection should delete only the chosen secret',
    );

    await run(['node', 'address', '--to', '10.0.0.2'], ['2']);
    assert.equal(
      requiredRow<{ address: string }>("SELECT address FROM nodes WHERE name='n2'").address,
      '10.0.0.2',
      'node address should apply the new value to the chosen node',
    );
    await run(['node', 'ingress'], ['2']);
    assert.equal(
      requiredRow<{ ingress: number }>("SELECT ingress FROM nodes WHERE name='n2'").ingress,
      1,
      'ingress should enable the chosen node',
    );

    db.run(
      "INSERT INTO deployments(id,project_id,version,state,created_at) VALUES('dep_cancel','site','v1','building','2026-11-03')",
    );
    await run(['deploy', 'cancel'], ['1']);
    assert.equal(
      requiredRow<{ state: string }>("SELECT state FROM deployments WHERE id='dep_cancel'").state,
      'cancelled',
      'cancel should submit the chosen deployment ID',
    );

    for (const service of ['db', 'web'])
      db.run(
        'INSERT INTO service_holds(project_id,service,reason) VALUES(?,?,?)',
        'site',
        service,
        'move',
      );
    const released = await run(['hold', 'release', '--select'], ['2']);
    assert.deepEqual(
      JSON.parse(released.stdout).released,
      ['web'],
      'multi-selection must release only named move holds',
    );
    const all = await run(['hold', 'release'], [], false);
    assert.deepEqual(
      JSON.parse(all.stdout).released,
      ['db'],
      'omitting targets must retain the existing release-all behavior',
    );

    const created = await run(
      ['credential', 'create', 'selected', '--role', 'read', '--select-projects'],
      ['3'],
    );
    assert.deepEqual(
      JSON.parse(created.stdout).projects,
      ['site'],
      'credential project selection must pass only chosen scope names',
    );
    assert.ok(
      !created.stdout.includes('Choose'),
      'credential JSON output must exclude prompt text',
    );
    const unrestricted = await run(
      ['credential', 'create', 'unrestricted', '--role', 'read', '--select-projects'],
      ['1'],
    );
    assert.equal(
      JSON.parse(unrestricted.stdout).projects,
      null,
      'choosing all projects must include future projects',
    );

    db.run(
      "INSERT INTO volumes(id,project_id,name,type,config_json) VALUES('vol_x','site','unused','ephemeral','{}')",
    );
    await run(['volume', 'remove'], ['1']);
    assert.equal(
      db.get('SELECT * FROM volumes WHERE id=?', 'vol_x'),
      undefined,
      'volume removal should submit the selected volume name',
    );

    await run(['credential', 'revoke'], ['2']);
    assert.ok(
      requiredRow<{ revoked_at: string }>(
        "SELECT revoked_at FROM operator_credentials WHERE name='selected'",
      ).revoked_at,
      'revoke should submit the selected active credential name',
    );
    await fs.writeFile(path.join(dir, 'tug.yml'), 'nodes:\n  n1:\n    ssh: root@n1\n');
    for (const verb of ['replace', 'repair']) {
      await assert.rejects(
        run(['node', verb, '--select'], ['q']),
        (error: Error & { stderr?: string }) => {
          assert.match(
            error.stderr || '',
            /\[ \] n1/,
            'bulk node choices should include registered nodes with SSH config',
          );
          assert.ok(
            !error.stderr?.includes('n2 ('),
            'bulk node choices should exclude nodes without SSH config',
          );
          return /cancelled/.test(error.message);
        },
        'bulk node selection should cancel before any SSH operation',
      );
    }
    const deployed = await api('POST', '/api/v1/deployments', {
      project: 'site',
      version: 'v-backup',
      compose: {
        'x-tug': { backup: { schedule: '0 3 * * *' } },
        services: {
          db: {
            image: 'mariadb',
            'x-tug': {
              placement: { nodes: ['n1'] },
              backup: { command: 'dump-it', restore: 'load-it', filename: 'db.sql' },
            },
          },
          db2: {
            image: 'mariadb',
            'x-tug': {
              placement: { nodes: ['n1'] },
              backup: { command: 'dump-it', restore: 'load-it', filename: 'db.sql' },
            },
          },
          web: {
            image: 'nginx',
            depends_on: { db: { condition: 'service_started' } },
            'x-tug': { placement: { nodes: ['n1'] } },
          },
        },
      },
    });
    db.run("UPDATE deployments SET state='succeeded' WHERE id=?", deployed.deployment.id);
    await api('POST', '/api/v1/backup/destination', { url: '/tmp/tug-selection-backups', env: {} });
    for (const [id, snapshot, time] of [
      ['bkr_old', 'old-snapshot', '2026-10-01'],
      ['bkr_new', 'new-snapshot', '2026-11-01'],
    ])
      db.run(
        "INSERT INTO backup_runs(id,project_id,target,type,trigger,state,snapshot_id,finished_at) VALUES(?,'site','service:db','command','manual','succeeded',?,?)",
        id,
        snapshot,
        time,
      );
    const preview = await run(
      ['restore', 'run', '--select-snapshot', '--select-writers'],
      ['1', '2', '3'],
    );
    assert.match(
      preview.stdout,
      /snapshot: old-snapshot/,
      'restore should preview the exact selected historical snapshot',
    );
    assert.match(
      preview.stdout,
      /stops: {4}web/,
      'restore writer selection should override automatic discovery',
    );
    assert.equal(
      requiredRow<{ count: number }>('SELECT count(*) AS count FROM restore_runs').count,
      0,
      'interactive selection must not bypass restore --confirm',
    );
    const backups = await run(['backup', 'run', '--select', '--no-wait'], ['2']);
    assert.match(
      backups.stdout,
      /queued service:db2/,
      'backup selection should queue the selected enabled target',
    );
    assert.equal(
      requiredRow<{ count: number }>(
        "SELECT count(*) AS count FROM backup_runs WHERE state='queued' AND target='service:db'",
      ).count,
      0,
      'a backup subset must not queue unselected targets',
    );
    db.run(
      "INSERT INTO restore_runs(id,project_id,target,node_id,snapshot_id,mode,state,started_at) VALUES('rst_old','site','service:db',?,'old-snapshot','in-place','interrupted','2000-01-01')",
      requiredRow<{ id: string }>("SELECT id FROM nodes WHERE name='n1'").id,
    );
    for (let index = 0; index < 25; index++)
      db.run(
        "INSERT INTO restore_runs(id,project_id,target,snapshot_id,mode,state,started_at) VALUES(?,'site','service:db','new-snapshot','in-place','succeeded','2099-01-01')",
        'rst_done_' + index,
      );
    await run(['restore', 'resume'], ['1']);
    assert.equal(
      requiredRow<{ state: string }>("SELECT state FROM restore_runs WHERE id='rst_old'").state,
      'restoring',
      'resume selection must find an interrupted restore beyond the recent history limit',
    );
    db.run("UPDATE restore_runs SET state='interrupted' WHERE id='rst_old'");
    await run(['restore', 'release'], ['1']);
    assert.equal(
      requiredRow<{ state: string }>("SELECT state FROM restore_runs WHERE id='rst_old'").state,
      'released',
      'release selection should release the selected interrupted restore',
    );

    for (const args of [
      ['logs'],
      ['inspect'],
      ['restart'],
      ['scale', '--replicas', '2'],
      ['exec'],
      ['deploy', 'cancel'],
      ['restore', 'run'],
      ['restore', 'resume'],
      ['restore', 'release'],
      ['secret', 'remove'],
      ['volume', 'remove'],
      ['credential', 'revoke'],
      ['backup', 'run', '--select'],
      ['hold', 'release', '--select'],
      ['node', 'replace'],
      ['node', 'repair'],
      ['node', 'disable'],
      ['node', 'remove'],
      ['node', 'ingress'],
      ['node', 'address', '--to', '10.0.0.1'],
      ['doctor', '--node'],
    ]) {
      await assert.rejects(
        run(args, [], false),
        /selection requires a terminal outside CI/,
        `${args.join(' ')} must fail promptly without reading piped stdin`,
      );
    }
    await run(['node', 'disable'], ['2']);
    assert.ok(
      requiredRow<{ disabled_at: string }>("SELECT disabled_at FROM nodes WHERE name='n2'")
        .disabled_at,
      'disable must block only the chosen node',
    );
    await run(['node', 'remove'], ['2']);
    assert.equal(
      db.get("SELECT * FROM nodes WHERE name='n2'"),
      undefined,
      'remove must delete only the chosen unreferenced node',
    );
  } finally {
    void transport.close();
    db.close();
    await control.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
