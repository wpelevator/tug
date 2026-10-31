import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { defaultImage, packageVersion, resolveImage } from './image.ts';

test('defaultImage pins the GHCR image to the given version', () => {
  assert.equal(
    defaultImage('1.2.3'),
    'ghcr.io/wpelevator/tug:1.2.3',
    'default image is ghcr.io/wpelevator/tug:<version>',
  );
});

test('packageVersion reads the version from package.json', () => {
  const expected = (
    JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    }
  ).version;
  assert.equal(packageVersion(), expected, 'packageVersion matches package.json');
  assert.equal(
    defaultImage(),
    `ghcr.io/wpelevator/tug:${expected}`,
    'defaultImage() defaults to the package version',
  );
});

test('resolveImage prefers an explicit --image, then tug:local for local builds, then the published image', () => {
  assert.equal(
    resolveImage('my/tug:dev', true, '1.2.3'),
    'my/tug:dev',
    'explicit --image wins even with --build-local-image',
  );
  assert.equal(
    resolveImage(undefined, true, '1.2.3'),
    'tug:local',
    '--build-local-image alone builds tug:local',
  );
  assert.equal(
    resolveImage(undefined, false, '1.2.3'),
    'ghcr.io/wpelevator/tug:1.2.3',
    'without flags the published image for the CLI version is used',
  );
});
