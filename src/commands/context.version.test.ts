import test from 'node:test';
import assert from 'node:assert/strict';
import { versionVerdict } from './context.ts';
import { packageVersion } from '../image.ts';

const cli = packageVersion();
const base = 'https://control:8443';

function older(): string {
  const [major, minor] = cli.split('.').map(Number);
  return minor > 0 ? `${major}.${minor - 1}` : `${major - 1}.0`;
}

test('an equal control version neither errors nor warns', () => {
  const verdict = versionVerdict(cli, cli, base);
  assert.deepEqual(verdict, {}, 'matching CLI and control versions need no message and no refusal');
});

test('a control older than the CLI refuses with the upgrade command', () => {
  const verdict = versionVerdict(older(), cli, base);
  assert.match(
    verdict.error ?? '',
    /tug control setup <control host> --yes/,
    'refusal names the upgrade command',
  );
  assert.match(verdict.error ?? '', new RegExp(older()), 'refusal names the control version');
});

test('a missing version report refuses instead of leaking an express 404 body', () => {
  // undefined means no stamp on the response and no version route on the control: a control that predates both.
  const verdict = versionVerdict(undefined, cli, base);
  assert.match(
    verdict.error ?? '',
    /older than this CLI/,
    'a missing report means an older control',
  );
  assert.doesNotMatch(
    verdict.error ?? '',
    /Cannot GET/,
    'the express default body never reaches the operator',
  );
});

test('a garbage version report refuses instead of silently counting as compatible', () => {
  const verdict = versionVerdict('garbage', cli, base);
  assert.match(
    verdict.error ?? '',
    /not a version/,
    'NaN comparisons must not count as compatible',
  );
});

test('a control newer than the CLI warns once but lets the command proceed', () => {
  const [major, minor] = cli.split('.').map(Number);
  const verdict = versionVerdict(`${major}.${minor + 1}`, cli, base);
  assert.equal(verdict.error, undefined, 'a newer control keeps serving older CLIs');
  assert.match(
    verdict.warning ?? '',
    /npm i -g @wpelevator\/tug@/,
    'warning names the pin command',
  );
});
