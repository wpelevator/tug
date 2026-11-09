import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startMtlsControl } from '../../tests/helpers.ts';

test('control restricts its data directory to its own user, since a volume root is created world-readable', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-data-dir-'));
  await fs.chmod(dir, 0o755);
  const previous = process.env.TUG_DATA_DIR;
  const control = await startMtlsControl(dir);
  try {
    assert.equal(
      (await fs.stat(dir)).mode & 0o777,
      0o700,
      'the data directory holds the master key and the CA key, so it must not be readable by other users',
    );
  } finally {
    await control.close();
    if (previous === undefined) delete process.env.TUG_DATA_DIR;
    else process.env.TUG_DATA_DIR = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
