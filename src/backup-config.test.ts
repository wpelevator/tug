import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultJitterSeconds, parseBackupTimeout, resolveBackups } from './backup-config.ts';
import { validateCompose } from './compose.ts';
import { normalized } from '../tests/fake-docker.ts';
import type { ComposeFile } from './protocol.ts';

/** A WordPress site: MariaDB with a dump backup, uploads on an NFS volume exported by `store1`. */
function site(overrides: Record<string, unknown> = {}): ComposeFile {
  return normalized({
    'x-tug': { backup: { schedule: '0 3 * * *', retention: { daily: 7 } } },
    services: {
      db: {
        image: 'mariadb:11.4',
        environment: {
          MARIADB_DATABASE: 'wordpress',
          MARIADB_ROOT_PASSWORD: '${DB_ROOT_PASSWORD}',
        },
        volumes: ['db-data:/var/lib/mysql'],
        'x-tug': { placement: { nodes: ['app1'] }, backup: true },
      },
      web: {
        image: 'wordpress:6',
        depends_on: { db: { condition: 'service_started' } },
        volumes: ['uploads:/var/www/html/wp-content/uploads'],
        'x-tug': { placement: { nodes: ['app1'] } },
      },
    },
    volumes: {
      'db-data': {},
      uploads: { 'x-tug': { type: 'nfs', placement: { nodes: ['store1'] }, backup: true } },
    },
    ...overrides,
  });
}

const errorsOf = (compose: ComposeFile) => resolveBackups(compose, 'site').errors;

test('a database service and an NFS volume resolve with defaults, inferred type and exporter node', () => {
  const { targets, errors } = resolveBackups(site(), 'site');
  assert.deepEqual(errors, [], 'a valid site should have no backup errors');
  const db = targets.find((t) => t.target === 'service:db');
  assert.equal(db?.type, 'mariadb', 'the type is inferred from the mariadb image');
  assert.deepEqual(db?.databases, ['wordpress'], 'databases default to MARIADB_DATABASE');
  assert.equal(db?.user, 'root', 'the user defaults to root');
  assert.equal(
    db?.passwordSecret,
    'MARIADB_ROOT_PASSWORD',
    'the password secret defaults to the root password variable',
  );
  assert.equal(db?.schedule, '0 3 * * *', 'the project schedule is the default');
  assert.deepEqual(db?.retention, { daily: 7 }, 'the project retention is the default');
  assert.equal(db?.timeoutSec, 7200, 'the timeout defaults to two hours');
  assert.equal(db?.node, 'app1', 'a literal single placement is the backup node');
  const uploads = targets.find((t) => t.target === 'volume:uploads');
  assert.equal(uploads?.type, 'volume', 'volumes use the volume type');
  assert.equal(uploads?.node, 'store1', 'an NFS volume is backed up on its exporter');
});

test('without project defaults the retention falls back to 7 daily, 4 weekly and 6 monthly', () => {
  const compose = site();
  delete compose['x-tug'];
  compose.services.db['x-tug']!.backup = '@daily';
  const db = resolveBackups(compose, 'site').targets.find((t) => t.name === 'db');
  assert.deepEqual(
    db?.retention,
    { daily: 7, weekly: 4, monthly: 6 },
    'built-in retention applies',
  );
  assert.equal(db?.schedule, '@daily', 'a string is the schedule');
});

test('mysql and percona images infer the mysql type and the MySQL variables', () => {
  const compose = site();
  compose.services.db.image = 'docker.io/percona/percona-server:8.0@sha256:abc';
  delete compose.services.db.environment;
  compose.services.db.environment = { MYSQL_DATABASE: 'blog' };
  compose.services.db['x-tug']!.backup = { type: 'mysql' };
  const db = resolveBackups(compose, 'site').targets.find((t) => t.name === 'db');
  assert.equal(db?.passwordSecret, 'MYSQL_ROOT_PASSWORD', 'mysql uses MYSQL_ROOT_PASSWORD');
  assert.deepEqual(db?.databases, ['blog'], 'databases come from MYSQL_DATABASE');
  const inferred = site();
  inferred.services.db.image = 'mysql:8';
  assert.equal(
    resolveBackups(inferred, 'site').targets.find((t) => t.name === 'db')?.type,
    'mysql',
  );
});

test('false disables a target and leaves no schedule', () => {
  const compose = site();
  compose.services.db['x-tug']!.backup = false;
  compose.volumes!.uploads['x-tug']!.backup = false;
  assert.deepEqual(
    resolveBackups(compose, 'site'),
    { targets: [], errors: [] },
    'false should opt out quietly',
  );
});

