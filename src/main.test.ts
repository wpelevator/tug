import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const entry = path.resolve('src/main.ts');

test('--help prints usage for the runtime instead of starting a service', async () => {
  for (const args of [['control', '--help'], ['agent', '--help'], ['--help']]) {
    const { stdout } = await exec(process.execPath, [entry, ...args], { timeout: 10_000 });
    assert.match(stdout, /Usage: tug-runtime/, `${args.join(' ')} should print usage and exit`);
  }
});
