import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ask } from './prompt.ts';
import type { Prompter } from './prompt.ts';

/** `$$` is an escaped dollar; `${NAME}` is required only when it has no `:-`, `-`, `:+`, `+`, `:?` or `?` modifier. */
const REFERENCE = /\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

/** Variable names a Compose file requires, in order of appearance; ones with a default are optional. */
export function requiredVariables(source: string): string[] {
  const names = new Set<string>();
  for (const line of source.split('\n')) {
    if (/^\s*#/.test(line)) continue;
    for (const match of line.matchAll(REFERENCE)) {
      const name = match[1] ?? match[2];
      if (name) names.add(name);
    }
  }
  return [...names];
}

/** Variables Compose reads from the `.env` file next to the Compose file. */
async function dotEnvNames(dir: string): Promise<Set<string>> {
  try {
    const text = await fs.readFile(path.join(dir, '.env'), 'utf8');
    return new Set(
      text
        .split('\n')
        .map((line) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1])
        .filter((name): name is string => !!name),
    );
  } catch {
    return new Set();
  }
}

/**
 * Variables the Compose file references that nothing supplies: not a control secret, the environment
 * or `.env`. Compose would render them empty, which for a password is never intended.
 */
export async function findMissingSecrets(
  file: string,
  secretNames: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const known = new Set(secretNames);
  const dotEnv = await dotEnvNames(path.dirname(file));
  // An unreadable file is reported by the Compose reader with its own message.
  const source = await fs.readFile(file, 'utf8').catch(() => '');
  return requiredVariables(source).filter(
    (name) => !known.has(name) && env[name] === undefined && !dotEnv.has(name),
  );
}

/** A URL-safe random secret with 192 bits of entropy. */
export function generateSecret(): string {
  return crypto.randomBytes(24).toString('base64url');
}

/** Resolve each missing secret interactively; returns the values to store. */
export async function promptForSecrets(
  names: readonly string[],
  prompt: Prompter = ask,
): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const name of names) {
    for (;;) {
      const choice = (
        await prompt(`${name} is missing. [g]enerate a strong password or [e]nter a value? (g) `)
      )
        .trim()
        .toLowerCase();
      if (choice === '' || choice === 'g') {
        values[name] = generateSecret();
        break;
      }
      if (choice === 'e') {
        const value = await prompt(`${name}: `, true);
        if (value) {
          values[name] = value;
          break;
        }
      }
    }
  }
  return values;
}
