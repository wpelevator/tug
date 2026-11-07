import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { saveImageArchive } from '../artifacts.ts';
import { controlPortCheck, localImageBuildArgs, shellQuote as sh } from '../cli-install.ts';
import {
  LIST_ADDRESSES_COMMAND,
  parseAddressCandidates,
  sortCandidates,
} from '../cli-onboarding.ts';
import type { AddressCandidate } from '../cli-onboarding.ts';
import { runCapture, runLocal, templatesDir } from './context.ts';

export async function preflightRemote(
  target: string,
  {
    controlUrl,
    ports = [],
    minDiskMb = 1024,
    compose = false,
  }: {
    controlUrl?: string;
    ports?: number[];
    minDiskMb?: number;
    /** Requires the Compose plugin; only the control host runs Compose, nodes need the Docker Engine alone. */
    compose?: boolean;
  } = {},
): Promise<void> {
  const checks: [string, string, string][] = [
    [
      'docker.version',
      'docker version >/dev/null',
      'Install Docker Engine and ensure the SSH user can access it.',
    ],
    ...(compose
      ? ([
          [
            'docker.compose.version',
            'docker compose version >/dev/null',
            'Install Docker Compose v2.',
          ],
        ] as [string, string, string][])
      : []),
    [
      'paths',
      'mkdir -p /opt/tug-preflight /var/lib/tug-preflight /etc/tug && test -w /opt/tug-preflight && test -w /var/lib/tug-preflight && test -w /etc/tug',
      'Ensure /opt, /var/lib, and /etc/tug are writable by the installer.',
    ],
    [
      'disk.space',
      `[ "$(df -Pm /var/lib | tail -1 | awk '{print $4}')" -ge ${Number(minDiskMb)} ]`,
      `Free at least ${minDiskMb}MB on the filesystem backing /var/lib.`,
    ],
  ];
  for (const port of ports) {
    checks.push([
      `port.${port}.free`,
      controlPortCheck(port),
      `Port ${port} is already in use on the target host by something other than the Tug control container; stop the conflicting service or choose another port.`,
    ]);
  }
  if (controlUrl)
    checks.push([
      'control.reachable',
      // TCP reachability only: no credential is copied to the host, and real TLS authorization happens when the agent connects.
      `timeout 5 bash -c ${sh(`exec 3<>/dev/tcp/${new URL(controlUrl).hostname.replace(/^\[|\]$/g, '')}/${new URL(controlUrl).port || 443}`)}`,
      'Verify DNS and the firewall from the node to the control port (control speaks mTLS only, so only TCP reachability is checked here).',
    ]);
  const script = `set -e
${checks.map(([name, cmd, fix]) => `echo "preflight: ${name}"; (${cmd}) || { echo "FAILED ${name}: ${fix}" >&2; exit 20; }`).join('\n')}
`;
  await runLocal('ssh', ['--', target, script]);
}

/**
 * The tag a locally built image runs under on the host: the requested tag plus the image ID, so rebuilding `tug:local`
 * never leaves a running container pointing at a tag that now names another image (Docker would show its ID).
 */
export function immutableLocalTag(imageTag: string, imageId: string): string {
  return `${imageTag}-${imageId.replace(/^sha256:/, '').slice(0, 12)}`;
}

/** Builds the runtime image from the checkout, copies it to the host and returns the immutable tag to run. */
export async function transferTugImage(
  target: string,
  imageTag: string,
  stage: (label: string) => void,
): Promise<string> {
  stage(`Checking architecture on ${target}`);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-runtime-'));
  const archive = path.join(directory, 'image.tar.gz');
  const remote = `/tmp/${path.basename(directory)}.tar.gz`;
  try {
    const uname = await runCapture('ssh', ['--', target, 'uname -m']);
    stage(`Building Tug image ${imageTag}`);
    await runLocal('docker', localImageBuildArgs(imageTag, uname));
    const runTag = immutableLocalTag(
      imageTag,
      (await runCapture('docker', ['image', 'inspect', '--format', '{{.Id}}', imageTag])).trim(),
    );
    stage(`Exporting Tug image ${imageTag}`);
    await saveImageArchive(imageTag, archive);
    stage(`Transferring Tug image to ${target}`);
    await runLocal('scp', ['--', archive, `${target}:${remote}`]);
    stage(`Loading Tug image on ${target}`);
    await runLocal('ssh', [
      '--',
      target,
      `set -eu\ntrap ${sh(`rm -f ${sh(remote)}`)} EXIT\ndocker load --input ${sh(remote)}\ndocker tag ${sh(imageTag)} ${sh(runTag)}`,
    ]);
    return runTag;
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

export async function dockerBootstrap(): Promise<string> {
  return fs.readFile(path.join(templatesDir, 'install-docker.sh'), 'utf8');
}

/** Installs Docker over SSH; `compose` also installs the Compose plugin, which only the control host needs. */
export async function bootstrapDocker(target: string, compose = false): Promise<void> {
  await runLocal('ssh', [
    '--',
    target,
    `${compose ? 'TUG_INSTALL_COMPOSE=1 ' : ''}sh -eu -c ${sh(await dockerBootstrap())}`,
  ]);
}

/** Whether the host already has the Docker Engine (and the Compose plugin when `compose`). */
export function hostHasDocker(target: string, compose = false): boolean {
  const check = `docker version >/dev/null 2>&1${compose ? ' && docker compose version >/dev/null 2>&1' : ''}`;
  return spawnSync('ssh', ['--', target, check], { stdio: 'ignore' }).status === 0;
}

/** The host's short hostname, or undefined when it cannot be read. */
export function remoteHostname(target: string): string | undefined {
  const result = spawnSync('ssh', ['--', target, 'hostname -s'], { encoding: 'utf8' });
  return result.status === 0 ? String(result.stdout).trim() || undefined : undefined;
}

/** The host's global IPv4 addresses, private ones first; empty when the host cannot say. */
export function discoverAddresses(target: string): AddressCandidate[] {
  const result = spawnSync('ssh', ['--', target, LIST_ADDRESSES_COMMAND], { encoding: 'utf8' });
  return result.status === 0 ? sortCandidates(parseAddressCandidates(String(result.stdout))) : [];
}

/**
 * The script that retires a node host: stops the agent and ingress, removes the project containers, networks and
 * agent state. Project volumes (your data) and the ingress certificates go only with `deleteData`. A host that runs
 * the control plane is refused, because removing it would destroy the master key and the private CA.
 */
export function teardownScript(deleteData: boolean): string {
  return [
    'set -eu',
    "if docker ps -a --format '{{.Names}}' | grep -q '^tug-control'; then echo 'this host runs the control plane; retire it by hand (see docs/migration.md)' >&2; exit 3; fi",
    'docker rm -f tug-agent tug-caddy >/dev/null 2>&1 || true',
    'ids=$(docker ps -aq --filter label=tug.project --filter label=tug.job; docker ps -aq --filter label=tug.project)',
    '[ -z "$ids" ] || docker rm -fv $ids >/dev/null',
    "docker network ls -q --filter 'name=^tug_' | xargs -r docker network rm >/dev/null 2>&1 || true",
    'rm -rf /etc/tug /var/lib/tug',
    ...(deleteData
      ? [
          'docker volume ls -q --filter label=tug.project | xargs -r docker volume rm >/dev/null',
          'docker volume rm tug-caddy-data tug-caddy-config tug-caddy-etc tug_restic_cache >/dev/null 2>&1 || true',
        ]
      : []),
    'echo "node host cleaned"',
  ].join('\n');
}
