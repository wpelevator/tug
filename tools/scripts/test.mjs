// The test runner behind `npm test`. It wraps `node --test` to do four things plain node does not:
//
// - Tiers. A file named `*.process.test.ts` starts real tug processes (a terminal, piped stdin, signals, the built
//   entry) and is the slow tier; every other test file is the fast tier. `--tier fast` skips the slow one.
// - Scheduling. Files run in parallel and one long file at the end of the queue sets the wall time, so the files that
//   took longest on the previous run start first. Timings are cached under the cache directory.
// - A compile cache (NODE_COMPILE_CACHE) shared by every test process and the processes they start.
// - A report of the slowest files, and a warning for a fast-tier file over --slow seconds.
//
// Usage: node tools/scripts/test.mjs [--tier fast|process|all] [--concurrency N] [--slow SECONDS] [files...]
// Without files it runs src/**/*.test.ts and tools/scripts/*.test.mjs.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { testFiles, tierOf } from './test-tiers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    tier: { type: 'string', default: 'all' },
    concurrency: { type: 'string' },
    slow: { type: 'string', default: '8' },
    list: { type: 'boolean', default: false },
  },
});
if (!['fast', 'process', 'all'].includes(values.tier)) {
  console.error(`--tier must be fast, process or all, not ${values.tier}`);
  process.exit(2);
}

const cacheDir = process.env.TUG_TEST_CACHE ?? path.join(os.tmpdir(), 'tug-test-cache');
const timingsFile = path.join(cacheDir, 'timings.json');
const readTimings = () => {
  try {
    return JSON.parse(fs.readFileSync(timingsFile, 'utf8'));
  } catch {
    return {};
  }
};
const timings = readTimings();

const candidates = positionals.length ? positionals : testFiles(root);
const files = candidates
  .filter((file) => values.tier === 'all' || tierOf(file) === values.tier)
  // Files with no timing yet start first: a new slow file must not land at the tail of the queue.
  .sort((a, b) => (timings[b] ?? Infinity) - (timings[a] ?? Infinity) || a.localeCompare(b));

if (values.list) {
  for (const file of files) console.log(`${tierOf(file)}\t${file}`);
  process.exit(0);
}
if (!files.length) {
  console.error(`no ${values.tier} tier test files matched`);
  process.exit(values.tier === 'all' ? 1 : 0);
}

fs.mkdirSync(cacheDir, { recursive: true });
const last = path.join(cacheDir, 'last.json');
fs.rmSync(last, { force: true });
const args = [
  '--test',
  ...(values.concurrency ? [`--test-concurrency=${values.concurrency}`] : []),
  '--test-reporter=spec',
  '--test-reporter-destination=stdout',
  `--test-reporter=${path.join(root, 'tools', 'scripts', 'test-timings-reporter.mjs')}`,
  `--test-reporter-destination=${last}`,
  ...files,
];
const started = Date.now();
const result = spawnSync(process.execPath, args, {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_COMPILE_CACHE: process.env.NODE_COMPILE_CACHE ?? path.join(cacheDir, 'compile'),
  },
});
const wall = (Date.now() - started) / 1000;

let ran = {};
try {
  ran = JSON.parse(fs.readFileSync(last, 'utf8'));
} catch {
  // The run was interrupted before the reporter wrote anything; keep the old timings.
}
const merged = Object.fromEntries(
  Object.entries({ ...timings, ...ran }).filter(([file]) => fs.existsSync(path.join(root, file))),
);
if (Object.keys(ran).length) fs.writeFileSync(timingsFile, JSON.stringify(merged, null, 1));

const slowest = Object.entries(ran).sort((a, b) => b[1] - a[1]);
if (slowest.length) {
  console.log(
    `\nSlowest of ${files.length} files (${values.tier} tier, ${wall.toFixed(0)} s wall):`,
  );
  for (const [file, seconds] of slowest.slice(0, 5))
    console.log(`  ${seconds.toFixed(1).padStart(6)} s  ${file}`);
  const limit = Number(values.slow);
  for (const [file, seconds] of slowest)
    if (tierOf(file) === 'fast' && seconds > limit)
      console.log(
        `warning: ${file} took ${seconds.toFixed(1)} s in the fast tier (limit ${limit} s). Run the CLI with execCli, or if it needs a real process move those tests to a *.process.test.ts file (docs/testing.md#test-tiers).`,
      );
}
process.exit(result.status ?? 1);
