import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { startMtlsControl } from '../../../tests/helpers.ts';

const exec = promisify(execFile);
const entry = path.resolve('src/cli.ts');

async function withControl(
  run: (ctx: {
    dir: string;
    tug: (args: string[], stdin?: string) => Promise<{ stdout: string; stderr: string }>;
    fails: (args: string[]) => Promise<string>;
    register: () => Promise<unknown>;
  }) => Promise<void>,
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-vars-cli-'));
  const control = await startMtlsControl(dir);
  const tug = (args: string[], stdin?: string) => {
    const child = exec(process.execPath, [entry, ...args], {
      cwd: dir,
      env: {
        ...process.env,
        ...control.env,
        TUG_CREDENTIAL: '',
        TUG_PROJECT: 'site',
        CI: '1',
        // A value only the shell has; Tug must not read it.
        TUG_TEST_SHELL: 'from-shell',
        COMPOSE_PROFILES: 'debug',
      },
      timeout: 15_000,
    });
    if (stdin !== undefined) child.child.stdin!.end(stdin);
    return child;
  };
  try {
    await run({
      dir,
      tug,
      fails: async (args) => {
        try {
          await tug(args);
        } catch (error) {
          return (error as { stderr: string }).stderr;
        }
        assert.fail(`tug ${args.join(' ')} should have failed`);
      },
      register: () => control.registerNode('n1'),
    });
  } finally {
    await control.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('var set, list and remove manage visible values, and list --values shows them', async () => {
  await withControl(async ({ tug }) => {
    const set = await tug(['var', 'set', 'TAG', '--value', 'v1']);
    assert.deepEqual(
      JSON.parse(set.stdout),
      { ok: true, name: 'TAG', version: 1 },
      'a variable is set',
    );
    const names = JSON.parse((await tug(['var', 'list'])).stdout);
    assert.deepEqual(
      names.vars.map((v: Record<string, unknown>) => [v.name, 'value' in v]),
      [['TAG', false]],
      'the plain listing shows names only',
    );
    const values = JSON.parse((await tug(['var', 'list', '--values'])).stdout);
    assert.equal(values.vars[0].value, 'v1', '--values shows the value');
    await tug(['var', 'remove', 'TAG']);
    assert.deepEqual(
      JSON.parse((await tug(['var', 'list'])).stdout).vars,
      [],
      'the variable is removed',
    );
  });
});

test('--from-file keeps every newline and space, and cannot be combined with --value', async () => {
  await withControl(async ({ dir, tug, fails }) => {
    const exact = '-----BEGIN KEY-----\nabc \n-----END KEY-----\n\n';
    await fs.writeFile(path.join(dir, 'key.pem'), exact);
    await tug(['var', 'set', 'PEM', '--from-file', 'key.pem']);
    await tug(['var', 'set', 'PIPED', '--from-file', '-'], exact);
    const { vars } = JSON.parse((await tug(['var', 'list', '--values'])).stdout);
    const byName = Object.fromEntries(
      vars.map((v: { name: string; value: string }) => [v.name, v.value]),
    );
    assert.equal(byName.PEM, exact, 'a file is stored byte for byte, trailing newlines included');
    assert.equal(byName.PIPED, exact, '--from-file - reads all of stdin without trimming');
    assert.match(
      await fails(['var', 'set', 'X', '--value', 'a', '--from-file', 'key.pem']),
      /--value or --from-file, not both/,
      'the two sources are exclusive',
    );
  });
});

test('a name cannot be a secret and a variable, and the CLI says which command frees it', async () => {
  await withControl(async ({ tug, fails }) => {
    await tug(['secret', 'set', 'DB_PASSWORD', '--value', 'x']);
    assert.match(
      await fails(['var', 'set', 'DB_PASSWORD', '--value', 'y']),
      /tug secret remove DB_PASSWORD/,
      'setting a variable over a secret names the remedy',
    );
  });
});

test('secret import stores secrets by default and variables when named; var import stores variables', async () => {
  await withControl(async ({ dir, tug }) => {
    await fs.writeFile(
      path.join(dir, '.env'),
      'DB_PASSWORD=hunter2\nAPP_ENV=production\nREGION=eu-west-1\nBARE\n',
    );
    const imported = await tug(['secret', 'import', '--vars', 'APP_ENV']);
    assert.ok(
      !imported.stdout.includes('hunter2') && !imported.stderr.includes('hunter2'),
      'an imported value is never printed',
    );
    assert.match(
      imported.stdout,
      /DB_PASSWORD\s+secret/,
      'without a terminal an entry is a secret',
    );
    assert.match(imported.stdout, /APP_ENV\s+variable/, 'a name given to --vars is a variable');
    assert.match(
      imported.stdout,
      /REGION\s+secret/,
      'the safe default for an unnamed entry is a secret',
    );
    assert.match(
      imported.stderr,
      /BARE \(no value\)/,
      'an entry without a value is reported as skipped',
    );
    const secrets = JSON.parse((await tug(['secret', 'list'])).stdout).secrets.map(
      (s: { name: string }) => s.name,
    );
    assert.deepEqual(secrets.sort(), ['DB_PASSWORD', 'REGION'], 'the secrets are stored');
    const again = await tug(['secret', 'import', '--vars', 'APP_ENV']);
    assert.match(
      again.stderr,
      /DB_PASSWORD: already a secret/,
      'a second import skips what exists',
    );
    const viaVar = await tug(['var', 'import', '--secrets', 'DB_PASSWORD', '--overwrite']);
    assert.match(
      viaVar.stdout,
      /APP_ENV\s+variable/,
      'var import with --overwrite replaces a variable',
    );
    assert.match(
      viaVar.stderr,
      /REGION: already a secret, not a variable/,
      'var import never converts an existing secret',
    );
  });
});

const COMPOSE = [
  'services:',
  '  web:',
  '    image: nginx:${TAG}',
  '    environment:',
  '      DB_PASSWORD: ${DB_PASSWORD}',
  '      REGION: ${REGION}',
  '      MODE: ${MODE:-production}',
  '',
].join('\n');

test('deploy --dry-run says where every value comes from and ignores .env and the shell', async () => {
  await withControl(async ({ dir, tug, fails }) => {
    await fs.writeFile(path.join(dir, 'compose.yaml'), COMPOSE);
    await fs.writeFile(path.join(dir, '.env'), 'TAG=from-dotenv\nREGION=from-dotenv\nOTHER=1\n');
    await tug(['secret', 'set', 'DB_PASSWORD', '--value', 'hunter2']);
    await tug(['var', 'set', 'REGION', '--value', 'eu']);
    const message = await fails(['deploy', '--dry-run']);
    assert.match(message, /TAG/, 'a name only .env has is missing');
    assert.match(
      message,
      /does not read your shell environment or \.env/,
      'the error says plainly which sources Tug does not read',
    );
    const dry = await tug(['deploy', '--dry-run', '--var', 'TAG=abc,def']);
    assert.match(dry.stdout, /TAG\s+--var\s+abc,def/, 'a --var shows its value');
    const unused = await tug(['deploy', '--dry-run', '--var', 'TAG=a', '--var', 'NOT_USED=1']);
    assert.match(
      unused.stderr,
      /--var NOT_USED is not referenced in .*; it is ignored/,
      'a --var the Compose file never references is reported as ignored',
    );
    assert.match(
      dry.stdout,
      /DB_PASSWORD\s+secret\s+•••/,
      'a secret shows bullets, never its value',
    );
    assert.match(dry.stdout, /REGION\s+var\s+eu/, 'a stored variable shows its value');
    assert.match(dry.stdout, /MODE\s+default/, 'a name only the file defaults is marked default');
    assert.ok(!dry.stdout.includes('hunter2'), 'the secret value is never printed');
    assert.ok(!dry.stdout.includes('from-dotenv'), 'a value from .env is not used');
    assert.match(
      dry.stderr,
      /Values: 1 secret, 1 var, 1 --var \(TAG\), 1 default/,
      'a one-line summary',
    );
    assert.match(
      dry.stderr,
      /Ignored \.env.*3 names, 3 not set on control \(TAG, REGION, OTHER\)|Ignored \.env.*not set on control/,
      'the ignored .env is reported with the names control lacks',
    );
    assert.match(
      dry.stderr,
      /Ignored COMPOSE_PROFILES=debug/,
      'a shell COMPOSE_PROFILES is reported as ignored',
    );
  });
});

test('deploy refuses a --var that is a secret, and never guesses that another name is private', async () => {
  await withControl(async ({ dir, tug, fails }) => {
    await fs.writeFile(path.join(dir, 'compose.yaml'), COMPOSE);
    await tug(['secret', 'set', 'DB_PASSWORD', '--value', 'x']);
    assert.match(
      await fails([
        'deploy',
        '--dry-run',
        '--var',
        'DB_PASSWORD=y',
        '--var',
        'TAG=a',
        '--var',
        'REGION=r',
      ]),
      /--var DB_PASSWORD conflicts with the project secret/,
      'a --var never replaces a secret',
    );
    await tug(['var', 'set', 'TAG', '--value', 'a']);
    await tug(['var', 'set', 'REGION', '--value', 'r']);
    const named = await tug([
      'deploy',
      '--dry-run',
      '--var',
      'REGION=r2',
      '--var',
      'API_TOKEN=abc',
    ]);
    assert.ok(
      !/looks like a credential/.test(named.stderr),
      'a name is never second-guessed: the operator chose --var',
    );
    assert.match(named.stderr, /--var API_TOKEN is not referenced/, 'an unused --var is reported');
  });
});

test('var set says it takes effect on the next deploy and that variables are visible', async () => {
  await withControl(async ({ tug }) => {
    const set = await tug(['var', 'set', 'TAG', '--value', 'v1']);
    assert.deepEqual(
      JSON.parse(set.stdout),
      { ok: true, name: 'TAG', version: 1 },
      'stdout stays JSON',
    );
    assert.match(set.stderr, /takes effect on the next tug deploy/, 'stderr says when it applies');
    assert.match(
      set.stderr,
      /visible to anyone with a deploy credential.*tug secret set/,
      'and that it is not private',
    );
  });
});

test('a deployment made with --var records the value record on the deployment', async () => {
  await withControl(async ({ dir, tug, register }) => {
    assert.equal(((await register()) as { status: number }).status, 200, 'a node is registered');
    await fs.writeFile(path.join(dir, 'compose.yaml'), COMPOSE);
    await tug(['secret', 'set', 'DB_PASSWORD', '--value', 'hunter2']);
    await tug(['var', 'set', 'REGION', '--value', 'eu']);
    const deployed = JSON.parse(
      (await tug(['deploy', '--no-wait', '--json', '--var', 'TAG=abc'])).stdout,
    );
    assert.equal(
      deployed.desiredState.services.web.image,
      'nginx:abc',
      'the --var is interpolated into the deployed definition',
    );
    assert.deepEqual(
      deployed.deployment.values,
      [
        { name: 'TAG', source: '--var', value: 'abc' },
        { name: 'DB_PASSWORD', source: 'secret', version: 1 },
        { name: 'REGION', source: 'var', version: 1, value: 'eu' },
        { name: 'MODE', source: 'default' },
      ],
      'the deployment records every referenced name with its source',
    );
    assert.ok(
      !JSON.stringify(deployed).includes('hunter2'),
      'the secret value appears nowhere in the result',
    );
  });
});
