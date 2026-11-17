// Which test files exist and which tier each belongs to. Shared by the runner (test.mjs) and the layout test.
import fs from 'node:fs';
import path from 'node:path';

/** `process` for a file that starts real tug processes (`*.process.test.*`), `fast` for every other test file. */
export const tierOf = (file) => (/\.process\.test\.[mc]?[jt]s$/.test(file) ? 'process' : 'fast');

const isTest = (name) => /\.test\.[mc]?[jt]s$/.test(name);

function walk(root, dir, found) {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(root, rel, found);
    else if (isTest(entry.name)) found.push(rel);
  }
  return found;
}

/** Every unit-test file `npm test` runs, relative to the repository root and sorted. */
export const testFiles = (root) =>
  [...walk(root, 'src', []), ...walk(root, path.join('tools', 'scripts'), [])].sort();
