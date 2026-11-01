#!/usr/bin/env node
// Single entrypoint for the control plane and agent images; role picked via TUG_ROLE or argv.
const role = process.argv[2] || process.env.TUG_ROLE;
const command = process.argv[3];

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

switch (role) {
  case 'control': {
    if (command === 'issue-credential') {
      const { issueHostCredential, parseIssueArgs } = await import('./control-credential.ts');
      process.stdout.write(`${await issueHostCredential(parseIssueArgs(process.argv.slice(4)))}\n`);
      break;
    }
    const { createApp, listen } = await import('./control.ts');
    const app = await createApp();
    await listen(app);
    break;
  }
  case 'agent': {
    if (command === 'identity') {
      // One-shot: print the CSR for the pending key (generated into the state volume on first use). Safe to repeat.
      const { agentIdentityCsr } = await import('./agent-credential.ts');
      process.stdout.write(await agentIdentityCsr(process.env.TUG_STATE_DIR || '/var/lib/tug'));
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
    await main();
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
