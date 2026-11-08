// Entry for the Bun single-file executable (`bun build --compile`). Lives outside src/ so tsc and Node never load it.
// reflect-metadata must run before anything that uses decorators, and the embedded assets must be registered before
// the CLI reads its version or a template.
import 'reflect-metadata';
import { registerEmbedded } from '../../src/embedded.ts';
import pkg from '../../package.json' with { type: 'json' };
import agentEnv from '../../src/templates/agent.env' with { type: 'text' };
import controlCompose from '../../src/templates/control-compose.yml' with { type: 'text' };
import controlInstall from '../../src/templates/control-install.sh' with { type: 'text' };
import installDocker from '../../src/templates/install-docker.sh' with { type: 'text' };
import nodeInstall from '../../src/templates/node-install.sh' with { type: 'text' };

registerEmbedded({
  version: pkg.version,
  templates: {
    'agent.env': agentEnv,
    'control-compose.yml': controlCompose,
    'control-install.sh': controlInstall,
    'install-docker.sh': installDocker,
    'node-install.sh': nodeInstall,
  },
});

await import('../../src/cli.ts');
