import { selectNodes, selectNode } from './selection.ts';
import { withProgress } from '../progress.ts';
import type { Command } from 'commander';
import { applyConfigDefaults, normalizeControlUrl, nodeSettings } from '../config.ts';
import { formatNodes } from '../status.ts';
import type { NodeListing } from '../status.ts';
import {
  dockerRunSnippet,
  enrollmentCloudInit,
  shellQuote as sh,
  HOST_NETWORK_FLAG,
} from '../install.ts';
import type { AddressCandidate } from '../onboarding.ts';
import { formatNodePlan, inferNodeName, isValidNodeName } from '../onboarding.ts';
import { ask, canPrompt, confirm } from '../prompt.ts';
import { terminalPicker } from '../pick.ts';
import { runStep, STAGE_MARKER } from '../process.ts';
import type { Prompter } from '../prompt.ts';
import { isNodeHost } from '../../node-address.ts';
import { assertImagePublished, defaultImage, resolveImage } from '../../images/image.ts';
import {
  alreadyRunning,
  assertNotAheadOfControl,
  inspectAgentScript,
  parseAgentInspect,
} from '../upgrade.ts';
import type { AgentInstall } from '../upgrade.ts';
import type { EnrollmentCredentialResponse, IdentityResponse, JoinKey } from '../../protocol.ts';
import { loadTemplate } from '../load-template.ts';
import {
  AGENT_LEFTOVERS,
  AGENT_VOLUME,
  agentGuardScript,
  agentMigrateScript,
  readLegacyControlUrlScript,
  LEGACY_AGENT_DIR,
} from '../migrate.ts';
import { errMessage } from '../../errors.ts';
import {
  collectList,
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
  remoteHostname,
  dockerBootstrap,
  hostHasDocker,
  preflightRemote,
  teardownScript,
  transferTugImage,
} from './host.ts';
import fs from 'node:fs/promises';

/** Everything the SSH-assisted node commands share. */
export interface NodeIdentityOpts extends InstallOpts {
  name?: string;
  address?: string;
  label: string[];
  agentControlUrl?: string;
  all?: boolean;
  select?: boolean;
  wait: boolean;
  ingress?: boolean;
  yes?: boolean;
}

