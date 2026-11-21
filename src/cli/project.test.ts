import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveProject } from './project.ts';
import { resolveCliConfig, writeInitConfig } from './config.ts';

async function withDir(run: (dir: string) => Promise<void>, name = 'Shop_App'): Promise<void> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-project-'));
  const dir = path.join(parent, name);
  await fs.mkdir(dir);
  try {
    await run(dir);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
}

test('the project is chosen by the flag, TUG_PROJECT, tug.yml, the Compose name, then the directory, in that order', async () => {
  await withDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'compose.yaml'), 'name: from-compose\nservices: {}\n');
    const inputs = { flag: 'a', env: 'b', config: 'c', cwd: dir };
    assert.deepEqual(resolveProject(inputs), { project: 'a', source: 'flag' }, '--project wins');
    assert.deepEqual(
      resolveProject({ ...inputs, flag: undefined }),
      { project: 'b', source: 'env' },
      'TUG_PROJECT is next',
    );
    assert.deepEqual(
      resolveProject({ ...inputs, flag: undefined, env: undefined }),
      { project: 'c', source: 'config' },
      'project: in tug.yml is next',
    );
    assert.deepEqual(
      resolveProject({ cwd: dir }),
      { project: 'from-compose', source: 'compose-name' },
      'the Compose name: is next',
    );
    await fs.writeFile(path.join(dir, 'compose.yaml'), 'services: {}\n');
    assert.deepEqual(
      resolveProject({ cwd: dir }),
      { project: 'shop_app', source: 'directory' },
      'without name: the lower-cased directory of the Compose file is used, as Compose does',
    );
  });
});

test('the Compose file chosen with a file setting or -f decides the name and the directory', async () => {
  await withDir(async (dir) => {
    await fs.mkdir(path.join(dir, 'deploy', 'Blog'), { recursive: true });
    await fs.writeFile(path.join(dir, 'compose.yaml'), 'name: root\nservices: {}\n');
    await fs.writeFile(path.join(dir, 'deploy', 'Blog', 'compose.yaml'), 'services: {}\n');
    assert.equal(
      resolveProject({ cwd: dir, file: 'deploy/Blog/compose.yaml' }).project,
      'blog',
      'a Compose file in another directory names the project after that directory',
    );
    await fs.writeFile(path.join(dir, 'other.yml'), 'name: "other"\nservices: {}\n');
    assert.equal(
      resolveProject({ cwd: dir, file: 'other.yml' }).project,
      'other',
      'a named file overrides the conventional one',
    );
  });
});

test('a directory that cannot name a project asks for one instead of falling back to a shared default', async () => {
  await withDir(async (dir) => {
    assert.throws(
      () => resolveProject({ cwd: dir }),
      /set project: in tug\.yml, TUG_PROJECT or pass --project/,
      'an unusable directory name is an error',
    );
  }, '..._');
});

test('resolveCliConfig derives the project from the Compose file and reports where it came from', async () => {
  await withDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'docker-compose.yml'), 'name: wp\nservices: {}\n');
    const derived = await resolveCliConfig({}, {}, dir);
    assert.equal(derived.project, 'wp', 'the Compose name: is the default project');
    assert.equal(derived.projectSource, 'compose-name', 'the source is reported');
    await fs.writeFile(path.join(dir, 'tug.yml'), 'project: pinned\n');
    assert.equal(
      (await resolveCliConfig({}, {}, dir)).project,
      'pinned',
      'tug.yml wins over the Compose name',
    );
    assert.equal(
      (await resolveCliConfig({}, { TUG_PROJECT: 'env' }, dir)).project,
      'env',
      'TUG_PROJECT wins over tug.yml',
    );
  });
});

test('init writes the derived project to a new tug.yml and appends it to an existing one without losing comments', async () => {
  await withDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'compose.yaml'), 'name: wp\nservices: {}\n');
    const first = await resolveCliConfig({}, {}, dir, true);
    await writeInitConfig(first, path.join(dir, 'cred.json'), {}, {});
    assert.match(
      await fs.readFile(path.join(dir, 'tug.yml'), 'utf8'),
      /^project: wp$/m,
      'a new tug.yml records the project taken from the Compose name',
    );
    await fs.rm(path.join(dir, 'tug.yml'));
    await fs.writeFile(path.join(dir, 'tug.yml'), '# keep me\ncontrolUrl: https://c.test\n');
    const again = await resolveCliConfig({}, {}, dir, true);
    const written = await writeInitConfig(again, path.join(dir, 'cred.json'), {}, {});
    const text = await fs.readFile(path.join(dir, 'tug.yml'), 'utf8');
    assert.equal(
      text,
      '# keep me\ncontrolUrl: https://c.test\nproject: wp\n',
      'an existing tug.yml without a project gets one appended and keeps its comment',
    );
    assert.ok(written.includes(path.join(dir, 'tug.yml')), 'the changed file is reported');
    const third = await resolveCliConfig({}, {}, dir, true);
    assert.equal(third.projectSource, 'config', 'once pinned the project comes from tug.yml');
    await writeInitConfig(third, path.join(dir, 'cred.json'), {}, {});
    assert.equal(
      await fs.readFile(path.join(dir, 'tug.yml'), 'utf8'),
      text,
      'a second init leaves a pinned tug.yml alone',
    );
  });
});

test('no CLI command falls back to a hard-coded project', async () => {
  const root = path.join(import.meta.dirname);
  const offenders: string[] = [];
  for (const file of (await fs.readdir(root, { recursive: true })).filter(
    (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
  ))
    if (/\|\|\s*'site'/.test(await fs.readFile(path.join(root, file), 'utf8')))
      offenders.push(file);
  assert.deepEqual(
    offenders,
    [],
    'commands take the project from resolveProject(), not from a default named site',
  );
});
