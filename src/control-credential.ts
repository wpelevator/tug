import path from 'node:path';
import { openDb } from './db.ts';
import { Pki, encodeCredential } from './pki.ts';
import { ROLES, createToken, isRole, parseTokenRequest } from './tokens.ts';

export interface IssueArgs {
  name: string;
  role: string;
  replace: boolean;
}

export function parseIssueArgs(argv: string[]): IssueArgs {
  const args: IssueArgs = { name: 'root', role: 'admin', replace: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--name') args.name = argv[++i];
    else if (argv[i] === '--role') args.role = argv[++i];
    else if (argv[i] === '--replace') args.replace = true;
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!isRole(args.role)) throw new Error(`--role must be one of ${ROLES.join(', ')}`);
  return args;
}

/**
 * Host-side issuance (`docker exec ... control issue-credential`), independent of the API and of any running listener. It
 * is create-only unless `replace` is set, which replaces the named credential's key; a running control closes the old
 * key's sessions within a second. Returns the credential once; control keeps no private-key copy.
 */
export async function issueHostCredential(args: IssueArgs): Promise<string> {
  const dataDir = process.env.TUG_DATA_DIR || './data';
  const publicUrl = process.env.TUG_PUBLIC_URL;
  if (!publicUrl) throw new Error('TUG_PUBLIC_URL is required');
  const db = await openDb(path.join(dataDir, 'tug.db'));
  try {
    const fresh = !db.get('SELECT 1 FROM api_tokens') && !db.get('SELECT 1 FROM nodes');
    const pki = await Pki.load(path.join(dataDir, 'pki'), fresh);
    const request = parseTokenRequest({ name: args.name, role: args.role });
    const created = await createToken(db, pki, new URL(publicUrl).origin, request, 'host', {
      replace: args.replace,
    });
    if (args.replace)
      db.run(
        'INSERT INTO events(id,level,type,message,metadata_json,created_at,actor) VALUES(?,?,?,?,?,?,?)',
        `evt_${Date.now().toString(36)}`,
        'info',
        'token.recover',
        `credential ${args.name} replaced on the control host`,
        '{}',
        new Date().toISOString(),
        'host',
      );
    return encodeCredential(created.credential);
  } finally {
    db.close();
  }
}
