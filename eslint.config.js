import js from '@eslint/js';
import globals from 'globals';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-console': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Flag the long, deeply nested bodies where an early exit hides the paths; extract a function instead.
      'max-depth': ['warn', 5],
      'no-else-return': 'warn',
    },
  },
  {
    // The CLI reaches its process only through the CliRuntime it is given (src/cli/runtime.ts), so any command runs
    // in-process under a test runtime without patching a global. Take env, cwd, streams, signals and the exit code
    // from `rt`; docs/architecture.md#the-cli-runtime says how.
    files: ['src/cli/**/*.ts'],
    ignores: ['src/cli/**/*.test.ts', 'src/cli/runtime.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        {
          name: 'process',
          message:
            'Use the CliRuntime (rt.env, rt.cwd, rt.stdin, rt.stdout, rt.stderr, rt.signals, rt.exitCode) instead of the process.',
        },
        {
          name: 'console',
          message:
            'Write through the CliRuntime: out(rt, ...) for stdout, err(rt, ...) for stderr.',
        },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'os',
          property: 'homedir',
          message: 'Use homeDir(rt), which honours the runtime environment.',
        },
        {
          object: 'globalThis',
          property: 'process',
          message: 'Use the CliRuntime instead of reaching the process through globalThis.',
        },
        {
          object: 'globalThis',
          property: 'console',
          message:
            'Write through the CliRuntime: out(rt, ...) for stdout, err(rt, ...) for stderr.',
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'node:process',
              message: 'Use the CliRuntime instead of importing the process.',
            },
            { name: 'process', message: 'Use the CliRuntime instead of importing the process.' },
            {
              name: 'node:console',
              message: 'Write through the CliRuntime: out(rt, ...) and err(rt, ...).',
            },
            {
              name: 'node:os',
              importNames: ['homedir'],
              message: 'Use homeDir(rt), which honours the runtime environment.',
            },
            {
              name: 'os',
              importNames: ['homedir'],
              message: 'Use homeDir(rt), which honours the runtime environment.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['tests/**/*.ts', 'src/**/*.test.ts'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.mocha,
      },
    },
    rules: {
      // tests poke at untyped JSON bodies
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    ignores: ['node_modules/**', 'dist/**', 'data/**', 'build-contexts/**', '.claude/**'],
  },
];
