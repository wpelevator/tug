import assert from 'node:assert/strict';
import test from 'node:test';
import { ESLint } from 'eslint';

// The CLI reaches its process only through a CliRuntime (docs/architecture.md#the-cli-runtime). These tests run the
// repository's own ESLint configuration over small snippets, so the rule that keeps that boundary cannot be loosened
// or bypassed by a new spelling without a test failing.

const eslint = new ESLint({ cwd: process.cwd() });

async function errors(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages.filter((m) => m.severity === 2).map((m) => `${m.ruleId}: ${m.message}`);
}

const FORBIDDEN: [string, string][] = [
  ['reading the process environment', 'export const a = process.env.HOME;'],
  ['the working directory of the process', 'export const a = process.cwd();'],
  ['writing to the process streams', "process.stdout.write('x');"],
  ['console output', "console.log('x');"],
  ['globalThis.process', 'export const a = globalThis.process.env.HOME;'],
  ['globalThis.console', "globalThis.console.log('x');"],
  [
    'the process imported by default',
    "import process from 'node:process';\nexport const a = process;",
  ],
  ['named imports of the process', "import { env } from 'node:process';\nexport const a = env;"],
  ['a bare process import', "import process from 'process';\nexport const a = process;"],
  ['os.homedir', "import os from 'node:os';\nexport const a = os.homedir();"],
  ['a named homedir import', "import { homedir } from 'node:os';\nexport const a = homedir();"],
];

test('src/cli cannot reach the process, the console or the home directory except through the runtime', async () => {
  for (const [name, code] of FORBIDDEN)
    assert.ok(
      (await errors(code, 'src/cli/example.ts')).length > 0,
      `ESLint should reject ${name} in src/cli`,
    );
});

test('the runtime module, tests and code outside src/cli may use the process', async () => {
  const code = "export const a = process.env.HOME;\nconsole.log('x');";
  assert.deepEqual(await errors(code, 'src/cli/runtime.ts'), [], 'runtime.ts is the one boundary');
  assert.deepEqual(await errors(code, 'src/cli/example.test.ts'), [], 'tests may use the process');
  assert.deepEqual(await errors(code, 'src/control/example.ts'), [], 'other roles are not covered');
});

test('code that takes everything from the runtime is accepted', async () => {
  const code = [
    "import path from 'node:path';",
    "import { err, homeDir, out, resolvePath } from './runtime.ts';",
    "import type { CliRuntime } from './runtime.ts';",
    'export function run(rt: CliRuntime): string {',
    '  out(rt, rt.env.HOME ?? homeDir(rt));',
    "  err(rt, 'warned');",
    "  return path.join(resolvePath(rt, 'x'), rt.cwd);",
    '}',
  ].join('\n');
  assert.deepEqual(await errors(code, 'src/cli/example.ts'), [], 'the runtime forms are the way');
});
