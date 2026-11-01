import test from 'node:test';
import assert from 'node:assert/strict';
import {
  commandArgv,
  defaultJitterSeconds,
  parseBackupTimeout,
  resolveBackups,
} from './backup-config.ts';
import { validateCompose } from './compose.ts';
import { normalized } from '../tests/fake-docker.ts';
import type { ComposeFile } from './protocol.ts';

/** A site: one service backed up by a command, and uploads backed up as files. Nothing here is specific to a database. */
function site(overrides: Record<string, unknown> = {}): ComposeFile {
  return normalized({
    'x-tug': { backup: { schedule: '0 3 * * *', retention: { daily: 7 } } },
    services: {
      db: {
        image: 'mariadb:11.4',
        volumes: ['db-data:/var/lib/mysql'],
        'x-tug': {
          placement: { nodes: ['app1'] },
          backup: {
            command: 'mariadb-dump -u root -p"$MARIADB_ROOT_PASSWORD" --databases wordpress',
            filename: 'wordpress.sql',
            verify: '-- Dump completed',
          },
        },
      },
      web: {
        image: 'wordpress:6',
        volumes: ['uploads:/var/www/html/wp-content/uploads'],
        'x-tug': { placement: { nodes: ['app1'] } },
      },
    },
    volumes: {
      'db-data': {},
      uploads: { 'x-tug': { placement: { nodes: ['app1'] }, backup: true } },
    },
    ...overrides,
  });
}

const errorsOf = (compose: ComposeFile) => resolveBackups(compose, 'site').errors;
const backupOf = (compose: ComposeFile) =>
  compose.services.db['x-tug']!.backup as Record<string, unknown>;

test('a service resolves to its command and a volume to its files, with project defaults', () => {
  const { targets, errors } = resolveBackups(site(), 'site');
  assert.deepEqual(errors, [], 'a valid site should have no backup errors');
  const db = targets.find((t) => t.target === 'service:db');
  assert.equal(db?.type, 'command', 'a service backup stores command output');
  assert.deepEqual(
    db?.command,
    ['sh', '-c', 'mariadb-dump -u root -p"$MARIADB_ROOT_PASSWORD" --databases wordpress'],
    'a string command runs through sh -c in the service container',
  );
  assert.equal(db?.filename, 'wordpress.sql');
  assert.equal(db?.verify, '-- Dump completed');
  assert.equal(db?.schedule, '0 3 * * *', 'the project schedule is the default');
  assert.deepEqual(db?.retention, { daily: 7 }, 'the project retention is the default');
  assert.equal(db?.timeoutSec, 7200, 'the timeout defaults to two hours');
  assert.equal(db?.node, 'app1', 'a literal single placement is the backup node');
  const uploads = targets.find((t) => t.target === 'volume:uploads');
  assert.equal(uploads?.type, 'volume', 'volumes store their files');
  assert.equal(uploads?.node, 'app1', 'a volume is backed up on its placement node');
});

test('the filename defaults to the service name and a list command is used as written', () => {
  const compose = site();
  backupOf(compose).command = ['pg_dump', '-U', 'app', 'appdb'];
  delete backupOf(compose).filename;
  delete backupOf(compose).verify;
  const db = resolveBackups(compose, 'site').targets.find((t) => t.name === 'db');
  assert.deepEqual(db?.command, ['pg_dump', '-U', 'app', 'appdb']);
  assert.equal(db?.filename, 'db.out');
  assert.equal(db?.verify, undefined, 'verification is optional');
});

test('without project defaults the retention falls back to 7 daily, 4 weekly and 6 monthly', () => {
  const compose = site();
  delete compose['x-tug'];
  backupOf(compose).schedule = '@daily';
  const db = resolveBackups(compose, 'site').targets.find((t) => t.name === 'db');
  assert.deepEqual(
    db?.retention,
    { daily: 7, weekly: 4, monthly: 6 },
    'built-in retention applies',
  );
  assert.equal(db?.schedule, '@daily');
});

test('a cron string on a volume is its schedule and false disables a target', () => {
  const compose = site();
  compose.volumes!.uploads['x-tug']!.backup = '30 4 * * *';
  assert.equal(
    resolveBackups(compose, 'site').targets.find((t) => t.name === 'uploads')?.schedule,
    '30 4 * * *',
  );
  compose.volumes!.uploads['x-tug']!.backup = false;
  compose.services.db['x-tug']!.backup = false;
  assert.deepEqual(resolveBackups(compose, 'site'), { targets: [], errors: [] });
});

