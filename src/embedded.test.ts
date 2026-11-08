import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { isEmbedded, readTemplate, registerEmbedded } from './embedded.ts';

test('every template under src/templates is embedded by the native-binary entry', () => {
  const entry = fs.readFileSync('tools/binary/entry.ts', 'utf8');
  const embedded = [...entry.matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1]).sort();
  const onDisk = fs.readdirSync('src/templates').sort();
  assert.deepEqual(
    embedded,
    onDisk,
    'a template missing from tools/binary/entry.ts would fail at runtime in the binary',
  );
});

test('templates fall back to disk when nothing is registered and use the embedded copy once registered', () => {
  assert.equal(isEmbedded(), false, 'the Node entry points register nothing');
  const dir = 'src/templates';
  assert.equal(
    readTemplate(dir, 'agent.env'),
    fs.readFileSync(path.join(dir, 'agent.env'), 'utf8'),
    'the disk copy is read when no embedded assets are registered',
  );
  registerEmbedded({ version: '9.9.9', templates: { 'agent.env': 'embedded' } });
  try {
    assert.equal(
      readTemplate(dir, 'agent.env'),
      'embedded',
      'the embedded copy wins once registered',
    );
    assert.ok(isEmbedded(), 'registering assets marks the process as embedded');
  } finally {
    registerEmbedded();
  }
});