test('a target without a schedule and without a project default is rejected', () => {
  const compose = site();
  delete compose['x-tug'];
  assert.match(errorsOf(compose).join('; '), /db: x-tug\.backup needs a schedule/);
});

test('unknown keys, bad crons, empty retention, bad jitter and bad timeout are each rejected', () => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ colour: 'red' }, /x-tug\.backup\.colour is not supported/],
    [{ schedule: '61 * * * *' }, /x-tug\.backup\.schedule: minute 61/],
    [{ retention: {} }, /retention is empty/],
    [{ retention: { daily: 0 } }, /retention\.daily must be a whole number of at least 1/],
    [{ retention: { fortnightly: 2 } }, /retention\.fortnightly is not supported/],
    [{ jitter: -1 }, /jitter must be a whole number of seconds/],
    [{ timeout: '10s' }, /timeout must be a duration from 1m to 24h/],
    [{ timeout: '48h' }, /timeout must be a duration from 1m to 24h/],
    [{ timeout: 'soon' }, /timeout must be a duration from 1m to 24h/],
  ];
  for (const [spec, message] of cases) {
    const compose = site();
    compose.services.db['x-tug']!.backup = spec as never;
    assert.match(
      errorsOf(compose).join('; '),
      message,
      `${JSON.stringify(spec)} should be rejected`,
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

test('a database image that cannot be inferred needs an explicit type, and a volume type is refused on a service', () => {
  const compose = site();
  compose.services.db.image = 'ghcr.io/acme/custom-db:1';
  assert.match(errorsOf(compose).join('; '), /db: x-tug\.backup\.type is required/);
  compose.services.db['x-tug']!.backup = { type: 'volume' };
  assert.match(errorsOf(compose).join('; '), /type volume is declared on the top-level volume/);
});

test('database targets need database names, a password secret and no volume-only options', () => {
  const noDb = site();
  delete noDb.services.db.environment;
  assert.match(errorsOf(noDb).join('; '), /db: x-tug\.backup\.databases must list database names/);
  const user = site();
  user.services.db['x-tug']!.backup = { user: 'backup' };
  assert.match(errorsOf(user).join('; '), /password is required when user is not root/);
  const exclude = site();
  exclude.services.db['x-tug']!.backup = { exclude: ['cache/'] };
  assert.match(errorsOf(exclude).join('; '), /exclude only applies to volume backups/);
});

test('a service backup must be a single instance', () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ global: true }, 'global'],
    [{ replicas: 2 }, 'replicated'],
    [{ placement: { nodes: ['app1', 'app2'] } }, 'several nodes'],
  ];
  for (const [change, label] of cases) {
    const compose = site();
    Object.assign(compose.services.db['x-tug']!, { backup: true }, change);
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

test('volume options: service-only keys, wrong type and bad excludes are rejected', () => {
  const compose = site();
  compose.volumes!.uploads['x-tug']!.backup = {
    databases: ['x'],
    type: 'mariadb',
    exclude: [''],
  } as never;
  const message = errorsOf(compose).join('; ');
  assert.match(message, /type must be volume for a volume/);
  assert.match(message, /databases only applies to database service backups/);
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

test('an NFS volume backup must name its exporter', () => {
  const compose = site();
  delete compose.volumes!.uploads['x-tug']!.placement;
  assert.match(errorsOf(compose).join('; '), /NFS volume uploads is backed up on its exporter/);
});

test('a raw copy of the volume holding a backed-up database is rejected', () => {
  const compose = site();
  compose.volumes!['db-data'] = { 'x-tug': { backup: true } };
  assert.match(
    errorsOf(compose).join('; '),
    /volume db-data holds the data of db, which has its own database backup/,
  );
});

test('writers must name services', () => {
  const compose = site();
  compose.services.db['x-tug']!.backup = { writers: ['web', 'ghost'] };
  assert.match(errorsOf(compose).join('; '), /writers: ghost is not a service/);
});

test('validateCompose reports backup errors with the rest of the file', () => {
  const compose = site();
  compose.services.db['x-tug']!.backup = { schedule: 'x' };
  assert.throws(() => validateCompose(compose), /db: x-tug\.backup\.schedule/);
  assert.doesNotThrow(
    () => validateCompose(site()),
    'a valid backup configuration should pass validation',
  );
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
