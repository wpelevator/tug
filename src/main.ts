#!/usr/bin/env node
// Single entrypoint for the control plane and agent images; role picked via TUG_ROLE or argv.
const role = process.argv[2] || process.env.TUG_ROLE;
const command = process.argv[3];

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

const usage = `Usage: tug-runtime <control|agent> [command]
  control                          run the control plane (needs TUG_CONTROL_URL)
  control issue-credential         issue an operator credential on the control-plane host (--name, --role, --replace)
  agent                            run the node agent
  agent identity [--current NODE]  print the CSR for this node's pending key, or for the installed key of NODE
  agent install-cert               install an identity response read from stdin`;
if (process.argv.slice(2).some((a) => a === '--help' || a === '-h' || a === 'help')) {
  console.log(usage);
  process.exit(0);
}

switch (role) {
  case 'control': {
    if (command === 'issue-credential') {
      const { issueHostCredential, parseIssueArgs } = await import('./control-credential.ts');
      process.stdout.write(`${await issueHostCredential(parseIssueArgs(process.argv.slice(4)))}\n`);
      break;
    }
    const { createApp, listen } = await import('./control.ts');
    const { SchemaTooNewError } = await import('./db-migrate.ts');
    try {
      const app = await createApp();
      await listen(app);
    } catch (error) {
      // The container is restarted by Docker until the operator acts, so make the one line in its log the remedy.
      if (!(error instanceof SchemaTooNewError)) throw error;
      console.error(`error: ${error.message}`);
      process.exit(1);
    }
    break;
  }
  case 'agent': {
    if (command === 'identity') {
      // One-shot: print the CSR for the pending key (generated into the state volume on first use). Safe to repeat.
      // `--current <node>` reuses the installed key when this host is already enrolled as that node.
      const { agentIdentityCsr } = await import('./agent-credential.ts');
      // An operator reads this through `tug node add` over SSH: a plain message, not a stack trace.
      try {
        const flag = process.argv.indexOf('--current');
        const current = flag === -1 ? undefined : process.argv[flag + 1];
        if (flag !== -1 && !current) throw new Error('--current needs a node name');
        process.stdout.write(
          await agentIdentityCsr(process.env.TUG_STATE_DIR || '/var/lib/tug', { current }),
        );
      } catch (error) {
        console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
      break;
    }
    if (command === 'install-cert') {
      // One-shot: read the identity response from stdin, validate it against the pending key and install it durably.
      const { installCertFromText } = await import('./agent-credential.ts');
      const doc = await installCertFromText(
        process.env.TUG_STATE_DIR || '/var/lib/tug',
        await readStdin(),
      );
      console.log(`installed identity for node ${doc.nodeName}`);
      break;
    }
    const { main } = await import('./agent.ts');
    const { SchemaTooNewError } = await import('./db-migrate.ts');
    try {
      await main();
    } catch (error) {
      if (!(error instanceof SchemaTooNewError)) throw error;
      console.error(`error: ${error.message}`);
      process.exit(1);
    }
    break;
  }
  default: {
    const self = process.argv[1]
      ? `node ${process.argv[1].split('/').slice(-2).join('/')}`
      : 'main';
    console.error(`Usage: TUG_ROLE=control|agent ${self}, or ${self} <control|agent>`);
    process.exit(1);
  }
}
