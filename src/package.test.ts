import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('the npm package includes every documentation file', () => {
  const root = new URL('../', import.meta.url);
  const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root,
    encoding: 'utf8',
  });
  const [packed] = JSON.parse(output) as { files: { path: string }[] }[];
  const paths = new Set(packed.files.map((file) => file.path));
  const docs = readdirSync(new URL('../docs/', import.meta.url), {
    recursive: true,
    withFileTypes: true,
  }).filter((entry) => entry.isFile());
  assert.ok(docs.length > 0, 'the documentation directory must contain files to verify');
  for (const entry of docs) {
    const relative = path
      .relative(fileURLToPath(root), path.join(entry.parentPath, entry.name))
      .split(path.sep)
      .join('/');
    assert.ok(paths.has(relative), `the npm package must include ${relative}`);
  }
});
