import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Command } from 'commander';
import { writeInitConfig } from '../cli-config.ts';
import type { ResolvedCliConfig } from '../cli-config.ts';
import { decodeCredential, writeFileDurable } from '../pki.ts';
import { loadCfg, readStdin } from './context.ts';

/**
 * Store a credential document in a 0600 file under the user's config directory and point the git-ignored overlay
 * next to the tracked config at it, creating the tracked config when it is missing. Prints what it wrote.
 */
export async function importCredential(
  cfg: ResolvedCliConfig,
  text: string,
  connection: { controlUrl?: string; project?: string },
): Promise<void> {
  const credential = decodeCredential(text);
  // TUG_CREDENTIALS_DIR keeps scripts and tests out of the real home directory.
  const dir =
    process.env.TUG_CREDENTIALS_DIR ||
    path.join(
      process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
      'tug',
      'credentials',
    );
  const source = path.join(
    dir,
    `${new URL(credential.url).host.replace(/[^A-Za-z0-9.-]/g, '_')}.json`,
  );
  await writeFileDurable(source, `${JSON.stringify(credential, null, 2)}\n`, 0o600);
  for (const file of await writeInitConfig(cfg, source, connection, credential.url))
    console.log(`wrote ${file}`);
  console.log(`imported credential to ${source}`);
}

export function registerInit(program: Command): void {
  program
    .command('init [credentialFile]')
    .description(
      'create the config file if missing and import a credential (a file, or - for stdin) into a 0600 user-config file that the git-ignored .local overlay points at',
    )
    .action(async (credentialFile: string | undefined, _o: unknown, command: Command) => {
      const cfg = await loadCfg();
      const { controlUrl, project } = command.optsWithGlobals<{
        controlUrl?: string;
        project?: string;
      }>();
      let text: string | undefined;
      if (credentialFile === '-') text = await readStdin();
      else if (credentialFile) text = await fs.readFile(credentialFile, 'utf8');
      else if (cfg.credential) text = JSON.stringify(cfg.credential);
      if (!text) throw new Error('tug init needs a credential file (or - for stdin)');
      await importCredential(cfg, text, { controlUrl, project });
    });
}
