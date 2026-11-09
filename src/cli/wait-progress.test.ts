import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Command } from 'commander';
import { writeStubDocker } from '../../tests/helpers.ts';
import { Pki, identityUri, serverNames } from '../pki.ts';
import { serverTlsOptions } from '../control/tls-server.ts';
import { resetVersionChecks, setResolvedConfig, waitForCommand } from './commands/context.ts';
import { packageVersion } from '../images/image.ts';
import { registerBackup } from './commands/backup.ts';
import { registerRestore } from './commands/restore.ts';
import { registerDeploy } from './commands/deploy.ts';
import { registerNode } from './commands/node.ts';
import { registerControl } from './commands/control.ts';

test('long-wait commands report progress on stderr and retain their results and wait semantics', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-wait-progress-'));
  const pki = await Pki.load(dir, true);
  const issued = await pki.issueServer(serverNames('https://localhost:8443'));
  const { credential } = await pki.issueClient(
    identityUri('operator', 'test'),
    86_400_000,
    'https://localhost:8443',
  );
  let routes: Record<string, unknown> = {};
  const requested: string[] = [];
  const bodies: Record<string, unknown> = {};
  const server = https.createServer(serverTlsOptions({ ...issued, ca: pki.caPem }), (req, res) => {
    const route = `${req.method} ${req.url?.split('?')[0]}`;
    requested.push(route);
    // The CLI's version preflight runs before any API request route inside the same process.
    res.setHeader('x-tug-version', packageVersion());
    if (route === 'GET /api/v1/version') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ v: packageVersion() }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        bodies[route] = JSON.parse(Buffer.concat(chunks).toString());
      } catch {
        delete bodies[route];
      }
      const body = routes[route];
      res.writeHead(body === undefined ? 500 : 200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify(
          (typeof body === 'function' ? body() : body) ?? { error: 'unexpected route' },
        ),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  setResolvedConfig({
    file: path.join(dir, 'tug.yml'),
    localFile: path.join(dir, 'tug.local.yml'),
    fileExists: false,
    controlUrl: `https://127.0.0.1:${(server.address() as AddressInfo).port}`,
    credential,
    project: 'site',
    commandDefaults: {},
    nodeDefaults: {},
    nodes: {},
  });
  const out: string[] = [];
  const err: string[] = [];
  t.mock.method(console, 'log', (line: string) => out.push(line));
  t.mock.method(console, 'error', (line: string) => err.push(line));
  t.mock.method(process.stderr, 'write', (line: string) => {
    err.push(line);
    return true;
  });
  const run = async (...args: string[]) => {
    out.length = 0;
    err.length = 0;
    requested.length = 0;
    // One CLI process is one new module state: forget the remembered version agreement between runs.
    resetVersionChecks();
    const program = new Command();
    registerBackup(program);
    registerRestore(program);
    registerDeploy(program);
    registerControl(program);
    registerNode(program);
    await program.parseAsync(args, { from: 'user' });
  };
  const originalExitCode = process.exitCode;
  try {
    await t.test('target selection validation completes before progress starts', async () => {
      await assert.rejects(
        run('backup', 'run', 'service:db', '--select'),
        /--select cannot be combined with explicit targets/,
        'backup selection must still reject conflicting targets before queueing work',
      );
      assert.deepEqual(requested, [], 'invalid backup selection must not contact control');
      assert.deepEqual(
        err,
        [],
        'backup progress must not start while target selection is unresolved',
      );
      await assert.rejects(
        run('restore', 'run', 'service:db', '--select-snapshot', '--from', 'latest'),
        /--select-snapshot cannot be combined with --from/,
        'restore selection must still reject conflicting snapshot options',
      );
      assert.deepEqual(requested, [], 'invalid restore selection must not contact control');
      assert.deepEqual(err, [], 'restore progress must not start before selection validation');
    });
    await t.test(
      'rollback reports state and keeps JSON clean, with no-wait skipping polling',
      async () => {
        routes = {
          'POST /api/v1/rollback': { deployment: { id: 'dep1', state: 'rolling_out' } },
          'GET /api/v1/deployments/dep1': { id: 'dep1', state: 'succeeded' },
        };
        await run('rollback', '--json');
        assert.equal(
          JSON.parse(out.join('')).deployment.state,
          'succeeded',
          'rollback JSON must contain only its final result',
        );
        assert.match(
          err.join(''),
          /Deployment dep1: rolling_out.*Deployment dep1: succeeded/s,
          'rollback must report observed deployment state changes',
        );
        await run('rollback', '--json', '--no-wait');
        assert.deepEqual(
          requested,
          ['GET /api/v1/version', 'POST /api/v1/rollback'],
          'no-wait rollback must not poll deployments (the version preflight runs once per process)',
        );
        assert.doesNotMatch(
          err.join(''),
          /Deployment dep1:/,
          'no-wait rollback must skip rollout stages',
        );
      },
    );
    await t.test('backup reports pending targets, success and no-wait', async () => {
      routes = {
        'POST /api/v1/backups/run': { runs: [{ runId: 'b1', target: 'service:db' }], errors: [] },
        'GET /api/v1/backups': {
          runs: [
            {
              id: 'b1',
              target: 'service:db',
              state: 'succeeded',
              snapshot_id: '123456789',
              added_bytes: 1024,
            },
          ],
        },
      };
      await run('backup', 'run');
      assert.match(
        err.join(''),
        /Waiting for backups: service:db/,
        'backup waits must identify their targets immediately',
      );
      assert.match(
        out.join(''),
        /snapshot 12345678/,
        'successful backup summaries must remain on stdout',
      );
      await run('backup', 'run', '--no-wait');
      assert.deepEqual(
        requested,
        ['GET /api/v1/version', 'POST /api/v1/backups/run'],
        'no-wait backup must not poll runs (the version preflight runs once per process)',
      );
      assert.doesNotMatch(
        err.join(''),
        /Waiting for backups/,
        'no-wait backup must skip wait progress',
      );
    });
    await t.test('backup timeout preserves nonzero exit and running-work explanation', async () => {
      await run('backup', 'run', '--timeout', '0');
      assert.equal(process.exitCode, 1, 'backup timeouts must exit nonzero');
      assert.match(
        err.join(''),
        /keep running on the node/,
        'backup timeout must explain that remote work continues',
      );
      process.exitCode = originalExitCode;
    });
    await t.test(
      'restore reports queued and terminal state, and preview does not wait',
      async () => {
        const plan = {
          target: 'volume:data',
          node: 'n1',
          snapshotId: 'snap1',
          mode: 'scratch',
          scratchVolume: 'recovered',
          writers: [],
          safetyBackup: false,
        };
        routes = {
          'POST /api/v1/restores': { confirmed: true, plan, restoreId: 'r1' },
          'GET /api/v1/restores': {
            restores: [{ id: 'r1', state: 'succeeded', scratch_volume: 'recovered' }],
          },
        };
        await run('restore', 'run', 'volume:data', '--confirm');
        assert.match(
          err.join(''),
          /Restore r1: queued.*Restore r1: succeeded/s,
          'restores must report queued and observed state changes',
        );
        assert.match(
          out.join(''),
          /files are in volume recovered/,
          'restore completion must retain its recovered volume location',
        );
        routes['POST /api/v1/restores'] = { confirmed: false, plan };
        await run('restore', 'run', 'volume:data');
        assert.deepEqual(
          requested,
          ['GET /api/v1/version', 'POST /api/v1/restores'],
          'restore preview must never poll or execute a restore (the version preflight runs once per process)',
        );
        assert.doesNotMatch(err.join(''), /Restore r1:/, 'restore preview must skip wait progress');
      },
    );
    await t.test(
      'backup and restore report intermediate states and restore interruptions fail',
      async () => {
        let polls = 0;
        routes = {
          'POST /api/v1/backups/run': { runs: [{ runId: 'b1', target: 'service:db' }], errors: [] },
          'GET /api/v1/backups': () => ({
            runs: [
              {
                id: 'b1',
                target: 'service:db',
                state: ++polls === 1 ? 'running' : 'failed',
                error: 'backup failed',
              },
            ],
          }),
        };
        await run('backup', 'run');
        assert.match(
          err.join(''),
          /Backups: service:db: running/,
          'backup progress must report the observed state of pending targets',
        );
        assert.equal(process.exitCode, 1, 'failed backups must still exit nonzero');
        process.exitCode = originalExitCode;
        polls = 0;
        routes = {
          'POST /api/v1/restores': {
            confirmed: true,
            restoreId: 'r1',
            plan: {
              target: 'service:db',
              node: 'n1',
              snapshotId: 'snap1',
              mode: 'in-place',
              writers: ['web'],
              safetyBackup: true,
            },
          },
          'GET /api/v1/restores': () => ({
            restores: [
              {
                id: 'r1',
                state: ++polls === 1 ? 'restoring' : 'interrupted',
                error: 'restore failed',
              },
            ],
          }),
        };
        await run('restore', 'run', 'service:db', '--confirm');
        assert.match(
          err.join(''),
          /Restore r1: restoring.*Restore r1: interrupted/s,
          'restore progress must report observed intermediate and terminal states',
        );
        assert.match(
          err.join(''),
          /services stay stopped/,
          'restore interruptions must retain the recovery instructions',
        );
        assert.equal(process.exitCode, 1, 'interrupted restores must still exit nonzero');
        process.exitCode = originalExitCode;
      },
    );
    await t.test('queued command waits report states and preserve failure results', async () => {
      err.length = 0;
      routes = {
        'GET /api/v1/commands/c1': { state: 'failed', result_json: '{"error":"offline"}' },
      };
      const result = await waitForCommand('c1');
      assert.equal(
        result.state,
        'failed',
        'command waits must return the terminal result for callers to handle',
      );
      assert.match(
        err.join(''),
        /Command c1: failed/,
        'shared waits for restart, logs and doctor must report observed states',
      );
    });
    await t.test('node installs report stages and only wait when requested', async () => {
      const previousPath = process.env.PATH;
      const bin = path.join(dir, 'bin');
      await fs.mkdir(bin);
      await writeStubDocker(bin);
      await fs.writeFile(
        path.join(bin, 'ssh'),
        '#!' +
          process.execPath +
          '\nif (process.argv.at(-1).includes("agent identity")) process.stdout.write("csr");\n',
        { mode: 0o755 },
      );
      process.env.PATH = bin + path.delimiter + previousPath;
      routes = {
        'POST /api/v1/nodes/n1/identity': { node: { id: 'n1', name: 'n1' } },
        'GET /api/v1/nodes': { nodes: [{ name: 'n1', last_seen_at: '2099-01-01T00:00:00.000Z' }] },
      };
      try {
        await run('node', 'add', 'root@n1', '--name', 'n1', '--no-wait', '-y');
        assert.doesNotMatch(
          err.join(''),
          /Waiting for node/,
          'no-wait node installs must skip reporting waits',
        );
        assert.ok(
          !requested.includes('GET /api/v1/nodes'),
          'no-wait node installs must not poll reporting',
        );
        await run('node', 'add', 'root@n1', '--name', 'n1', '-y');
        assert.equal(
          JSON.parse(out.join('')).reporting,
          true,
          'node installs must still return their reporting result',
        );
        assert.match(
          err.join(''),
          /Checking host n1.*Creating identity for node n1.*Installing agent on node n1.*Waiting for node n1 to report/s,
          'node installs must report preparation, identity, installation and reporting stages',
        );
      } finally {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
      }
    });
    await t.test('control backup and restore keep JSON results on stdout', async () => {
      routes = {
        'POST /api/v1/control/backups/run': { artifactRef: 'backup.tgz' },
        'POST /api/v1/control/restore': { restartRequired: true },
      };
      await run('control', 'backup');
      assert.equal(
        JSON.parse(out.join('')).artifactRef,
        'backup.tgz',
        'control backup must retain its JSON result',
      );
      assert.match(
        err.join(''),
        /Creating control-plane backup/,
        'control backup must report its active operation',
      );
      await run('control', 'restore', 'backup.tgz', '--confirm');
      assert.equal(
        JSON.parse(out.join('')).restartRequired,
        true,
        'control restore must retain its restart instruction',
      );
      assert.match(
        err.join(''),
        /Restoring control-plane backup/,
        'control restore must report its active operation',
      );
    });
    await t.test(
      'control backup --download saves a private copy and never overwrites',
      async () => {
        routes = {
          'POST /api/v1/control/backups/run': { backupId: 'cbak_x', artifactRef: '/data/x.tar.gz' },
          'GET /api/v1/control/backups/cbak_x/download': { archive: true },
        };
        const file = path.join(dir, 'saved.tar.gz');
        await run('control', 'backup', '--download', '-o', file);
        assert.equal(
          JSON.parse(out.join('')).downloadedTo,
          file,
          'the result names where the archive was saved',
        );
        assert.equal(
          await fs.readFile(file, 'utf8'),
          JSON.stringify({ archive: true }),
          'the downloaded bytes are written to the chosen file',
        );
        assert.equal(
          (await fs.stat(file)).mode & 0o777,
          0o600,
          'the archive holds the master key and the CA key, so only its owner may read it',
        );
        await assert.rejects(
          run('control', 'backup', '-o', file),
          /already exists/,
          'an existing file is never overwritten',
        );
        assert.equal(
          await fs.readFile(file, 'utf8'),
          JSON.stringify({ archive: true }),
          'a refused overwrite leaves the earlier archive intact',
        );
        assert.deepEqual(
          requested.filter((route) => route === 'POST /api/v1/control/backups/run'),
          [],
          'a taken output name is refused before a backup is created on control',
        );
        const previous = process.cwd();
        process.chdir(dir);
        try {
          await run('control', 'backup', '--download');
        } finally {
          process.chdir(previous);
        }
        assert.ok(
          await fs.stat(path.join(dir, 'tug-control-backup-cbak_x.tar.gz')),
          '--download without -o saves ./tug-control-backup-<id>.tar.gz',
        );
        await run('control', 'backup');
        assert.ok(
          !requested.includes('GET /api/v1/control/backups/cbak_x/download'),
          'without --download nothing is downloaded',
        );
      },
    );
    await t.test(
      'control restore --from-destination sends the login and rejects mixed targets',
      async () => {
        routes = { 'POST /api/v1/control/restore': { restartRequired: true } };
        await assert.rejects(
          run('control', 'restore', '--confirm'),
          /either an archive path or --from-destination/,
          'a restore must name its source',
        );
        await assert.rejects(
          run('control', 'restore', 'a.tgz', '--from-destination', 's3:https://h/b', '--confirm'),
          /either an archive path or --from-destination/,
          'a restore has one source',
        );
        await assert.rejects(
          run('control', 'restore', 'a.tgz', '--env', 'AWS_ACCESS_KEY_ID', '--confirm'),
          /--env goes with --from-destination/,
          'credential variables only make sense for a destination',
        );
        process.env.TUG_TEST_KEY = 'AKIA1';
        process.env.TUG_TEST_SECRET = 'secret1';
        process.env.TUG_CONTROL_BACKUP_PASSWORD =
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
        try {
          await run(
            'control',
            'restore',
            '--from-destination',
            's3:https://s3.example.com/bucket/tug',
            '--env',
            'TUG_TEST_KEY,TUG_TEST_SECRET',
            '--confirm',
          );
        } finally {
          delete process.env.TUG_TEST_KEY;
          delete process.env.TUG_TEST_SECRET;
          delete process.env.TUG_CONTROL_BACKUP_PASSWORD;
        }
        assert.deepEqual(
          bodies['POST /api/v1/control/restore'],
          {
            fromDestination: {
              url: 's3:https://s3.example.com/bucket/tug',
              env: { TUG_TEST_KEY: 'AKIA1', TUG_TEST_SECRET: 'secret1' },
              password: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            },
            confirm: true,
          },
          'the destination, its credential values and the control password are sent to control',
        );
      },
    );
    await t.test('backup password --control asks for the control repository', async () => {
      routes = {
        'GET /api/v1/backup/repository-password': {
          control: true,
          repository: 's3:x/_control',
          password: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
      };
      await run('backup', 'password', '--control');
      assert.equal(
        JSON.parse(out.join('')).control,
        true,
        'the control password is printed as JSON on stdout',
      );
    });
  } finally {
    process.exitCode = originalExitCode;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(dir, { recursive: true, force: true });
  }
});