test('a service backup needs an explicit command: Tug does not guess what a service is', () => {
  const compose = site();
  compose.services.db['x-tug']!.backup = true;
  assert.match(errorsOf(compose).join('; '), /db: x-tug\.backup\.command is required/);
  compose.services.db['x-tug']!.backup = { command: '' };
  assert.match(errorsOf(compose).join('; '), /command must be a non-empty string or list/);
  compose.services.db['x-tug']!.backup = { command: [] };
  assert.match(errorsOf(compose).join('; '), /command must be a non-empty string or list/);
});

test('a target without a schedule and without a project default is rejected', () => {
  const compose = site();
  delete compose['x-tug'];
  assert.match(errorsOf(compose).join('; '), /db: x-tug\.backup needs a schedule/);
});

test('unknown keys, bad crons, empty retention, bad jitter and bad timeout are each rejected', () => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ colour: 'red' }, /x-tug\.backup\.colour is not supported/],
    [{ type: 'mariadb' }, /x-tug\.backup\.type is not supported/],
    [{ schedule: '61 * * * *' }, /x-tug\.backup\.schedule: minute 61/],
    [{ retention: {} }, /retention is empty/],
    [{ retention: { daily: 0 } }, /retention\.daily must be a whole number of at least 1/],
    [{ retention: { fortnightly: 2 } }, /retention\.fortnightly is not supported/],
    [{ jitter: -1 }, /jitter must be a whole number of seconds/],
    [{ timeout: '10s' }, /timeout must be a duration from 1m to 24h/],
    [{ timeout: '48h' }, /timeout must be a duration from 1m to 24h/],
    [{ timeout: 'soon' }, /timeout must be a duration from 1m to 24h/],
    [{ filename: '../etc/passwd' }, /filename must be a plain file name/],
    [{ verify: '' }, /verify must be text that appears at the end of the output/],
    [{ exclude: ['cache/'] }, /exclude is not supported on a service/],
  ];
  for (const [change, message] of cases) {
    const compose = site();
    Object.assign(backupOf(compose), change);
    assert.match(
      errorsOf(compose).join('; '),
      message,
      `${JSON.stringify(change)} should be rejected`,
    );
  }
});

test('project defaults reject unknown keys and bad values', () => {
  const compose = site();
  compose['x-tug'] = { backup: { schedule: 'nope', retention: {}, jitter: 3 } as never };
  assert.throws(() => validateCompose(compose), /x-tug\.backup\.jitter is not supported/);
  assert.throws(() => validateCompose(compose), /x-tug\.backup\.schedule: schedule "nope"/);
  assert.throws(() => validateCompose(compose), /x-tug\.backup\.retention is empty/);
});

test('a service backup must be a single instance', () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ global: true }, 'global'],
    [{ replicas: 2 }, 'replicated'],
    [{ placement: { nodes: ['app1', 'app2'] } }, 'several nodes'],
  ];
  for (const [change, label] of cases) {
    const compose = site();
    Object.assign(compose.services.db['x-tug']!, change);
    assert.match(
      errorsOf(compose).join('; '),
      /needs a single instance/,
      `${label} should be rejected`,
    );
  }
});

test('a service placed by label is accepted and left without a literal node', () => {
  const compose = site();
  compose.services.db['x-tug']!.placement = { labels: ['role=db'] } as never;
  const db = resolveBackups(compose, 'site').targets.find((t) => t.name === 'db');
  assert.equal(db?.node, undefined, 'label placement resolves at deploy time');
});

test('volume options: command keys and bad excludes are rejected', () => {
  const compose = site();
  compose.volumes!.uploads['x-tug']!.backup = {
    command: 'tar c /data',
    filename: 'x.tar',
    exclude: [''],
  } as never;
  const message = errorsOf(compose).join('; ');
  assert.match(message, /command is not supported on a volume; a volume backup archives its files/);
  assert.match(message, /filename is not supported on a volume/);
  assert.match(message, /exclude must be a list of restic exclude patterns/);
});

