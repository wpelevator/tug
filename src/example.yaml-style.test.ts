import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function yamlFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory())
      return ['node_modules', 'vendor', '.git'].includes(entry.name) ? [] : yamlFiles(file);
    return /\.ya?ml$/.test(entry.name) ? [file] : [];
  });
}

test('example YAML uses block-style lists and non-empty mappings', () => {
  const root = fileURLToPath(new URL('../examples/', import.meta.url));
  const files = yamlFiles(root);
  assert.ok(files.length > 0, 'the example directory should contain YAML files');
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (const [index, line] of lines.entries()) {
      assert.doesNotMatch(
        line,
        /^\s*[\w-]+:\s*(?:\[|\{\s*[^}\s])/,
        `${path.relative(root, file)}:${index + 1} should use block-style collections`,
      );
    }
  }
});
