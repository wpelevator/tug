import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBackupDestination,
  projectRepository,
  redactSecrets,
  repositoryPassword,
} from './backup-destination.ts';

const s3Env = { AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE', AWS_SECRET_ACCESS_KEY: 'sekret-value' };

test('an S3 destination with its credentials is accepted and trailing slashes are dropped', () => {
  const parsed = parseBackupDestination({
    url: 's3:https://s3.example.com/bucket/tug//',
    env: s3Env,
  });
  assert.equal(parsed.url, 's3:https://s3.example.com/bucket/tug', 'the url is normalized');
  assert.deepEqual(parsed.env, s3Env, 'the env values are kept for encrypted storage');
});

test('invalid destinations are rejected with a message naming the problem', () => {
  const cases: [unknown, RegExp][] = [
    [{}, /url is required/],
    [{ url: 'ftp://host/x', env: {} }, /url must start with s3:/],
    [{ url: 's3:https://host', env: s3Env }, /must name a bucket/],
    [{ url: 's3:https://host/b', env: { AWS_ACCESS_KEY_ID: 'a' } }, /need AWS_SECRET_ACCESS_KEY/],
    [
      { url: 'rest:https://user:pw@host/repo', env: {} },
      /must not contain a username and password/,
    ],
    [{ url: 's3:https://host/b', env: { ...s3Env, lower: 'x' } }, /upper case letters/],
    [{ url: 's3:https://host/b', env: { ...s3Env, RESTIC_PASSWORD: 'x' } }, /managed by Tug/],
    [{ url: 's3:https://host/b', env: { ...s3Env, EXTRA: '' } }, /EXTRA needs a value/],
    [{ url: 's3:https://host/b c', env: s3Env }, /whitespace/],
  ];
  for (const [input, message] of cases)
    assert.throws(
      () => parseBackupDestination(input),
      message,
      `${JSON.stringify(input)} should be rejected`,
    );
});

test('an absolute path is accepted as a development destination without credentials', () => {
  assert.equal(parseBackupDestination({ url: '/srv/restic', env: {} }).url, '/srv/restic');
});

test('each project gets its own repository path and a stable derived password', () => {
  assert.equal(projectRepository('s3:https://h/b/', 'site'), 's3:https://h/b/site');
  const a = repositoryPassword('master-key', 'site');
  assert.equal(a, repositoryPassword('master-key', 'site'), 'the password is deterministic');
  assert.match(a, /^[0-9a-f]{64}$/, 'the password is 256 bits of hex');
  assert.notEqual(a, repositoryPassword('master-key', 'blog'), 'projects have different passwords');
  assert.notEqual(a, repositoryPassword('other-key', 'site'), 'a different master key changes it');
});

test('redaction removes secret values and URL credentials but not short ordinary words', () => {
  const text =
    'upload to s3 failed: bad key sekret-value for https://user:hunter22@host/b (AKIAEXAMPLE) in db';
  const redacted = redactSecrets(text, ['sekret-value', 'AKIAEXAMPLE', 'db']);
  assert.ok(!redacted.includes('sekret-value'), 'the secret value should be removed');
  assert.ok(!redacted.includes('AKIAEXAMPLE'), 'the access key should be removed');
  assert.ok(!redacted.includes('hunter22'), 'a password in a URL should be removed');
  assert.ok(redacted.endsWith('in db'), 'values under four characters are left alone');
});
