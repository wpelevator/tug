import { isIP } from 'node:net';
import { sshHost } from './cli-install.ts';

const NODE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

/**
 * A node name from an SSH target's host: the first DNS label (`app1` for `root@app1.example.com`). An IP address
 * says nothing about the machine, so it yields no name and the operator has to choose one.
 */
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
export function parseAddressCandidates(output: string): AddressCandidate[] {
  const candidates: AddressCandidate[] = [];
  for (const line of output.split('\n')) {
    const match = /^\d+:\s+(\S+)\s+inet\s+(\d{1,3}(?:\.\d{1,3}){3})\//.exec(line.trim());
    if (!match || isIP(match[2]) !== 4) continue;
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
