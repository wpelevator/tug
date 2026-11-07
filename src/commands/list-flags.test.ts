import test from 'node:test';
import assert from 'node:assert/strict';
import { Command } from 'commander';
import type { Option } from 'commander';
import { collectList } from './context.ts';
import { registerBackup } from './backup.ts';
import { registerControl } from './control.ts';
import { registerCredential } from './credential.ts';
import { registerDeploy } from './deploy.ts';
import { registerHold } from './hold.ts';
import { registerImage } from './image.ts';
import { registerInit } from './init.ts';
import { registerLint } from './lint.ts';
import { registerNode } from './node.ts';
import { registerObserve } from './observe.ts';
import { registerRestore } from './restore.ts';
import { registerSecret } from './secret.ts';
import { registerService } from './service.ts';
import { registerVolume } from './volume.ts';

test('collectList accepts repeated flags, comma-separated lists and both, trimming and dropping empty items', () => {
  assert.deepEqual(collectList('db', []), ['db'], 'a single value is one item');
  assert.deepEqual(collectList('db,web', []), ['db', 'web'], 'a comma-separated list is split');
  assert.deepEqual(
    collectList('web', collectList('db', [])),
    ['db', 'web'],
    'repeating the flag appends in order',
  );
  assert.deepEqual(
    collectList(' db , web,,', ['cache']),
    ['cache', 'db', 'web'],
    'spaces are trimmed, empty items are dropped and the list appends to earlier flags',
  );
  assert.deepEqual(collectList(',', []), [], 'a value with no items adds nothing');
});

function everyOption(command: Command): { path: string; option: Option }[] {
  return [
    ...command.options.map((option) => ({ path: command.name(), option })),
    ...command.commands.flatMap((child) =>
      everyOption(child).map((found) => ({ ...found, path: `${command.name()} ${found.path}` })),
    ),
  ];
}

test('every flag that takes several values accepts a comma-separated list', () => {
  const program = new Command();
  for (const register of [
    registerBackup,
    registerControl,
    registerCredential,
    registerDeploy,
    registerHold,
    registerImage,
    registerInit,
    registerLint,
    registerNode,
    registerObserve,
    registerRestore,
    registerSecret,
    registerService,
    registerVolume,
  ])
    register(program);
  const multi = everyOption(program).filter(({ option }) => Array.isArray(option.defaultValue));
  assert.deepEqual(
    [...new Set(multi.map(({ option }) => option.long))].sort(),
    ['--env', '--extra-san', '--label', '--move', '--project', '--writers'],
    'a new multi-value flag must be added here, documented in docs/cli.md and use collectList',
  );
  for (const { path, option } of multi) {
    assert.deepEqual(
      option.parseArg?.('a, b', ['z']),
      ['z', 'a', 'b'],
      `${path} ${option.long} should split a comma-separated value and append to repeated ones`,
    );
    assert.match(
      option.description,
      /comma-separate/,
      `${path} ${option.long} help should say that it takes a comma-separated list`,
    );
  }
});
