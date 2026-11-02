import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultControlUrl } from './cli-install.ts';

test('defaultControlUrl derives the control address from the SSH target', () => {
  for (const [target, expected] of [
    ['root@165.232.92.174', 'https://165.232.92.174:8443'],
    ['control.example.com', 'https://control.example.com:8443'],
    ['deploy@control.example.com', 'https://control.example.com:8443'],
    ['ssh://root@10.0.0.3:2222', 'https://10.0.0.3:8443'],
    ['root@[2001:db8::1]', 'https://[2001:db8::1]:8443'],
  ] as const)
    assert.equal(defaultControlUrl(target, 8443), expected, `${target} should map to ${expected}`);
  assert.equal(
    defaultControlUrl('root@host', 9099),
    'https://host:9099',
    'the published port is part of the default',
  );
  assert.throws(
    () => defaultControlUrl('root@', 8443),
    /cannot derive/,
    'an empty host is rejected',
  );
});
