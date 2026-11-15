import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('every relative link and anchor in README.md and docs/ resolves', () => {
  const script = new URL('../tools/scripts/check-doc-links.mjs', import.meta.url);
  const result = spawnSync(process.execPath, [script.pathname], { encoding: 'utf8' });
  assert.equal(result.status, 0, `broken documentation links:\n${result.stderr}`);
});
