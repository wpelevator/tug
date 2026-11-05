import test from 'node:test';
import assert from 'node:assert/strict';
import { versionVerdict } from './context.ts';
import { packageVersion } from '../image.ts';

const cli = packageVersion();

test('an equal control version neither errors nor warns', () => {
  const verdict = versionVerdict(200, { v: cli }, cli, 'https://control:8443');
  assert.deepEqual(verdict, {}, 'matching CLI and control versions need no message and no refusal');
});

test('a control older than the CLI refuses with the upgrade command', () => {
  const [major, minor] = cli.split('.').map(Number);
  const older = minor > 0 ? `${major}.${minor - 1}` : `${major - 1}.0`;
  const verdict = versionVerdict(200, { v: older }, cli, 'https://control:8443');
  assert.match(
    verdict.error ?? '',
    /tug control setup <control host> --yes/,
    'refusal names the upgrade command',
  );
  assert.match(verdict.error ?? '', new RegExp(older), 'refusal names the control version');
});

test('a control without the version route refuses instead of leaking an express 404 body', () => {
  const verdict = versionVerdict(404, null, cli, 'https://control:8443');
  assert.match(
    verdict.error ?? '',
    /older than this CLI/,
    'a 404 on the version route means an older control',
  );
  assert.doesNotMatch(
    verdict.error ?? '',
    /Cannot GET/,
    'the express default body never reaches the operator',
  );
});

test('statuses other than a missing route are not misdiagnosed as version skew', () => {
  // A 401 (bad credential) or 503 (control recovering) belongs to the command's own request, not to an upgrade hint.
  for (const status of [401, 500, 503]) {
    const verdict = versionVerdict(status, null, cli, 'https://control:8443');
    assert.equal(
      verdict.error,
      undefined,
      `HTTP ${status} must not push the operator toward a control redeploy`,
    );
    assert.equal(verdict.warning, undefined, `HTTP ${status} must not print a CLI pin warning`);
  }
});

test('a garbage version report refuses instead of silently counting as compatible', () => {
  const verdict = versionVerdict(200, { v: 'garbage' }, cli, 'https://control:8443');
  assert.match(
    verdict.error ?? '',
    /not a version/,
    'NaN comparisons must not count as compatible',
  );
});

test('a control newer than the CLI warns once but lets the command proceed', () => {
  const [major, minor] = cli.split('.').map(Number);
  const verdict = versionVerdict(200, { v: `${major}.${minor + 1}` }, cli, 'https://control:8443');
  assert.equal(verdict.error, undefined, 'a newer control keeps serving older CLIs');
  assert.match(
    verdict.warning ?? '',
    /npm i -g @wpelevator\/tug@/,
    'warning names the pin command',
  );
});

test('a non-JSON version response refuses with the upgrade command', () => {
  const verdict = versionVerdict(200, null, cli, 'https://control:8443');
  assert.match(
    verdict.error ?? '',
    /without a version/,
    'an empty version report cannot be trusted',
  );
});
