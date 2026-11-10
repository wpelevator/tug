import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { lintComposeFile } from './lint.ts';

const exec = promisify(execFile);
const entry = path.resolve('src/cli.ts');

const writeFile = async (dir: string, name: string, text: string): Promise<string> => {
  const file = path.join(dir, name);
  await fs.writeFile(file, text);
  return file;
};

const GOOD = `
services:
  web:
    image: nginx:1.27
    ports:
      - "8080:80"
    x-tug:
      placement:
        nodes: [app1]
      health:
        type: http
        port: 80
      ingress:
        host: app.example.com
        port: 80
volumes:
  db-data:
    x-tug:
      persistent: true
      placement:
        nodes: [app1]
`;

test('lintComposeFile passes a well-written file and reports its path', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-lint-'));
  try {
    const file = await writeFile(dir, 'compose.yml', GOOD);
    const result = await lintComposeFile(file);
    assert.deepEqual(
      [result.file, result.errors],
      [file, []],
      'a file deploy would accept produces no findings',
    );
    const normalized = await lintComposeFile(
      await writeFile(dir, 'short.yml', GOOD.replace('      - "8080:80"\n', '      - "8080:80"\n')),
    );
    assert.deepEqual(normalized.errors, [], 'short syntax is what operators write');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('lint reports one finding per missed rule, naming the service or volume', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-lint-'));
  try {
    const file = await writeFile(
      dir,
      'compose.yml',
      `
services:
  web:
    image: nginx:1.27
    x-tug:
      health:
        type: htp
      rollout:
        strategy: rolling
        drain: 30s
volumes:
  db-data:
    x-tug:
      persistant: true
`,
    );
    const result = await lintComposeFile(file);
    assert.ok(
      result.errors.some((e) => e === 'web: x-tug.health.type must be docker, tcp or http'),
      'the health type is checked against its enum',
    );
    assert.ok(
      result.errors.some((e) => /web: rollout\.strategy rolling requires x-tug\.ingress/.test(e)),
      'a rolling service still needs an ingress',
    );
    assert.ok(
      result.errors.some((e) => /volumes\.db-data: x-tug\.persistant is not supported/.test(e)),
      'the volume extension is part of the schema',
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('lint reports an unreadable, invalid or empty file instead of throwing', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-lint-'));
  try {
    const missing = await lintComposeFile(path.join(dir, 'nope.yml'));
    assert.equal(missing.errors.length, 1, 'one finding for a missing file');
    assert.match(
      missing.errors[0],
      /could not be read/,
      'the finding says the file could not be read',
    );
    const broken = await lintComposeFile(await writeFile(dir, 'broken.yml', 'services: [unclosed'));
    assert.match(broken.errors[0], /is not valid YAML/, 'a YAML syntax error is a lint finding');
    const empty = await lintComposeFile(await writeFile(dir, 'empty.yml', ''));
    assert.deepEqual(
      empty.errors,
      ['compose file must define services'],
      'an empty file has no services to deploy',
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('tug lint exits nonzero with findings on stderr and prints ok on a passing file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-lint-'));
  try {
    await writeFile(dir, 'compose.yml', GOOD);
    const okRun = await exec(process.execPath, [entry, 'lint'], {
      cwd: dir,
      env: { ...process.env },
    });
    assert.match(okRun.stdout.trim(), /compose\.yml: ok$/, 'a passing file says so on stdout');
    assert.equal(okRun.stderr.trim(), '', 'a passing file writes nothing to stderr');
    await writeFile(
      dir,
      'bad.yml',
      'services:\n  web:\n    image: nginx\n    x-tug:\n      replicas: 0\n',
    );
    const error = (await exec(process.execPath, [entry, 'lint', '-f', 'bad.yml'], {
      cwd: dir,
      env: { ...process.env },
    }).catch((e: Error & { stdout?: string; stderr?: string }) => e)) as Error & {
      stdout?: string;
      stderr?: string;
      code?: number;
    };
    assert.equal(error.code, 1, 'findings exit nonzero for CI and editor runs');
    assert.match(
      error.stderr || '',
      /bad\.yml: web: x-tug\.replicas must be a whole number of 1 or more/,
      'each finding names the file, the service and the rule',
    );
    assert.equal((error.stdout || '').trim(), '', 'findings never mix with command output');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('tug lint --json prints a machine-readable result and no human summary', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-lint-'));
  try {
    await writeFile(
      dir,
      'bad.yml',
      'services:\n  web:\n    image: nginx\n    x-tug:\n      health:\n        type: htp\n',
    );
    const { stdout } = await exec(
      process.execPath,
      [entry, 'lint', '--file', 'bad.yml', '--json'],
      {
        cwd: dir,
        env: { ...process.env },
      },
    ).catch((e: Error & { stdout?: string }) => e as never);
    const result = JSON.parse(String(stdout));
    assert.deepEqual(
      { ok: result.ok, file: path.basename(result.file), errors: result.errors },
      {
        ok: false,
        file: 'bad.yml',
        errors: ['web: x-tug.health.type must be docker, tcp or http'],
      },
      '--json is the shape an editor or script consumes',
    );
    const good = await writeFile(dir, 'compose.yml', GOOD);
    const ok = JSON.parse(
      (
        await exec(process.execPath, [entry, 'lint', '--json'], {
          cwd: dir,
          env: { ...process.env },
        }).catch((e: Error & { stdout?: string }) => e as never)
      ).stdout,
    );
    assert.deepEqual(
      { ok: ok.ok, errors: ok.errors },
      { ok: true, errors: [] },
      'a passing file is ok with an empty error list and the default compose file name',
    );
    assert.equal(
      path.basename(ok.file),
      path.basename(good),
      'the default compose file name was linted',
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('the tug.yml file setting defaults the file lint looks at', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-lint-'));
  try {
    await writeFile(dir, 'compose.yml', 'services:\n  web:\n    x-tug: 5\n');
    const alt = await writeFile(dir, 'compose.alt.yml', GOOD);
    await writeFile(dir, 'tug.yml', 'file: compose.alt.yml\n');
    const { stdout } = await exec(process.execPath, [entry, 'lint', '--json'], {
      cwd: dir,
      env: { ...process.env },
    });
    const result = JSON.parse(stdout);
    assert.equal(result.ok, true, 'the config file points lint at compose.alt.yml');
    assert.equal(
      path.basename(result.file),
      path.basename(alt),
      'the file setting is the default --file',
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('lint reports env_file, which tug deploy no longer reads, and names the import commands', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-lint-envfile-'));
  try {
    const file = await writeFile(
      dir,
      'compose.yaml',
      'services:\n  web:\n    image: nginx\n    env_file: app.env\n  db:\n    image: mariadb\n',
    );
    const result = await lintComposeFile(file);
    assert.equal(result.errors.length, 1, 'only the service that uses env_file is reported');
    assert.match(
      result.errors[0],
      /^web: env_file is not read by tug deploy/,
      'the finding names the service',
    );
    assert.match(
      result.errors[0],
      /tug secret import <file> or tug var import <file>/,
      'the finding says how to move the entries to control',
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
