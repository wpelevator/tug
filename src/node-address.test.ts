import test from 'node:test';
import assert from 'node:assert/strict';
import { isNodeHost } from './node-address.ts';

test('node addresses accept IP literals and DNS hostnames without ports', () => {
  for (const value of ['10.0.0.8', '2001:db8::1', 'node.example.com', 'localhost']) {
    assert.equal(isNodeHost(value), true, `${value} should be accepted as a node address`);
  }
});

test('node addresses reject ports and configuration syntax', () => {
  for (const value of ['10.0.0.8:8080', '[2001:db8::1]', 'node.example.com {\n#', '', 'bad_host']) {
    assert.equal(
      isNodeHost(value),
      false,
      `${JSON.stringify(value)} should be rejected as a node address`,
    );
  }
});
