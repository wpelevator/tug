#!/usr/bin/env node
// Single entrypoint for the control plane and agent images; role picked via LAUNCHPAD_ROLE or argv.
const role = process.argv[2] || process.env.LAUNCHPAD_ROLE;

switch (role) {
  case 'control': {
    const { createApp } = await import('./control.js');
    const PORT = process.env.PORT || 8080;
    const app = await createApp();
    app.listen(PORT, () => console.log(`launchpad-control listening on ${PORT}`));
    break;
  }
  case 'agent': {
    const { main } = await import('./agent.js');
    await main();
    break;
  }
  default:
    console.error(`Usage: LAUNCHPAD_ROLE=control|agent node src/main.js, or node src/main.js <control|agent>`);
    process.exit(1);
}
