import fs from 'node:fs/promises';
import { readStdin } from './context.ts';
import { resolvePath } from '../runtime.ts';
import type { CliRuntime } from '../runtime.ts';

/** A stored value is text; 500 KiB covers a certificate chain or a private key with room to spare. */
const MAX_FILE_BYTES = 500 * 1024;

export interface ValueInputOpts {
  value?: string;
  fromFile?: string;
}

/**
 * The value for `secret set` or `var set`: `--value`, the exact contents of `--from-file` (`-` is all of stdin, to EOF),
 * or one line typed or piped on stdin. A file keeps every newline and space, so a PEM key survives; a line is
 * trimmed, as before, because `echo` and a terminal both end it with a newline.
 */
export async function readValue(rt: CliRuntime, name: string, o: ValueInputOpts): Promise<string> {
  if (o.value !== undefined && o.fromFile !== undefined)
    throw new Error('pass --value or --from-file, not both');
  if (o.fromFile !== undefined) {
    const text =
      o.fromFile === '-'
        ? await readStdin(rt)
        : await fs.readFile(resolvePath(rt, o.fromFile), 'utf8');
    if (text.includes('\0'))
      throw new Error(`${o.fromFile === '-' ? 'stdin' : o.fromFile} is binary; values are text`);
    if (Buffer.byteLength(text) > MAX_FILE_BYTES)
      throw new Error(
        `${o.fromFile === '-' ? 'stdin' : o.fromFile} is larger than ${MAX_FILE_BYTES} bytes`,
      );
    return text;
  }
  if (o.value !== undefined) return o.value;
  return new Promise<string>((resolve) => {
    rt.stdout.write(`${name}: `);
    rt.stdin.once('data', (d) => {
      // This command needs no more input; an open stdin can otherwise keep Node alive.
      rt.stdin.destroy();
      resolve(String(d).trim());
    });
  });
}
