/**
 * Assets a single-file executable cannot read from disk. The native-binary entry (tools/binary/entry.ts) registers
 * them at startup; when nothing is registered every reader falls back to disk, so Node, tests and the npm package
 * behave as before.
 */
import fs from 'node:fs';
import path from 'node:path';

let version: string | undefined;
let templates: Record<string, string> | undefined;

export function registerEmbedded(assets?: { version: string; templates: Record<string, string> }) {
  version = assets?.version;
  templates = assets?.templates;
}

export const isEmbedded = (): boolean => version !== undefined;
export const embeddedVersion = (): string | undefined => version;

/** Reads a template by file name: the embedded copy when registered, otherwise `templatesDir` on disk. */
export function readTemplate(templatesDir: string, name: string): string {
  return templates?.[name] ?? fs.readFileSync(path.join(templatesDir, name), 'utf8');
}
