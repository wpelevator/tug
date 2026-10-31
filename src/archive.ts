import { createReadStream } from 'node:fs';
import * as tar from 'tar';

export async function scanArchive(file: string, inspect: (entry: tar.ReadEntry) => void): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const input = createReadStream(file);
    const parser = new tar.Parser({ strict: true, onReadEntry(entry) {
      try { inspect(entry); entry.resume(); } catch (error) { parser.abort(error as Error); }
    } });
    input.once('error', reject);
    parser.once('error', error => { input.destroy(); reject(error); });
    parser.once('end', resolve);
    input.pipe(parser);
  });
}