test('a volume used on several nodes without a pin is rejected, a pin makes it valid', () => {
  const compose = site();
  compose.volumes!.shared = { 'x-tug': { backup: true } };
  compose.services.web.volumes!.push({ type: 'volume', source: 'shared', target: '/shared' });
  compose.services.worker = {
    image: 'alpine',
    volumes: [{ type: 'volume', source: 'shared', target: '/shared' }],
    'x-tug': { placement: { nodes: ['app2'] } },
  };
  assert.match(
    errorsOf(compose).join('; '),
    /volumes\.shared: x-tug\.backup needs one node: volume shared is used on app1, app2/,
  );
  compose.volumes!.shared['x-tug']!.placement = { nodes: ['app1'] };
  assert.deepEqual(errorsOf(compose), [], 'x-tug.placement.nodes pins the volume');
});

test('a volume whose services are placed by label needs an explicit pin', () => {
  const compose = site();
  compose.volumes!.shared = { 'x-tug': { backup: true } };
  compose.services.worker = {
    image: 'alpine',
    volumes: [{ type: 'volume', source: 'shared', target: '/shared' }],
    'x-tug': { placement: { labels: ['role=app'] } },
  } as never;
  assert.match(errorsOf(compose).join('; '), /needs x-tug\.placement\.nodes on volume shared/);
});

test('a volume and a command backup may cover the same data: Tug does not second-guess the operator', () => {
  const compose = site();
  compose.volumes!['db-data'] = { 'x-tug': { backup: true } };
  assert.deepEqual(errorsOf(compose), [], 'no service-specific rule rejects this');
});

test('writers must name services', () => {
  const compose = site();
  Object.assign(backupOf(compose), { writers: ['web', 'ghost'] });
  assert.match(errorsOf(compose).join('; '), /writers: ghost is not a service/);
});

test('validateCompose reports backup errors with the rest of the file', () => {
  const compose = site();
  Object.assign(backupOf(compose), { schedule: 'x' });
  assert.throws(() => validateCompose(compose), /db: x-tug\.backup\.schedule/);
  assert.doesNotThrow(() => validateCompose(site()), 'a valid backup configuration should pass');
});

test('the helper memory limit defaults to 512m and can be lowered for small hosts', () => {
  const compose = site();
  assert.equal(
    resolveBackups(compose, 'site').targets.find((t) => t.name === 'db')?.memory,
    '512m',
  );
  Object.assign(backupOf(compose), { memory: '256M' });
  compose.volumes!.uploads['x-tug']!.backup = { memory: '1g' };
  const { targets, errors } = resolveBackups(compose, 'site');
  assert.deepEqual(errors, []);
  assert.equal(targets.find((t) => t.name === 'db')?.memory, '256m', 'case is normalized');
  assert.equal(targets.find((t) => t.name === 'uploads')?.memory, '1g', 'volumes take it too');
  for (const bad of ['64m', '32g', 'lots', '512 MB', '']) {
    Object.assign(backupOf(compose), { memory: bad });
    assert.match(
      errorsOf(compose).join('; '),
      /memory must be a size from 128m to 16g/,
      `${bad} is rejected`,
    );
  }
});

test('commands normalize to an argv', () => {
  assert.deepEqual(commandArgv('echo hi'), ['sh', '-c', 'echo hi']);
  assert.deepEqual(commandArgv(['a', 'b']), ['a', 'b']);
  assert.equal(commandArgv('  '), null);
  assert.equal(commandArgv(['a', '']), null);
  assert.equal(commandArgv(42), null);
});

test('timeouts parse seconds, minutes and hours and reject everything else', () => {
  assert.equal(parseBackupTimeout('90s'), 90);
  assert.equal(parseBackupTimeout('30m'), 1800);
  assert.equal(parseBackupTimeout('2h'), 7200);
  assert.equal(parseBackupTimeout(600), 600);
  assert.equal(parseBackupTimeout('1d'), null);
  assert.equal(parseBackupTimeout(1.5), null);
});

test('the default jitter is stable per target, below 900 seconds, and differs between targets', () => {
  const a = defaultJitterSeconds('site', 'service:db');
  assert.equal(
    a,
    defaultJitterSeconds('site', 'service:db'),
    'the same target gets the same delay',
  );
  assert.ok(a >= 0 && a < 900, 'the delay stays under 15 minutes');
  const spread = new Set(
    Array.from({ length: 20 }, (_, i) => defaultJitterSeconds(`site${i}`, 'service:db')),
  );
  assert.ok(spread.size > 10, 'twenty sites should not all start together');
});
