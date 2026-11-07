import { isIP } from 'node:net';
import { sshHost } from './cli-install.ts';

const NODE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

/**
 * A node name from an SSH target's host: the first DNS label (`app1` for `root@app1.example.com`). An IP address
 * says nothing about the lifecycle, so it yields no name and the operator has to choose one.
 */
export const isValidNodeName = (name: string): boolean => NODE_NAME.test(name);

export function inferNodeName(sshTarget: string): string | undefined {
  let host: string;
  try {
    host = sshHost(sshTarget);
  } catch {
    return undefined;
  }
  if (isIP(host) !== 0) return undefined;
  const label = host.split('.')[0];
  return NODE_NAME.test(label) ? label : undefined;
}

export interface AddressCandidate {
  interface: string;
  address: string;
  /** RFC 1918 or carrier-grade NAT, the range overlay networks such as Tailscale use. */
  private: boolean;
}

/** The remote command that prints one line per global IPv4 address. */
export const LIST_ADDRESSES_COMMAND = 'ip -o -4 addr show scope global 2>/dev/null || true';

export function isPrivateIPv4(address: string): boolean {
  const [a, b] = address.split('.').map(Number);
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/** Parse `ip -o -4 addr show` output (`2: eth0    inet 10.0.0.7/24 brd ... scope global eth0`). */
/** Interfaces Docker and CNI create on the host: their addresses reach containers, never other nodes. */
const CONTAINER_INTERFACE = /^(docker\d+|br-[0-9a-f]{12}|veth\S*|cni\d+)$/;

export function parseAddressCandidates(output: string): AddressCandidate[] {
  const candidates: AddressCandidate[] = [];
  for (const line of output.split('\n')) {
    const match = /^\d+:\s+(\S+)\s+inet\s+(\d{1,3}(?:\.\d{1,3}){3})\//.exec(line.trim());
    if (!match || isIP(match[2]) !== 4 || CONTAINER_INTERFACE.test(match[1])) continue;
    candidates.push({
      interface: match[1],
      address: match[2],
      private: isPrivateIPv4(match[2]),
    });
  }
  return candidates;
}

/** Private addresses first, since a node's address carries cross-node traffic; otherwise the order the host reports. */
export function sortCandidates(candidates: AddressCandidate[]): AddressCandidate[] {
  return [...candidates].sort((a, b) => Number(b.private) - Number(a.private));
}

export interface NodePlan {
  name: string;
  ssh: string;
  installDocker?: boolean;
  /** False when nothing asked the host, so whether Docker is present is unknown. */
  probed: boolean;
  address?: string;
  ingress?: boolean;
  image: string;
}

/** The plan `node add` shows before it changes anything; it never claims what it did not check. */
export function formatNodePlan(plan: NodePlan): string {
  const docker = plan.installDocker
    ? 'install'
    : plan.probed
      ? 'already installed'
      : 'not checked; must already be installed';
  return [
    'Node plan',
    `  name:     ${plan.name}`,
    `  ssh:      ${plan.ssh}`,
    `  docker:   ${docker}`,
    `  address:  ${plan.address ?? 'not set'}`,
    `  ingress:  ${plan.ingress ? 'enabled (Caddy on ports 80 and 443)' : 'no'}`,
    `  image:    ${plan.image}`,
  ].join('\n');
}
