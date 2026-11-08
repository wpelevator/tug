import test from 'node:test';
import assert from 'node:assert/strict';
import {
  composeConfigArgs,
  normalizeCompose,
  unescapeDollars,
  sentinelNames,
  substituteSentinels,
} from './normalize.ts';

test('sentinels are found anywhere in a definition and substituted by name', () => {
  const def = { env: { A: 'x@@tug:secret:API_KEY@@y' }, list: ['@@tug:secret:DB@@'] };
  assert.deepEqual(sentinelNames(def).sort(), ['API_KEY', 'DB']);
  assert.equal(substituteSentinels('x@@tug:secret:API_KEY@@y', { API_KEY: 'k' }), 'xky');
  assert.equal(
    substituteSentinels('@@tug:secret:GONE@@', {}),
    '',
    'a missing secret becomes empty',
  );
});

test('normalizeCompose renders with Compose, sets each secret to its sentinel and keeps x-tug', async () => {
  let seen: { args: string[]; env: NodeJS.ProcessEnv } | undefined;
  const compose = await normalizeCompose('app.yml', ['API_KEY'], {
    project: 'site',
    runner: async (_cmd, args, opts) => {
      seen = { args, env: opts.env };
      return {
        out: 'services:\n  web:\n    image: x\n    x-tug:\n      health: {type: tcp}\n',
        err: '',
      };
    },
  });
  assert.deepEqual(seen?.args, composeConfigArgs('app.yml', 'site'));
  assert.ok(
    seen?.args.includes('yaml'),
    'YAML output is requested because JSON drops service x-tug',
  );
  assert.equal(seen?.env.API_KEY, '@@tug:secret:API_KEY@@');
  assert.equal(compose.services.web['x-tug']?.health?.type, 'tcp');
});

test('literal dollars that Compose escapes in its output reach the container as written', async () => {
  const rendered = [
    'services:',
    '  db:',
    '    image: mariadb',
    '    command: sh -c "echo $$HOME $$$$"',
    '    environment:',
    '      PRICE: cost $$5',
    '    x-tug:',
    '      backup:',
    '        command: mariadb-dump -p"$$MARIADB_ROOT_PASSWORD"',
    '        restore: [sh, -c, "mariadb -p$$PW"]',
  ].join('\n');
  const normalized = await normalizeCompose('docker-compose.yml', [], {
    runner: async () => ({ out: rendered, err: '', code: 0 }),
  });
  const db = normalized.services.db as Record<string, any>;
  assert.equal(
    db.command,
    'sh -c "echo $HOME $$"',
    'a doubled dollar becomes one, and $$$$ becomes $$',
  );
  assert.equal(db.environment.PRICE, 'cost $5');
  assert.equal(
    db['x-tug'].backup.command,
    'mariadb-dump -p"$MARIADB_ROOT_PASSWORD"',
    'backup commands are shell text run in the container, so they need the real variable reference',
  );
  assert.deepEqual(db['x-tug'].backup.restore, ['sh', '-c', 'mariadb -p$PW']);
  assert.deepEqual(unescapeDollars({ n: 1, ok: true, none: null, list: ['$$a', 2] }), {
    n: 1,
    ok: true,
    none: null,
    list: ['$a', 2],
  });
});

test('normalizeCompose explains a missing Compose plugin and rejects empty files', async () => {
  await assert.rejects(
    normalizeCompose('a.yml', [], {
      runner: async () => {
        throw Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' });
      },
    }),
    /needs Docker with the Compose plugin/,
  );
  await assert.rejects(
    normalizeCompose('a.yml', [], { runner: async () => ({ out: 'name: x\n', err: '' }) }),
    /defines no services/,
  );
});
