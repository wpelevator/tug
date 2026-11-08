import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as yaml from 'js-yaml';
import { normalizeCompose } from '../../src/compose/normalize.ts';
import { validateCompose } from '../../src/compose/compose.ts';
import { resolveBackups } from '../../src/backup/config.ts';

const root = path.resolve(import.meta.dirname, '../..');
const password = 'test-password';
const appKey = 'base64:MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE=';
function run(args: string[], options: { allowFailure?: boolean; input?: string } = {}) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    env: {
      ...process.env,
      DB_PASSWORD: password,
      DB_ROOT_PASSWORD: password,
      APP_KEY: appKey,
      S3_ACCESS_KEY: 'testaccess',
      S3_SECRET_KEY: 'testsecret',
    },
    maxBuffer: 10_000_000,
    input: options.input,
  });
  if (!options.allowFailure)
    assert.equal(result.status, 0, `docker ${args.join(' ')} should succeed: ${result.stderr}`);
  return result;
}
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

for (const name of ['node', 'django', 'laravel']) {
  test(
    `${name} uploads and downloads files and restores its database`,
    { timeout: 360_000 },
    async () => {
      const config = await normalizeCompose(
        path.join(root, 'examples', name, 'docker-compose.yml'),
        ['DB_PASSWORD', 'DB_ROOT_PASSWORD', 'APP_KEY', 'S3_ACCESS_KEY', 'S3_SECRET_KEY'],
      );
      assert.doesNotThrow(
        () => validateCompose(config, ['app', 'another']),
        'the Compose-normalized file should validate for multiple nodes',
      );
      assert.deepEqual(
        resolveBackups(config, name).errors,
        [],
        'the normalized backup configuration should validate',
      );
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tug-example-'));
      const project = `tugexample${name}${process.pid}`;
      const source = yaml.load(
        fs.readFileSync(path.join(root, 'examples', name, 'docker-compose.yml'), 'utf8'),
      ) as any;
      const backup = source.services.db['x-tug'].backup;
      delete source['x-tug'];
      for (const service of Object.values(source.services) as any[]) delete service['x-tug'];
      delete source.volumes['db-data']['x-tug'];
      source.services.web.build = path.join(
        root,
        'examples',
        name,
        name === 'laravel' ? '' : 'app',
      );
      source.services.web.ports = [`127.0.0.1::${name === 'node' ? 3000 : 8000}`];
      const env = source.services.web.environment;
      if (name === 'laravel') {
        env.AWS_ENDPOINT = 'http://minio:9000';
        env.AWS_BUCKET = 'tug-example';
      } else {
        env.S3_ENDPOINT = 'http://minio:9000';
        env.S3_BUCKET = 'tug-example';
      }
      source.services.minio = {
        image: 'node:22-alpine',
        command: ['node', '/s3-stub.mjs'],
        volumes: [`${root}/tests/integration/fixtures/s3-stub.mjs:/s3-stub.mjs:ro`],
      };
      const file = path.join(dir, 'compose.yml');
      fs.writeFileSync(file, yaml.dump(source));
      const compose = (...args: string[]) => run(['compose', '-p', project, '-f', file, ...args]);
      try {
        compose('up', '-d', 'db', 'redis', 'minio');
        const migration =
          name === 'node'
            ? ['npm', 'run', 'migrate']
            : name === 'django'
              ? ['python', 'manage.py', 'migrate', '--noinput']
              : ['php', 'artisan', 'migrate', '--force'];
        let migrated = false;
        for (let i = 0; i < 30; i++) {
          const result = run(
            [
              'compose',
              '-p',
              project,
              '-f',
              file,
              'run',
              '--build',
              '--rm',
              '--no-deps',
              'web',
              ...migration,
            ],
            { allowFailure: true },
          );
          if (result.status === 0) {
            migrated = true;
            break;
          }
          await delay(1000);
        }
        assert.ok(migrated, 'the migration should succeed after the database starts');
        compose('up', '-d', 'web');
        const port = compose('port', 'web', String(name === 'node' ? 3000 : 8000))
          .stdout.trim()
          .split(':')
          .at(-1);
        const base = `http://127.0.0.1:${port}`;
        for (let i = 0; i < 30; i++) {
          try {
            if ((await fetch(`${base}/health`)).ok) break;
          } catch {}
          await delay(1000);
        }
        const form = new FormData();
        form.append('file', new Blob(['hello from Tug']), 'hello.txt');
        const upload = await fetch(`${base}/files`, { method: 'POST', body: form });
        assert.equal(upload.status, 201, `upload should succeed: ${await upload.clone().text()}`);
        const { id } = (await upload.json()) as { id: string };
        const list = (await fetch(`${base}/files`).then((r) => r.json())) as {
          id: string;
          name: string;
        }[];
        assert.ok(
          list.some((item) => item.id === id && item.name === 'hello.txt'),
          'the list should contain uploaded metadata',
        );
        assert.equal(
          await fetch(`${base}/files/${id}`).then((r) => r.text()),
          'hello from Tug',
          'the object store should return uploaded bytes',
        );
        const command = (value: string) => value.replaceAll('$$', '$');
        const dbExec = (cmd: string, input?: string) =>
          run(['compose', '-p', project, '-f', file, 'exec', '-T', 'db', 'sh', '-c', cmd], {
            input,
          });
        const dump = dbExec(command(backup.command)).stdout;
        assert.ok(
          dump.includes(backup.verify),
          'the database dump should contain its configured completion marker',
        );
        dbExec(
          name === 'laravel'
            ? 'mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" app -e "DELETE FROM files"'
            : `psql -U app -d app -c "DELETE FROM ${name === 'django' ? 'files_file' : 'files'}"`,
        );
        compose('exec', '-T', 'redis', 'redis-cli', 'FLUSHDB');
        const removed = (await fetch(`${base}/files`).then((r) => r.json())) as { id: string }[];
        assert.ok(
          !removed.some((item) => item.id === id),
          'the uploaded row should be absent before the database restore',
        );
        dbExec(command(backup.restore), dump);
        compose('restart', 'redis');
        compose('exec', '-T', 'redis', 'redis-cli', 'FLUSHDB');
        let after: { id: string }[] = [];
        for (let i = 0; i < 15; i++) {
          await delay(1000);
          const response = await fetch(`${base}/files`);
          if (response.ok) {
            after = (await response.json()) as { id: string }[];
            break;
          }
        }
        assert.ok(
          after.some((item) => item.id === id),
          'metadata should remain available after Redis restarts',
        );
      } finally {
        run(['compose', '-p', project, '-f', file, 'down', '-v', '--remove-orphans'], {
          allowFailure: true,
        });
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
}
