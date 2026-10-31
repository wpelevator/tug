import test from 'node:test';
import assert from 'node:assert/strict';
import { encrypt, decrypt } from './secrets.ts';

test('encrypts and decrypts secrets', () => {
  const key = 'test-master-key';
  const enc = encrypt('super-secret', key);
  assert.notEqual(enc, 'super-secret');
  assert.equal(decrypt(enc, key), 'super-secret');
});
