// Runs `node --test` with a shared V8 compile cache, so the CLI processes that tests still start (a terminal, piped
// stdin, signals, the built entry) compile the module graph once instead of on every start.
// Usage: node tools/scripts/test.mjs <node --test arguments>
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const cache = process.env.NODE_COMPILE_CACHE ?? path.join(os.tmpdir(), 'tug-test-compile-cache');
const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, NODE_COMPILE_CACHE: cache },
});
process.exit(result.status ?? 1);
