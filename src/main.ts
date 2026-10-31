#!/usr/bin/env node
// Single entrypoint for the control plane and agent images; role picked via TUG_ROLE or argv.
const role = process.argv[2] || process.env.TUG_ROLE;

switch (role) {
  case 'control': {
    const { createApp, listen } = await import('./control.ts');
    const app = await createApp();
    await listen(app);
    break;
  }
  case 'agent': {
    const { main } = await import('./agent.ts');
    await main();
    break;
  }
  default: {
    const self = process.argv[1] ? `node ${process.argv[1].split('/').slice(-2).join('/')}` : 'main';
    console.error(`Usage: TUG_ROLE=control|agent ${self}, or ${self} <control|agent>`);
    process.exit(1);
  }
}
