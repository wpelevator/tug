import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RESTIC_EXIT_REPOSITORY_MISSING,
  RESTIC_EXIT_WRONG_PASSWORD,
  classifyRepositoryProbe,
  resticTooOld,
  describeProbeFailure,
} from './repository-probe.ts';

const probe = (code: number | null, err = '', out = '') => ({ code, err, out });

test('restic exit codes 0, 10 and anything else are ok, missing and error', () => {
  assert.equal(RESTIC_EXIT_REPOSITORY_MISSING, 10, 'restic documents 10 as repository missing');
  assert.equal(RESTIC_EXIT_WRONG_PASSWORD, 12, 'restic documents 12 as wrong password');
  assert.equal(classifyRepositoryProbe(probe(0)), 'ok', 'exit 0 is an existing repository');
  assert.equal(classifyRepositoryProbe(probe(10)), 'missing', 'exit 10 is a missing repository');
  for (const code of [1, 11, 12, 130, null])
    assert.equal(classifyRepositoryProbe(probe(code)), 'error', `exit ${code} is an error`);
});

test('the message wording never decides whether a repository is missing', () => {
  assert.equal(
    classifyRepositoryProbe(
      probe(
        1,
        'The specified bucket does not exist\nIs there a repository at the following location?',
      ),
    ),
    'error',
    'a missing bucket with exit 1 is an error even though it says "does not exist"',
  );
  assert.equal(
    classifyRepositoryProbe(probe(10, 'anything at all')),
    'missing',
    'exit 10 is missing whatever the text says',
  );
});

test('failures get the hint that fixes them', () => {
  assert.match(
    describeProbeFailure(probe(12, 'Fatal: wrong password'), 'Fatal: wrong password'),
    /wrong repository password/,
    'exit 12 reads as a wrong password',
  );
  const hinted =
    'Fatal: The specified bucket does not exist\nIs there a repository at the following location?';
  assert.doesNotMatch(
    describeProbeFailure(probe(1, hinted), hinted, '0.19.1'),
    /older than 0\.17/,
    'restic 0.19 appends the repository hint to ordinary failures, so a mistyped bucket must not blame the version',
  );
  assert.doesNotMatch(
    describeProbeFailure(probe(1, hinted), hinted),
    /older than 0\.17/,
    'an unknown version gets no hint',
  );
  assert.match(
    describeProbeFailure(probe(1, hinted), hinted, '0.16.4'),
    /restic 0\.16\.4 is older than 0\.17.*TUG_RESTIC_IMAGE must be 0\.17 or newer/,
    'a known restic older than 0.17 gets the hint',
  );
  assert.equal(resticTooOld('0.17.0'), false, '0.17.0 is new enough');
  assert.equal(resticTooOld('1.0.0'), false, 'a later major is new enough');
  assert.equal(resticTooOld('0.9.6'), true, '0.9.6 is too old');
  assert.equal(
    describeProbeFailure(probe(1, 'dial tcp: no such host'), 'dial tcp: no such host'),
    'dial tcp: no such host',
    'other failures keep restic message unchanged',
  );
});
