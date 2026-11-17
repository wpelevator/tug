import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Keeps the test tiers honest (docs/testing.md#test-tiers). A node process costs about half a second to start, so the
// suite stays fast only while tests that start real tug processes are few, named and easy to find. These checks make
// the cheap way the default: a test that needs the CLI calls execCli, and one that needs a real process says so in
// its file name.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = 'src/test-layout.test.ts';
const tierOf = (file: string) => (/\.process\.test\.[mc]?[jt]s$/.test(file) ? 'process' : 'fast');

function walk(dir: string): string[] {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return walk(rel);
    return /\.test\.[mc]?[jt]s$/.test(entry.name) ? [rel] : [];
  });
}
const files = [...walk('src'), ...walk('tools/scripts')].sort();
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');
const startsRealProcess = (text: string) =>
  /tests\/cli-process\.ts|process\.execPath|\bspawn\(|\bexecFile\(/.test(text);

test('only *.process.test.* files import the real-process entry points', () => {
  const offenders = files.filter(
    (file) => file !== SELF && tierOf(file) === 'fast' && /tests\/cli-process\.ts/.test(read(file)),
  );
  assert.deepEqual(
    offenders,
    [],
    'these fast-tier files import tests/cli-process.ts: use execCli (tests/cli-inprocess.ts), or rename the file to *.process.test.ts if it needs a terminal, piped stdin, signals or the built entry',
  );
});

test('no test hard-codes the path of the CLI or runtime entry, so the process tier stays findable', () => {
  const offenders = files.filter(
    (file) =>
      file !== SELF &&
      /['"`][^'"`\n]*(?:src\/(?:cli|main)\.ts|dist\/(?:cli|main)\.js)['"`]/.test(read(file)),
  );
  assert.deepEqual(
    offenders,
    [],
    'import cliEntry or mainEntry from tests/cli-process.ts (in a *.process.test.ts file) instead of naming the entry file',
  );
});

test('a *.process.test.* file really starts processes, so the slow tier holds only slow tests', () => {
  const idle = files.filter((file) => tierOf(file) === 'process' && !startsRealProcess(read(file)));
  assert.deepEqual(
    idle,
    [],
    'these files are in the process tier but start no process: rename them to *.test.ts so they run in the fast tier',
  );
});

test('test files use only the documented suffixes', () => {
  const odd = files.filter((file) => !/\.(?:process\.)?test\.[mc]?[jt]s$/.test(file));
  assert.deepEqual(odd, [], 'tiers come from *.test.ts and *.process.test.ts, nothing else');
  assert.ok(
    files.some((file) => tierOf(file) === 'process'),
    'the process tier should not be empty',
  );
  assert.ok(files.length > 100, `the walk should find the whole suite (found ${files.length})`);
});