function addNodeIdentityOptions(command: Command): Command {
  return command
    .option('--address <addr>', 'private inter-node address for this node')
    .option('--label <label>', 'node label (repeat or comma-separate for several)', collectList, [])
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
/**
 * The `agent identity` arguments for each mode. Adding a node reuses the key of an agent already enrolled as that
 * name, so re-running `node add` upgrades it in place; replacing or repairing asks for a new key on purpose.
 */
export function agentIdentityArgs(mode: 'create' | 'replace', name: string): string {
  return mode === 'create' ? `identity --current ${sh(name)}` : 'identity';
}

async function installNodeIdentity(
  sshTarget: string,
  name: string,
  mode: 'create' | 'replace',
  o: NodeIdentityOpts & { rolloutPorts?: string },
  repair = false,
  /** False in batch mode, where only the final per-node results are printed. */
  printResult = true,
): Promise<boolean> {
  return withProgress(`Preparing node ${name}`, async (progress) => {
    const cfg = await loadCfg();
    const connectUrl = o.agentControlUrl ? normalizeControlUrl(o.agentControlUrl) : undefined;
    // Fail before touching the host: no credential, or a control older than this CLI (not after Docker is installed).
    await transportFor(cfg, 'probe').then((t) => t.close());
    assertImagePublished(resolveImage(o.image, o.buildLocalImage));
    if (o.installDocker) {
      progress.stage(`Installing Docker on node ${name}`);
      await bootstrapDocker(sshTarget, progress);
    }
    progress.stage(`Checking host ${name}`);
    await preflightRemote(sshTarget, {
      controlUrl: connectUrl ?? cfg.credential?.url,
      progress,
    });
    const requestedImage = resolveImage(o.image, o.buildLocalImage);
    const image = o.buildLocalImage
      ? await transferTugImage(sshTarget, requestedImage, progress)
      : requestedImage;
    const started = new Date().toISOString();
    // Before anything is written: a host that still keeps its state in the old directory must migrate first, or the
    // agent would start on an empty volume.
    progress.stage(`Checking agent state on ${name}`);
    await runStep('ssh', ['--', sshTarget, agentGuardScript(image, name)], { progress });
    if (repair)
      await runLocal('ssh', [
        '--',
        sshTarget,
        `docker run --rm --entrypoint sh -v ${AGENT_VOLUME}:/s ${sh(image)} -c 'cd /s && for f in agent.json agent-pending.json; do [ -e "$f" ] && mv "$f" "$f.corrupt-$(date +%s)"; done; true'`,
      ]);
    const agent = (command: string, interactive = false) =>
      `docker run --rm ${interactive ? '-i ' : ''}-v ${AGENT_VOLUME}:/var/lib/tug ${sh(image)} agent ${command}`;
    progress.stage(`Creating identity for node ${name}`);
    // Adding a node the host is already enrolled as reuses its key, so re-running `node add` upgrades the agent in place;
    // `node replace` and `node repair` deliberately ask for a new key.
    const csr = await runCapture('ssh', ['--', sshTarget, agent(agentIdentityArgs(mode, name))]);
    const response = await request<IdentityResponse>(
      'POST',
      `/api/v1/nodes/${encodeURIComponent(name)}/identity`,
      { csr, mode, address: o.address, labels: o.label },
    );
    await runCapture('ssh', ['--', sshTarget, agent('install-cert', true)], {
      input: JSON.stringify(response),
    });
    progress.stage(`Installing agent on node ${name}`);
    const remote = await loadTemplate(templatesDir, 'node-install.sh', {
      ENV_FLAGS:
        (connectUrl ? `-e TUG_CONTROL_URL=${sh(connectUrl)} ` : '') +
        (o.rolloutPorts ? `-e TUG_ROLLOUT_PORTS=${sh(o.rolloutPorts)} ` : ''),
      IMAGE_SH: sh(image),
      MARKER: STAGE_MARKER,
      RUN_FLAGS: `${HOST_NETWORK_FLAG} `,
    });
    await runStep('ssh', ['--', sshTarget, remote], { progress });
    if (o.ingress)
      await request('POST', `/api/v1/nodes/${encodeURIComponent(name)}/ingress`, { enabled: true });
    const result = { ok: true, node: response.node, ...(o.ingress ? { ingress: true } : {}) };
    let reporting = !o.wait;
    if (o.wait) {
      progress.stage(`Waiting for node ${name} to report`);
      // A report from the new identity: wait for a report after the install began, not a replaced node's stale status.
      for (let i = 0; i < 30; i++) {
        const { nodes } = await request<{ nodes: { name: string; last_seen_at: string | null }[] }>(
          'GET',
          '/api/v1/nodes',
        );
        const seen = nodes.find((n) => n.name === name)?.last_seen_at;
        if (seen && seen > started) {
          reporting = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      if (!reporting)
        console.error(
          `node ${name} has not reported yet; check \`docker logs tug-agent\` on the host`,
        );
    }
    if (printResult) print(o.wait ? { ...result, reporting } : result);
    return reporting;
  });
}

/** The questions and probes `planNodeAdd` makes, injectable so the prompt flow is testable without a terminal or SSH. */
export interface PlanDeps {
  interactive: boolean;
  hasDocker: (target: string) => boolean;
  discover: (target: string) => AddressCandidate[];
  prompt: Prompter;
  /** The inter-node address menu: the labels to show and the entry enter takes; resolves to the chosen index. */
  pickOne: (question: string, labels: readonly string[], initial: number) => Promise<number>;
}

const realPlanDeps = (): PlanDeps => ({
  interactive: canPrompt(),
  hasDocker: (target) => hostHasDocker(target),
  discover: discoverAddresses,
  prompt: ask,
  pickOne: (question, labels, initial) => terminalPicker.one(question, labels, initial),
});

/**
 * What `node add` is about to do, with the choices a terminal can still make: Docker, the inter-node address and the
 * ingress role are asked about, never assumed. Without a terminal nothing is probed or asked and only the plan is printed.
 */
export async function planNodeAdd(
  sshTarget: string,
  name: string,
  o: NodeIdentityOpts,
  deps: PlanDeps = realPlanDeps(),
): Promise<void> {
  const { interactive, prompt } = deps;
  if (interactive && !o.installDocker && !deps.hasDocker(sshTarget))
    o.installDocker = await confirm(
      `Docker is not installed on ${sshTarget}. Install it now (needs root)?`,
      true,
      prompt,
    );
  if (interactive && !o.address) {
    const candidates = deps.discover(sshTarget);
    if (candidates.length) {
      const none = 'none: leave the address unset';
      const options = [
        ...candidates.map(
          (c) => `${c.address} (${c.interface}, ${c.private ? 'private' : 'public'})`,
        ),
        none,
      ];
      // A public address would carry cross-node traffic in the clear, so it is never the default.
      const index = await deps.pickOne(
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
      prompt,
    );
  console.error(
    formatNodePlan({
      name,
      ssh: sshTarget,
      installDocker: o.installDocker,
      probed: interactive,
      address: o.address,
      ingress: o.ingress,
      image: resolveImage(o.image, o.buildLocalImage),
    }),
  );
  if (interactive && !o.yes && !(await confirm(`Add ${name}?`, true, prompt)))
    throw new Error('cancelled; nothing was changed');
}

/**
 * A name for a node when the SSH host does not suggest one (an IP address): in a terminal ask for it, offering the
 * host's own hostname as the default. Without a terminal there is nobody to ask.
 */
async function promptNodeName(sshTarget?: string): Promise<string | undefined> {
  if (!canPrompt()) return undefined;
  const suggestion = sshTarget ? remoteHostname(sshTarget) : undefined;
  const fallback = suggestion && isValidNodeName(suggestion) ? suggestion : undefined;
  for (;;) {
    const answer = (await ask(`Node name${fallback ? ` (${fallback})` : ''}: `)).trim() || fallback;
    if (!answer) continue;
    if (isValidNodeName(answer)) return answer;
    console.error(
      'Use letters, numbers, dots, underscores or hyphens, starting with a letter or number.',
    );
  }
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
  if (o.select && o.all) throw new Error('--select and --all cannot be combined');
  if (o.all || o.select) {
    if (positional.name || positional.ssh)
      throw new Error(`${verb} --all/--select cannot be combined with a node or SSH target`);
    const results: { node: string; ok: boolean; reporting?: boolean; error?: string }[] = [];
    const names = o.select
      ? await selectNodes(Object.keys(cfg.nodes).filter((name) => cfg.nodes[name].ssh))
      : Object.keys(cfg.nodes);
    for (const name of names) {
      const settings = cfg.nodes[name];
      const target = settings.ssh as string | undefined;
      if (!target) continue;
      const merged = { ...o, name };
      applyConfigDefaults(command, merged, nodeSettings(cfg, name));
      try {
        const reporting = await installNodeIdentity(target, name, mode, merged, repair, false);
        results.push({ node: name, ok: true, ...(merged.wait ? { reporting } : {}) });
      } catch (e) {
        results.push({ node: name, ok: false, error: errMessage(e) });
      }
    }
    print({ results });
    if (results.some((r) => !r.ok || r.reporting === false)) process.exitCode = 1;
    return;
  }
  let name = positional.name ?? (positional.ssh ? inferNodeName(positional.ssh) : undefined);
  if (!name && mode === 'replace') name = await selectNode();
  if (!name && mode === 'create') name = await promptNodeName(positional.ssh);
  if (!name)
    throw new Error(
      mode === 'create'
        ? `${verb} needs --name${positional.ssh ? ' (an IP address does not suggest one; in a terminal it asks)' : ''}`
        : `${verb} needs the node name`,
    );
  // Selection or SSH inference may supply the name after the root hook applied defaults.
  o.name = name;
  applyConfigDefaults(command, o, nodeSettings(cfg, name));
  const sshTarget = positional.ssh ?? (nodeSettings(cfg, name).ssh as string | undefined);
  if (!sshTarget)
    throw new Error(
      `${verb} needs an SSH target: pass <ssh-target> or set nodes.${name}.ssh in ${cfg.file}`,
    );
  if (mode === 'create') {
    if (o.agentControlUrl) normalizeControlUrl(o.agentControlUrl);
    await transportFor(cfg, 'probe').then((t) => t.close()); // no questions about a host this CLI cannot enroll
    await planNodeAdd(sshTarget, name, o);
  }
  if (!(await installNodeIdentity(sshTarget, name, mode, o, repair))) process.exitCode = 1;
}

/**
 * Moves one node's agent state from the old host directory into the `tug-agent` volume and reinstalls the agent on
 * it. The old agent is stopped, not removed, and started again if the copy fails; the key is reused, so control sees
 * an ordinary upgrade of the same node. A connect-only control URL the old install kept in /etc/tug/agent.env is
 * carried over unless one is given.
 */
async function migrateNode(
  sshTarget: string,
  name: string,
  o: NodeIdentityOpts,
  printResult = true,
): Promise<boolean> {
  if (!o.agentControlUrl) {
    const legacy = (await runCapture('ssh', ['--', sshTarget, readLegacyControlUrlScript])).trim();
    if (legacy) {
      console.error(`keeping the agent's connect URL ${legacy} from /etc/tug/agent.env`);
      o.agentControlUrl = legacy;
    }
  }
  // Everything that can fail before the agent is reinstalled is checked first: once the old agent is stopped, a node
  // that cannot be reinstalled (no credential, an http:// connect URL, an unreachable control) would be left down.
  await withProgress(`Checking node ${name} before migrating`, async (progress) => {
    const cfg = await loadCfg();
    await transportFor(cfg, 'probe').then((t) => t.close());
    assertImagePublished(resolveImage(o.image, o.buildLocalImage));
    const connectUrl = o.agentControlUrl ? normalizeControlUrl(o.agentControlUrl) : undefined;
    await preflightRemote(sshTarget, { controlUrl: connectUrl ?? cfg.credential?.url, progress });
  });
  await withProgress(
    `Copying agent state of node ${name} into the ${AGENT_VOLUME} volume`,
    (progress) =>
      runStep(
        'ssh',
        ['--', sshTarget, agentMigrateScript(resolveImage(o.image, o.buildLocalImage))],
        { progress },
      ),
  );
  const reporting = await installNodeIdentity(sshTarget, name, 'create', o, false, false);
  if (printResult)
    print({
      ok: true,
      node: name,
      ...(o.wait ? { reporting } : {}),
      leftover: AGENT_LEFTOVERS,
    });
  console.error(
    `node ${name}: the old ${LEGACY_AGENT_DIR} and /etc/tug are no longer used; remove them on the host once the node reports online`,
  );
  return reporting;
}

export interface NodeUpgradeOpts {
  name?: string;
  all?: boolean;
  select?: boolean;
  to?: string;
  image?: string;
  buildLocalImage?: boolean;
  agentControlUrl?: string;
  force?: boolean;
  wait: boolean;
}

type UpgradeResult = {
  node: string;
  ok: boolean;
  upgraded?: boolean;
  reporting?: boolean;
  error?: string;
};

/**
 * Replaces one enrolled node's agent with another image over SSH, with its key, address, labels and connect-only URL
 * (read from the running container) unchanged. A node already on the target image is skipped.
 */
async function upgradeNode(
  sshTarget: string,
  name: string,
  o: NodeUpgradeOpts,
  registered: ReadonlySet<string>,
): Promise<UpgradeResult> {
  if (!registered.has(name))
    throw new Error(`node ${name} is not registered with control; \`tug node add\` enrolls it`);
  let current: AgentInstall;
  try {
    current = parseAgentInspect(await runCapture('ssh', ['--', sshTarget, inspectAgentScript]));
  } catch (e) {
    throw new Error(
      `no agent container on ${sshTarget} (${errMessage(e)}); \`tug node add\` installs one`,
      { cause: e },
    );
  }
  const image = resolveImage(o.image ?? (o.to ? defaultImage(o.to) : undefined), o.buildLocalImage);
  if (alreadyRunning(current.image, image, o.force) && !o.buildLocalImage) {
    console.error(`node ${name} already runs ${image}; skipped (--force reinstalls it)`);
    return { node: name, ok: true, upgraded: false };
  }
  const agentControlUrl = o.agentControlUrl ?? current.controlUrl;
  if (!o.agentControlUrl && current.controlUrl)
    console.error(`node ${name}: keeping the agent's connect URL ${current.controlUrl}`);
  console.error(`node ${name}: ${current.image} -> ${image}`);
  const reporting = await installNodeIdentity(
    sshTarget,
    name,
    'create',
    {
      label: [],
      wait: o.wait,
      image: o.image ?? (o.to ? defaultImage(o.to) : undefined),
      buildLocalImage: o.buildLocalImage,
      agentControlUrl,
      rolloutPorts: current.rolloutPorts,
    },
    false,
    false,
  );
  return { node: name, ok: true, upgraded: true, ...(o.wait ? { reporting } : {}) };
}

/** `node upgrade`, also what `tug upgrade` runs for every configured node once control is upgraded. */
export async function runNodeUpgrade(
  positional: { name?: string; ssh?: string },
  o: NodeUpgradeOpts,
  command: Command,
): Promise<boolean> {
  const cfg = await loadCfg();
  if (o.select && o.all) throw new Error('--select and --all cannot be combined');
  if ((o.all || o.select) && (positional.name || positional.ssh))
    throw new Error('node upgrade --all/--select cannot be combined with a node or SSH target');
  if (o.to && (o.image || o.buildLocalImage))
    throw new Error(
      '--to names a published version; it cannot be combined with --image or --build-local-image',
    );
  if (o.agentControlUrl) normalizeControlUrl(o.agentControlUrl);
  // Fail before touching any host: no credential, a control older than this CLI, or --to newer than the control.
  const control = await transportFor(cfg, 'probe');
  await control.close();
  if (o.to)
    assertNotAheadOfControl(o.to, (await request<{ v: string }>('GET', '/api/v1/version')).v);
  const { nodes } = await request<{ nodes: { name: string }[] }>('GET', '/api/v1/nodes');
  const registered = new Set(nodes.map((n) => n.name));
  if (o.all || o.select) {
    const names = o.select
      ? await selectNodes(Object.keys(cfg.nodes).filter((name) => cfg.nodes[name].ssh))
      : Object.keys(cfg.nodes);
    const results: UpgradeResult[] = [];
    for (const name of names) {
      const target = cfg.nodes[name].ssh as string | undefined;
      if (!target) continue;
      const merged = { ...o, name };
      applyConfigDefaults(command, merged, nodeSettings(cfg, name));
      try {
        results.push(await upgradeNode(target, name, merged, registered));
      } catch (e) {
        results.push({ node: name, ok: false, error: errMessage(e) });
      }
    }
    print({ results });
    return !results.some((r) => !r.ok || r.reporting === false);
  }
  const name = positional.name ?? (await selectNode());
  o.name = name;
  applyConfigDefaults(command, o, nodeSettings(cfg, name));
  const sshTarget = positional.ssh ?? (nodeSettings(cfg, name).ssh as string | undefined);
  if (!sshTarget)
    throw new Error(
      `node upgrade needs an SSH target: pass <ssh-target> or set nodes.${name}.ssh in ${cfg.file}`,
    );
  const result = await upgradeNode(sshTarget, name, o, registered);
  print(result);
  return result.reporting !== false;
}

async function runNodeMigrate(
  positional: { name?: string; ssh?: string },
  o: NodeIdentityOpts,
  command: Command,
): Promise<void> {
  const cfg = await loadCfg();
  if (o.select && o.all) throw new Error('--select and --all cannot be combined');
  if (o.all || o.select) {
    if (positional.name || positional.ssh)
      throw new Error('node migrate --all/--select cannot be combined with a node or SSH target');
    const results: { node: string; ok: boolean; reporting?: boolean; error?: string }[] = [];
    const names = o.select
      ? await selectNodes(Object.keys(cfg.nodes).filter((name) => cfg.nodes[name].ssh))
      : Object.keys(cfg.nodes);
    for (const name of names) {
      const target = cfg.nodes[name].ssh as string | undefined;
      if (!target) continue;
      const merged = { ...o, name };
      applyConfigDefaults(command, merged, nodeSettings(cfg, name));
      try {
        const reporting = await migrateNode(target, name, merged, false);
        results.push({ node: name, ok: true, ...(merged.wait ? { reporting } : {}) });
      } catch (e) {
        results.push({ node: name, ok: false, error: errMessage(e) });
      }
    }
    print({ results });
    if (results.some((r) => !r.ok || r.reporting === false)) process.exitCode = 1;
    return;
  }
  const name = positional.name ?? (await selectNode());
  o.name = name;
  applyConfigDefaults(command, o, nodeSettings(cfg, name));
  const sshTarget = positional.ssh ?? (nodeSettings(cfg, name).ssh as string | undefined);
  if (!sshTarget)
    throw new Error(
      `node migrate needs an SSH target: pass <ssh-target> or set nodes.${name}.ssh in ${cfg.file}`,
    );
  if (o.agentControlUrl) normalizeControlUrl(o.agentControlUrl);
  if (!(await migrateNode(sshTarget, name, o))) process.exitCode = 1;
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
    )
      .option('--select', 'choose registered nodes with configured SSH targets')
      .option(
        '-y, --yes',
        'accepted so scripts can pass the same flags as node add; this never asks',
      )
      .action(
        async (
          name: string | undefined,
          ssh: string | undefined,
          o: NodeIdentityOpts,
          command: Command,
        ) => runNodeIdentity({ name, ssh }, o, 'replace', command, repair),
      );
  }

  node
    .command('upgrade [name] [sshTarget]')
    .description(
      "replace an enrolled node's agent with another Tug image (default: this CLI's version) over SSH, keeping its key, address, labels and connect-only control URL; a node already on the image is skipped. The SSH target defaults to nodes.<name>.ssh in the config file; --all walks every configured node, continuing after failures. Upgrade the control first (tug control upgrade)",
    )
    .option('--all', 'walk every node with an ssh target in the config file')
    .option('--select', 'choose registered nodes with configured SSH targets')
    .option('--to <version>', "upgrade to this published version instead of the CLI's own")
    .option(
      '--image <tag>',
      "Tug image to run (default: ghcr.io/wpelevator/tug:<this CLI's version>)",
    )
    .option(
      '--build-local-image',
      'build the image from the current checkout and copy it to the host over SSH (tags it tug:local unless --image is set); for development',
    )
    .option(
      '--agent-control-url <url>',
      'connect-only URL the agent dials; by default the one the running agent already uses',
    )
    .option('--force', 'reinstall the agent even when it already runs the target image')
    .option('--no-wait', 'do not wait for the node to report after the install')
    .action(
      async (
        name: string | undefined,
        ssh: string | undefined,
        o: NodeUpgradeOpts,
        command: Command,
      ) => {
        if (!(await runNodeUpgrade({ name, ssh }, o, command))) process.exitCode = 1;
      },
    );

  node
    .command('migrate [name] [sshTarget]')
    .description(
      'move the agent state of a node installed before it lived in a Docker volume from /var/lib/tug into the tug-agent volume and reinstall the agent on it, keeping its key (the SSH target defaults to nodes.<name>.ssh in the config file; --all walks every configured node). Run it before the next node add, replace or repair on such a host, which refuse until then',
    )
    .option(
      '--all',
      'walk every node with an ssh target in the config file, continuing after failures',
    )
    .option('--select', 'choose registered nodes with configured SSH targets')
    .option(
      '--agent-control-url <url>',
      "connect-only URL the agent dials (default: the one in the node's /etc/tug/agent.env, if any)",
    )
    .option(
      '--image <tag>',
      "Tug image to run (default: ghcr.io/wpelevator/tug:<this CLI's version>)",
    )
    .option(
      '--build-local-image',
      'build the image from the current checkout and copy it to the host over SSH; for development',
    )
    .option('--no-wait', 'do not wait for the node to report after the install')
    .option('-y, --yes', 'accepted so scripts can pass the same flags as node add; this never asks')
    .action(
      async (
        name: string | undefined,
        ssh: string | undefined,
        o: NodeIdentityOpts,
        command: Command,
      ) => runNodeMigrate({ name, ssh }, { ...o, label: [] }, command),
    );

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
    .option(
      '--name <name>',
      'the node name the key is bound to; mint one key per instance (asked for in a terminal when omitted)',
    )
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
    .option('--label <label>', 'node label (repeat or comma-separate for several)', collectList, [])
    .option('--install-docker', 'print cloud-init that installs Docker and starts the agent')
    .option('--json', 'print JSON including the command or cloud-init payload')
    .action(
      async (
        o: {
          name?: string;
          agentControlUrl?: string;
          address?: string;
          ttl: string;
          image?: string;
          label: string[];
          json?: boolean;
          installDocker?: boolean;
        },
        cmd: Command,
      ) => {
        if (!o.name) {
          o.name = await promptNodeName();
          if (!o.name) throw new Error('node enroll needs --name');
          applyConfigDefaults(cmd, o, nodeSettings(await loadCfg(), o.name));
        }
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
    .option('--label <label>', 'node label (repeat or comma-separate for several)', collectList, [])
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
    .command('address [name] [address]')
    .option('--to <address>', 'new address when choosing a node interactively')
    .description("update a node's inter-node address")
    .action(async (name: string, address: string, o: { to?: string }) => {
      if (address && o.to) throw new Error('pass the address positionally or with --to, not both');
      address = address || o.to || '';
      if (!address)
        throw new Error('node address needs an address; use --to when selecting a node');
      name = await selectNode(name);
      return print(
        await request('POST', `/api/v1/nodes/${encodeURIComponent(name)}/address`, { address }),
      );
    });
  node
    .command('disable [name]')
    .description(
      "block a node's key immediately without deleting its metadata or placement (no SSH needed); bring it back with node replace",
    )
    .action(async (name: string) =>
      print(
        await request(
          'POST',
          `/api/v1/nodes/${encodeURIComponent(await selectNode(name))}/disable`,
          {},
        ),
      ),
    );
  node
    .command('remove [name] [sshTarget]')
    .description(
      'remove a retired node from the control plane (its identity, statuses and queued commands); with --teardown also stop its agent and delete its containers and agent state over SSH',
    )
    .option('--force', 'remove even if the node is still reporting')
    .option(
      '--teardown',
      'also clean the host over SSH (the SSH target defaults to nodes.<name>.ssh in the config file)',
    )
    .option(
      '--delete-data',
      'with --teardown, also delete project volumes and ingress certificates',
    )
    .option('-y, --yes', 'with --teardown, do not ask for confirmation')
    .action(
      async (
        name: string,
        ssh: string | undefined,
        o: { force?: boolean; teardown?: boolean; deleteData?: boolean; yes?: boolean },
      ) => {
        if (!o.teardown) {
          if (ssh || o.deleteData || o.yes)
            throw new Error('an SSH target, --delete-data and --yes need --teardown');
          name = await selectNode(name);
          return print(
            await request(
              'DELETE',
              `/api/v1/nodes/${encodeURIComponent(name)}${o.force ? '?force=true' : ''}`,
            ),
          );
        }
        name = await selectNode(name);
        const cfg = await loadCfg();
        const sshTarget = ssh ?? (nodeSettings(cfg, name).ssh as string | undefined);
        if (!sshTarget)
          throw new Error(
            `--teardown needs an SSH target: pass <ssh-target> or set nodes.${name}.ssh in ${cfg.file}`,
          );
        if (!o.yes) {
          if (!canPrompt())
            throw new Error(
              '--teardown deletes data on the host; pass -y to confirm without a terminal',
            );
          console.error(
            `This will stop the Tug agent on ${sshTarget}, remove its Tug containers and networks and delete the agent's identity (the ${AGENT_VOLUME} volume, and /etc/tug and /var/lib/tug on a host not yet migrated)${
              o.deleteData
                ? ', and DELETE every project volume and the ingress certificates'
                : ' (project volumes are kept)'
            }.`,
          );
          if (!(await confirm('Continue?', false))) throw new Error('cancelled');
        }
        // The control record goes first: it refuses a node that is still placed in a current deployment before any
        // host is touched. A node control no longer knows is cleaned anyway, so a failed cleanup can be retried.
        let removed: unknown = { ok: true, node: name, alreadyRemoved: true };
        try {
          removed = await request('DELETE', `/api/v1/nodes/${encodeURIComponent(name)}?force=true`);
        } catch (error) {
          if (!/node not found/.test(errMessage(error))) throw error;
        }
        await withProgress(`Cleaning node host ${sshTarget}`, async () => {
          await runLocal('ssh', ['--', sshTarget, teardownScript(Boolean(o.deleteData))]);
        });
        print({ ...(removed as object), teardown: sshTarget, deleteData: Boolean(o.deleteData) });
      },
    );

  node
    .command('ingress [name]')
    .description(
      'mark a node as an ingress node (managed Caddy on ports 80/443), or remove the role with --disable',
    )
    .option('--disable', 'stop acting as an ingress node')
    .action(async (name: string, o: { disable?: boolean }) =>
      print(
        await request(
          'POST',
          `/api/v1/nodes/${encodeURIComponent(await selectNode(name))}/ingress`,
          {
            enabled: !o.disable,
          },
        ),
      ),
    );
}
