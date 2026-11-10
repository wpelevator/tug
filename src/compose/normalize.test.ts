import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
    composeCli: true,
    runner: async (_cmd, args, opts) => {
      seen = { args, env: opts.env };
      return {
        out: 'services:\n  web:\n    image: x\n    x-tug:\n      health: {type: tcp}\n',
        err: '',
      };
    },
  });
  const envFile = seen?.args[seen.args.indexOf('--env-file') + 1];
  assert.ok(envFile, 'Compose is told to read an empty env file instead of its implicit .env');
  assert.deepEqual(seen?.args, composeConfigArgs('app.yml', 'site', envFile));
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
    composeCli: true,
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
      composeCli: true,
      runner: async () => {
        throw Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' });
      },
    }),
    /needs Docker with the Compose plugin/,
  );
  await assert.rejects(
    normalizeCompose('a.yml', [], {
      composeCli: true,
      runner: async () => ({ out: 'name: x\n', err: '' }),
    }),
    /defines no services/,
  );
});

async function composeProject(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-normalize-'));
  for (const [name, text] of Object.entries(files)) await fs.writeFile(path.join(dir, name), text);
  return path.join(dir, 'compose.yaml');
}

test('normalizeCompose reads values only from control: not the shell, not .env, not env_file', async () => {
  const file = await composeProject({
    'compose.yaml':
      'services:\n  web:\n    image: nginx:${TAG}\n    environment:\n      DB_PASSWORD: ${DB_PASSWORD}\n      HOST: ${HOST:-default.example}\n      LEAK: ${TUG_TEST_SHELL}\n',
    '.env': 'TAG=from-dotenv\nHOST=from-dotenv\n',
  });
  process.env.TUG_TEST_SHELL = 'from-shell';
  try {
    const compose = await normalizeCompose(file, ['DB_PASSWORD'], { vars: { TAG: 'v7' } });
    const web = compose.services.web as Record<string, any>;
    assert.equal(web.image, 'nginx:v7', 'a variable from control is interpolated');
    assert.equal(
      web.environment.DB_PASSWORD,
      '@@tug:secret:DB_PASSWORD@@',
      'a secret stays a sentinel for the agent to fill in',
    );
    assert.equal(
      web.environment.HOST,
      'default.example',
      '.env is not read, so the file default applies',
    );
    assert.equal(web.environment.LEAK, '', 'an exported shell variable is not read');
  } finally {
    delete process.env.TUG_TEST_SHELL;
  }
  const envFile = await composeProject({
    'compose.yaml': 'services:\n  web:\n    image: x\n    env_file: app.env\n',
    'app.env': 'A=1\n',
  });
  await assert.rejects(
    normalizeCompose(envFile, []),
    /env_file app\.env is not read/,
    'an env_file is refused rather than read from the deploy machine',
  );
});

test('normalizeCompose selects profiles only from the explicit option', async () => {
  const file = await composeProject({
    'compose.yaml':
      'services:\n  web:\n    image: x\n  debug:\n    image: y\n    profiles: [debug]\n',
  });
  process.env.COMPOSE_PROFILES = 'debug';
  try {
    assert.deepEqual(
      Object.keys((await normalizeCompose(file, [])).services),
      ['web'],
      'COMPOSE_PROFILES in the shell is not read',
    );
    assert.deepEqual(
      Object.keys((await normalizeCompose(file, [], { profiles: ['debug'] })).services).sort(),
      ['debug', 'web'],
      '--profile enables a profile',
    );
  } finally {
    delete process.env.COMPOSE_PROFILES;
  }
});

test('the Compose CLI path runs with a scrubbed environment, an empty env file and explicit values only', async () => {
  const file = await composeProject({
    'compose.yaml': 'services:\n  web:\n    image: x\n',
    '.env': 'TAG=from-dotenv\n',
  });
  process.env.TUG_TEST_SHELL = 'from-shell';
  process.env.COMPOSE_PROJECT_NAME = 'from-shell';
  let seen: { args: string[]; env: NodeJS.ProcessEnv; envFileText?: string } | undefined;
  try {
    await normalizeCompose(file, ['API_KEY'], {
      composeCli: true,
      vars: { TAG: 'v7' },
      profiles: ['debug', 'ops'],
      runner: async (_cmd, args, opts) => {
        const envFile = args[args.indexOf('--env-file') + 1];
        seen = { args, env: opts.env, envFileText: await fs.readFile(envFile, 'utf8') };
        return { out: 'services:\n  web:\n    image: x\n', err: '' };
      },
    });
  } finally {
    delete process.env.TUG_TEST_SHELL;
    delete process.env.COMPOSE_PROJECT_NAME;
  }
  assert.equal(
    seen?.envFileText,
    '',
    'Compose reads an empty file instead of the .env next to the Compose file',
  );
  assert.equal(seen?.env.TUG_TEST_SHELL, undefined, 'a shell variable does not reach Compose');
  assert.equal(
    seen?.env.COMPOSE_PROJECT_NAME,
    undefined,
    'Compose settings in the shell do not reach it either',
  );
  assert.ok(seen?.env.PATH, 'Compose still finds Docker through PATH');
  assert.equal(seen?.env.TAG, 'v7', 'a variable from control is passed');
  assert.equal(seen?.env.API_KEY, '@@tug:secret:API_KEY@@', 'a secret is passed as its sentinel');
  assert.equal(seen?.env.COMPOSE_PROFILES, 'debug,ops', 'profiles are the explicit ones');
  const withEnvFile = await composeProject({
    'compose.yaml': 'services:\n  web:\n    image: x\n    env_file: app.env\n',
  });
  await assert.rejects(
    normalizeCompose(withEnvFile, [], {
      composeCli: true,
      runner: async () => ({ out: '', err: '' }),
    }),
    /env_file, which is not read/,
    'the Compose CLI path refuses env_file too, since Compose would read it',
  );
});
