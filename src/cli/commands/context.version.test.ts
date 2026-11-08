import test from 'node:test';
import assert from 'node:assert/strict';
import { missingRouteHint, versionVerdict } from './context.ts';
import { compareCompat, compatKey, majorMinor } from '../../protocol.ts';

const base = 'https://control:8443';
const verdict = (control: string | undefined, cli: string) => versionVerdict(control, cli, base);

test('the compatibility key is the major from 1.0 on and the whole 0.minor before it', () => {
  assert.deepEqual(compatKey([1, 7]), [1, 0], 'a 1.x minor only adds, so only the major counts');
  assert.deepEqual(
    compatKey([0, 14]),
    [0, 14],
    'semver promises nothing for 0.x, so the minor counts',
  );
  assert.equal(compareCompat([1, 2], [1, 9]), 0, 'minors inside one major are compatible');
  assert.equal(compareCompat([2, 0], [1, 9]), 1, 'a newer major is incompatible');
  assert.equal(compareCompat([0, 13], [0, 14]), -1, 'a different 0.minor is incompatible');
  assert.equal(
    compareCompat([0, 14], [0, 14]),
    0,
    'patches never matter: only major.minor is parsed',
  );
  assert.deepEqual(
    majorMinor('1.2.3-beta.1'),
    [1, 2],
    'a prerelease suffix does not change the key',
  );
});

test('an equal control version neither errors nor warns', () => {
  assert.deepEqual(verdict('1.4.0', '1.4.0'), {}, 'matching versions need no message');
  assert.deepEqual(verdict('1.4.7', '1.4.0'), {}, 'a different patch is compatible');
});

test('from 1.0 a different minor inside one major is compatible in both directions', () => {
  assert.deepEqual(
    verdict('1.2.0', '1.5.0'),
    {},
    'a CLI ahead by minors still works; a 404 explains missing routes',
  );
  assert.deepEqual(
    verdict('1.5.0', '1.2.0'),
    {},
    'a newer additive control keeps serving an older CLI',
  );
});

test('a control on an older major than the CLI refuses with the upgrade command', () => {
  const v = verdict('1.9.0', '2.0.0');
  assert.match(
    v.error ?? '',
    /tug control setup <control host> --yes/,
    'refusal names the upgrade command',
  );
  assert.match(v.error ?? '', /1\.9\.0/, 'refusal names the control version');
});

test('a control on a newer major than the CLI refuses and names the CLI pin', () => {
  const v = verdict('2.0.0', '1.9.0');
  assert.match(
    v.error ?? '',
    /npm i -g @wpelevator\/tug@2\.0\.0/,
    'the CLI is too old for a new major',
  );
});

test('before 1.0 a control on an older 0.minor refuses and a newer one warns once', () => {
  assert.match(
    verdict('0.13.0', '0.14.0').error ?? '',
    /tug control setup/,
    'an older 0.minor may lack routes',
  );
  const v = verdict('0.15.0', '0.14.0');
  assert.equal(v.error, undefined, 'a newer control keeps serving older 0.x CLIs');
  assert.match(
    v.warning ?? '',
    /npm i -g @wpelevator\/tug@0\.15\.0/,
    'warning names the pin command',
  );
});

test('a missing version report refuses instead of leaking an express 404 body', () => {
  const v = verdict(undefined, '1.0.0');
  assert.match(v.error ?? '', /older than this CLI/, 'a missing report means an older control');
  assert.doesNotMatch(
    v.error ?? '',
    /Cannot GET/,
    'the express default body never reaches the operator',
  );
});

test('a garbage version report refuses instead of silently counting as compatible', () => {
  assert.match(
    verdict('garbage', '1.0.0').error ?? '',
    /not a version/,
    'NaN comparisons must not count as compatible',
  );
});

test('a 404 from a control on an older minor is explained by the version stamp', () => {
  const res = (status: number, stamp?: string) =>
    new Response('Cannot GET /x', { status, headers: stamp ? { 'x-tug-version': stamp } : {} });
  assert.match(
    missingRouteHint(res(404, '1.2.0'), base, '1.5.0'),
    /runs 1\.2\.0, this CLI is 1\.5\.0.*newer control/,
    'a CLI ahead of its control is told the route may be newer than the control',
  );
  assert.equal(
    missingRouteHint(res(404, '1.5.0'), base, '1.5.0'),
    '',
    'an equal control adds no hint',
  );
  assert.equal(
    missingRouteHint(res(404, '1.9.0'), base, '1.5.0'),
    '',
    'a newer control adds no hint',
  );
  assert.equal(
    missingRouteHint(res(500, '1.2.0'), base, '1.5.0'),
    '',
    'only a missing route is explained',
  );
  assert.equal(missingRouteHint(res(404), base, '1.5.0'), '', 'no stamp, no claim');
});
