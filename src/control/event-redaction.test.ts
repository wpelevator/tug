import test from 'node:test';
import assert from 'node:assert/strict';
import { eventForRole } from './event-redaction.ts';

const run = {
  type: 'job.run',
  message: 'ci ran a one-off web container on n1: wp user create --user_pass=hunter2',
  metadata_json: JSON.stringify({
    service: 'web',
    node: 'n1',
    command: ['wp', '--user_pass=hunter2'],
  }),
};

test('only a read credential loses the command of a one-off run', () => {
  const asRead = eventForRole(run, 'read');
  assert.equal(
    asRead.message,
    'ci ran a one-off web container on n1',
    'the message drops the command',
  );
  assert.deepEqual(
    JSON.parse(asRead.metadata_json!),
    { service: 'web', node: 'n1' },
    'so does the metadata',
  );
  assert.equal(
    eventForRole(run, 'deploy'),
    run,
    'deploy can already exec and read secrets, so it sees all',
  );
  assert.equal(eventForRole(run, 'admin'), run, 'admin sees all');
});

test('other events are left alone, and an unreadable one-off record is still stripped of any command text', () => {
  const other = { type: 'deploy', message: 'ci: deployed v2', metadata_json: '{}' };
  assert.equal(
    eventForRole(other, 'read'),
    other,
    'a message that merely contains a colon is not touched',
  );
  const broken = eventForRole(
    {
      type: 'job.run',
      message: 'ci ran a one-off container: wp --secret=abc',
      metadata_json: 'not json',
    },
    'read',
  );
  assert.doesNotMatch(
    JSON.stringify(broken),
    /secret=abc/,
    'without metadata the text after the first colon is dropped',
  );
  assert.equal(broken.metadata_json, '{}', 'unreadable metadata becomes empty rather than leaking');
});
