import type { Command } from 'commander';
import { applyConfigDefaults, normalizeControlUrl, nodeSettings } from '../cli-config.ts';
import { formatNodes } from '../cli-status.ts';
import type { NodeListing } from '../cli-status.ts';
import {
  dockerRunSnippet,
  enrollmentCloudInit,
  shellQuote as sh,
  HOST_NETWORK_FLAG,
} from '../cli-install.ts';
import { inferNodeName } from '../cli-onboarding.ts';
import { canPrompt, choose, confirm } from '../cli-prompt.ts';
import { isNodeHost } from '../node-address.ts';
import { resolveImage } from '../image.ts';
import type { EnrollmentCredentialResponse, IdentityResponse, JoinKey } from '../protocol.ts';
import { errMessage, loadTemplate } from '../util.ts';
import {
  collect,
  loadCfg,
  print,
  readStdin,
  request,
  runCapture,
  runLocal,
  templatesDir,
  transportFor,
} from './context.ts';
import type { InstallOpts } from './context.ts';
import {
  bootstrapDocker,
  discoverAddresses,
  dockerBootstrap,
  hostHasDocker,
  preflightRemote,
  transferTugImage,
} from './host.ts';
import fs from 'node:fs/promises';

/** Everything the SSH-assisted node commands share. */
interface NodeIdentityOpts extends InstallOpts {
  name?: string;
  address?: string;
  label: string[];
  agentControlUrl?: string;
  all?: boolean;
  wait: boolean;
  ingress?: boolean;
  yes?: boolean;
}
const AGENT_STATE = '/var/lib/tug';

function addNodeIdentityOptions(command: Command): Command {
  return command
    .option('--address <addr>', 'private inter-node address for this node')
    .option('--label <label>', 'node label (repeatable)', collect, [])
    .option(
      '--all',
      'walk every node with an ssh target in the config file, continuing after failures',
    )
    .option(
      '--agent-control-url <url>',
      'connect-only URL the agent dials (for example a private address); the certificate is still verified against the credential URL',
    )
    .option(
      '--image <tag>',
      "Tug image to run (default: ghcr.io/wpelevator/tug:<this CLI's version>)",
    )
    .option(
      '--install-docker',
      'install missing Docker Engine on supported Debian, Ubuntu, Fedora and RHEL-compatible hosts (root required)',
    )
    .option(
      '--build-local-image',
      'build the image from the current checkout and copy it to the host over SSH (tags it tug:local unless --image is set); for development',
    )
    .option('--no-wait', 'do not wait for the node to report after the install');
}

/**
 * The SSH-assisted flow: the node makes its own key and CSR, an admin credential authorizes the identity at this moment and
 * the certificate is installed back over SSH, so no bootstrap secret travels and the private key never leaves the node.
 */
