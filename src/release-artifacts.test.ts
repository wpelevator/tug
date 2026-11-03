import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

test('the npm release excludes example applications', () => {
  const result = JSON.parse(
    execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {
      cwd: root,
      encoding: 'utf8',
    }),
  ) as { files: { path: string }[] }[];
  const files = result[0].files.map((file) => file.path);
  assert.ok(files.includes('package.json'), 'the npm package should contain its package metadata');
  assert.ok(
    !files.some((file) => file === 'examples' || file.startsWith('examples/')),
    'the npm package should exclude the example applications',
  );
});

test('the Docker build context excludes example applications', () => {
  const patterns = fs
    .readFileSync(path.join(root, '.dockerignore'), 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  const index = patterns.findLastIndex((line) => /^\/?examples\/?$/.test(line));
  assert.ok(index >= 0, 'the Docker build context should exclude the examples directory');
  assert.ok(
    !patterns.slice(index + 1).some((line) => line.startsWith('!')),
    'later Docker ignore rules should not re-include excluded examples',
  );
});