async function installNodeIdentity(
  sshTarget: string,
  name: string,
  mode: 'create' | 'replace',
  o: NodeIdentityOpts,
  repair = false,
  /** False in batch mode, where only the final per-node results are printed. */
  printResult = true,
): Promise<void> {
  const cfg = await loadCfg();
  const connectUrl = o.agentControlUrl ? normalizeControlUrl(o.agentControlUrl) : undefined;
  await transportFor(cfg).then((t) => t.close()); // fail before touching the host when there is no credential
  if (o.installDocker) await bootstrapDocker(sshTarget);
  preflightRemote(sshTarget, {
    controlUrl: connectUrl ?? cfg.credential?.url,
  });
  const image = resolveImage(o.image, o.buildLocalImage);
  if (o.buildLocalImage) await transferTugImage(sshTarget, image);
  const started = new Date().toISOString();
  if (repair)
    runLocal('ssh', [
      '--',
      sshTarget,
      `mkdir -p ${AGENT_STATE} && cd ${AGENT_STATE} && for f in agent.json agent-pending.json; do [ -e "$f" ] && mv "$f" "$f.corrupt-$(date +%s)"; done; true`,
    ]);
  const agent = (command: string, interactive = false) =>
    `mkdir -p ${AGENT_STATE} && docker run --rm ${interactive ? '-i ' : ''}-v ${AGENT_STATE}:${AGENT_STATE} ${sh(image)} agent ${command}`;
  const csr = runCapture('ssh', ['--', sshTarget, agent('identity')]);
  const response = await request<IdentityResponse>(
    'POST',
    `/api/v1/nodes/${encodeURIComponent(name)}/identity`,
    { csr, mode, address: o.address, labels: o.label },
  );
  runCapture('ssh', ['--', sshTarget, agent('install-cert', true)], {
    input: JSON.stringify(response),
  });
  const env = await loadTemplate(templatesDir, 'agent.env', {
    CONTROL_URL_LINE: connectUrl ? `TUG_CONTROL_URL=${connectUrl}\n` : '',
    NODE_NAME: name,
  });
  const remote = await loadTemplate(templatesDir, 'node-install.sh', {
    ENV: env,
    IMAGE_SH: sh(image),
    RUN_FLAGS: `${HOST_NETWORK_FLAG} `,
  });
  runLocal('ssh', ['--', sshTarget, remote]);
  if (o.ingress)
    await request('POST', `/api/v1/nodes/${encodeURIComponent(name)}/ingress`, { enabled: true });
  const result = { ok: true, node: response.node, ...(o.ingress ? { ingress: true } : {}) };
  if (o.wait) {
    // A report from the new identity: wait for a report after the install began, not a replaced node's stale status.
    for (let i = 0; i < 30; i++) {
      const { nodes } = await request<{ nodes: { name: string; last_seen_at: string | null }[] }>(
        'GET',
        '/api/v1/nodes',
      );
      const seen = nodes.find((n) => n.name === name)?.last_seen_at;
      if (seen && seen > started) {
        if (printResult) print(result);
        return;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    console.error(`node ${name} has not reported yet; check \`docker logs tug-agent\` on the host`);
  }
  if (printResult) print(result);
}

/**
 * What `node add` is about to do, with the choices a terminal can still make: Docker, the inter-node address and the
 * ingress role are asked about, never assumed. Without a terminal nothing is probed or asked and only the plan is printed.
 */
async function planNodeAdd(sshTarget: string, name: string, o: NodeIdentityOpts): Promise<void> {
  const interactive = canPrompt();
  if (interactive && !o.installDocker && !hostHasDocker(sshTarget))
    o.installDocker = await confirm(
      `Docker is not installed on ${sshTarget}. Install it now (needs root)?`,
    );
  if (interactive && !o.address) {
    const candidates = discoverAddresses(sshTarget);
    if (candidates.length) {
      const none = 'none: leave the address unset';
      const options = [
        ...candidates.map(
          (c) => `${c.address} (${c.interface}, ${c.private ? 'private' : 'public'})`,
        ),
        none,
      ];
      // A public address would carry cross-node traffic in the clear, so it is never the default.
      const index = await choose(
        `Which address should other nodes use to reach ${name}?`,
        options,
        candidates[0].private ? 0 : options.length - 1,
      );
      if (index < candidates.length) o.address = candidates[index].address;
    }
  }
  if (interactive && o.ingress === undefined)
    o.ingress = await confirm(
      `Should ${name} handle ingress (managed Caddy on ports 80 and 443)?`,
      false,
    );
  console.error(
    [
      'Node plan',
      `  name:     ${name}`,
      `  ssh:      ${sshTarget}`,
      `  docker:   ${o.installDocker ? 'install' : 'must already be installed'}`,
      `  address:  ${o.address ?? 'not set'}`,
      `  ingress:  ${o.ingress ? 'enabled (Caddy on ports 80 and 443)' : 'no'}`,
      `  image:    ${resolveImage(o.image, o.buildLocalImage)}`,
    ].join('\n'),
  );
  if (interactive && !o.yes && !(await confirm(`Add ${name}?`)))
    throw new Error('cancelled; nothing was changed');
}

async function runNodeIdentity(
  positional: { name?: string; ssh?: string },
  o: NodeIdentityOpts,
  mode: 'create' | 'replace',
  command: Command,
  repair = false,
): Promise<void> {
  const cfg = await loadCfg();
  const verb = repair ? 'node repair' : mode === 'create' ? 'node add' : 'node replace';
  if (o.all) {
    if (positional.name || positional.ssh)
      throw new Error(`${verb} --all walks every configured node; do not name one`);
    const results: { node: string; ok: boolean; error?: string }[] = [];
    for (const [name, settings] of Object.entries(cfg.nodes)) {
      const target = settings.ssh as string | undefined;
      if (!target) continue;
      const merged = { ...o, name };
      applyConfigDefaults(command, merged, nodeSettings(cfg, name));
      try {
        await installNodeIdentity(target, name, mode, merged, repair, false);
        results.push({ node: name, ok: true });
      } catch (e) {
        results.push({ node: name, ok: false, error: errMessage(e) });
      }
    }
    print({ results });
    if (results.some((r) => !r.ok)) process.exitCode = 1;
    return;
  }
  const name = positional.name ?? (positional.ssh ? inferNodeName(positional.ssh) : undefined);
  if (!name)
    throw new Error(
      mode === 'create'
        ? `${verb} needs --name${positional.ssh ? ' (an IP address does not suggest one)' : ''}`
        : `${verb} needs the node name`,
    );
  if (mode === 'create') {
    // The name may have come from the SSH host, after the config defaults were applied without one.
    o.name = name;
    applyConfigDefaults(command, o, nodeSettings(cfg, name));
  }
  const sshTarget = positional.ssh ?? (nodeSettings(cfg, name).ssh as string | undefined);
  if (!sshTarget)
    throw new Error(
      `${verb} needs an SSH target: pass <ssh-target> or set nodes.${name}.ssh in ${cfg.file}`,
    );
  if (mode === 'create') await planNodeAdd(sshTarget, name, o);
  await installNodeIdentity(sshTarget, name, mode, o, repair);
}

export function registerNode(program: Command): void {
  const node = program.command('node').description('add, inspect, repair and remove nodes');

  addNodeIdentityOptions(
    node
      .command('add [sshTarget]')
      .description(
        'create a node and install its agent over SSH; the name defaults to the first label of the SSH host and the SSH target to nodes.<name>.ssh in the config file. In a terminal it offers to install Docker, choose the inter-node address and enable ingress, then shows a plan to confirm. Safe to rerun after a partial failure',
      )
      .option('--name <name>', 'node name (default: the first DNS label of the SSH host)')
      .option('--ingress', 'also make the node an ingress node (managed Caddy on ports 80/443)')
      .option('-y, --yes', 'do not ask for confirmation in a terminal'),
  ).action(async (ssh: string | undefined, o: NodeIdentityOpts, command: Command) =>
    runNodeIdentity({ name: o.name, ssh }, o, 'create', command),
  );

  for (const [verb, description, repair] of [
    [
      'replace',
      'install a new key on an existing node over SSH: for an expired, lost or suspected key, a disabled node, a CA loss or an older restore',
      false,
    ],
    [
      'repair',
      'move aside corrupt agent credential documents on the node (never service volumes) and replace its identity',
      true,
    ],
  ] as const) {
    addNodeIdentityOptions(
      node
        .command(`${verb} [name] [sshTarget]`)
        .description(
          `${description} (the SSH target defaults to nodes.<name>.ssh in the config file; --all walks every configured node)`,
        ),
    ).action(
      async (
        name: string | undefined,
        ssh: string | undefined,
        o: NodeIdentityOpts,
        command: Command,
      ) => runNodeIdentity({ name, ssh }, o, 'replace', command, repair),
    );
  }

  node
    .command('list')
    .alias('ls')
    .description(
      'list the registered nodes with their state, address, ingress role and last contact',
    )
    .option('--json', 'print the raw API result as JSON')
    .action(async (o: { json?: boolean }) => {
      const result = await request<{ nodes: NodeListing[] }>('GET', '/api/v1/nodes');
      if (o.json) print(result);
      else console.log(formatNodes(result.nodes));
    });

  node
    .command('enroll')
    .description(
      'mint a single-use, name-bound join key so a host you cannot SSH to can self-join with one docker run; a saved cloud-init document contains a credential',
    )
    .requiredOption('--name <name>', 'the node name the key is bound to; mint one key per instance')
    .option('--address <addr>', 'private inter-node address for this node')
    .option(
      '--agent-control-url <url>',
      'connect-only URL the agent dials; the certificate is still verified against the credential URL',
    )
    .option('--ttl <seconds>', 'join key lifetime', '3600')
    .option(
      '--image <tag>',
      "agent image used in the printed docker run (default: ghcr.io/wpelevator/tug:<this CLI's version>)",
    )
    .option('--label <label>', 'node label (repeatable)', collect, [])
    .option('--install-docker', 'print cloud-init that installs Docker and starts the agent')
    .option('--json', 'print JSON including the command or cloud-init payload')
    .action(
      async (o: {
        name: string;
        agentControlUrl?: string;
        address?: string;
        ttl: string;
        image?: string;
        label: string[];
        json?: boolean;
        installDocker?: boolean;
      }) => {
        if (o.address !== undefined && !isNodeHost(o.address))
          throw new Error('address must be an IP address or hostname without a port');
        const connectUrl = o.agentControlUrl ? normalizeControlUrl(o.agentControlUrl) : undefined;
        const minted = await request<EnrollmentCredentialResponse>(
          'POST',
          '/api/v1/nodes/enrollment-credential',
          {
            name: o.name,
            ttlSeconds: Number(o.ttl),
            labels: o.label.length ? o.label : undefined,
          },
        );
        const keyPayload: JoinKey = {
          v: 2,
          credential: minted.credential,
          name: minted.name,
          ...(connectUrl ? { connectUrl } : {}),
        };
        const joinKey = Buffer.from(JSON.stringify(keyPayload)).toString('base64url');
        const command = dockerRunSnippet(resolveImage(o.image), joinKey, o.address);
        const cloudInit = o.installDocker
          ? enrollmentCloudInit(await dockerBootstrap(), command)
          : undefined;
        if (o.json) {
          print({
            name: minted.name,
            expiresAt: minted.expiresAt,
            joinKey,
            command,
            ...(cloudInit ? { cloudInit } : {}),
          });
          return;
        }
        if (cloudInit) {
          process.stdout.write(cloudInit);
          return;
        }
        console.log(
          `# Join key for ${minted.name} valid until ${minted.expiresAt}, single use. Run on the fresh host:\n`,
        );
        console.log(command);
      },
    );

  node
    .command('register <name>')
    .description(
      'sign a node-generated CSR and print the identity response (the primitive behind node add; the private key stays with whoever made the CSR)',
    )
    .requiredOption('--csr <file>', 'PEM certificate request generated on the node (- for stdin)')
    .option('--mode <mode>', 'create a new node or replace an existing node key', 'create')
    .option('--address <addr>')
    .option('--label <label>', 'node label (repeatable)', collect, [])
    .action(
      async (name: string, o: { csr: string; mode: string; address?: string; label: string[] }) => {
        if (o.mode !== 'create' && o.mode !== 'replace')
          throw new Error("--mode must be 'create' or 'replace'");
        const csr = o.csr === '-' ? await readStdin() : await fs.readFile(o.csr, 'utf8');
        print(
          await request<IdentityResponse>(
            'POST',
            `/api/v1/nodes/${encodeURIComponent(name)}/identity`,
            { csr, mode: o.mode, address: o.address, labels: o.label },
          ),
        );
      },
    );
  node
    .command('address <name> <address>')
    .description("update a node's inter-node address")
    .action(async (name: string, address: string) =>
      print(
        await request('POST', `/api/v1/nodes/${encodeURIComponent(name)}/address`, { address }),
      ),
    );
  node
    .command('disable <name>')
    .description(
      "block a node's key immediately without deleting its metadata or placement (no SSH needed); bring it back with node replace",
    )
    .action(async (name: string) =>
      print(await request('POST', `/api/v1/nodes/${encodeURIComponent(name)}/disable`, {})),
    );
  node
    .command('remove <name>')
    .description(
      'remove a retired node from the control plane (its identity, statuses and queued commands); stop its agent and remove its containers on the host yourself',
    )
    .option('--force', 'remove even if the node is still reporting')
    .action(async (name: string, o: { force?: boolean }) =>
      print(
        await request(
          'DELETE',
          `/api/v1/nodes/${encodeURIComponent(name)}${o.force ? '?force=true' : ''}`,
        ),
      ),
    );
  node
    .command('ingress <name>')
    .description(
      'mark a node as an ingress node (managed Caddy on ports 80/443), or remove the role with --disable',
    )
    .option('--disable', 'stop acting as an ingress node')
    .action(async (name: string, o: { disable?: boolean }) =>
      print(
        await request('POST', `/api/v1/nodes/${encodeURIComponent(name)}/ingress`, {
          enabled: !o.disable,
        }),
      ),
    );
}
