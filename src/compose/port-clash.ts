// Host-port clashes between projects on one node. Two projects that publish the same host port on the same address of
// one node cannot both run: the second container fails to start with `port is already allocated`. Control finds the
// clash while it prepares a deployment, before any build, from the published ports of every other project's current
// deployment.
import { entryPublishedPort, hasHostIp, isRolling, loopbackIngressServices } from './compose.ts';
import type { ComposeService, DesiredState } from '../protocol.ts';

type PortEntry = NonNullable<ComposeService['ports']>[number];

/** One host port a service publishes on a node: where it listens, the port and the protocol. */
export interface HostPortUse {
  service: string;
  /** The listen address as it is written, or `*` for every address (`0.0.0.0`, `::`). */
  address: string;
  port: number;
  protocol: string;
}

/** Another project already holds the host port on the node. */
export interface PortClash {
  node: string;
  address: string;
  port: number;
  protocol: string;
  /** The service of the deployment being prepared. */
  service: string;
  otherProject: string;
  otherService: string;
}

const WILDCARD = '*';

function normalizeAddress(address: string): string {
  const bare = address.replace(/^\[|\]$/g, '').toLowerCase();
  return bare === '0.0.0.0' || bare === '::' || bare === '' ? WILDCARD : bare;
}

/** The host ports one `ports` entry publishes, or none for a container-only entry that Docker numbers itself. */
function entryHostPorts(
  entry: PortEntry,
): { ip?: string; ports: number[]; protocol: string } | null {
  if (typeof entry === 'number') return null;
  let ip: string | undefined;
  let host: string | undefined;
  let protocol: string;
  if (typeof entry === 'object') {
    ip = entry.host_ip ? String(entry.host_ip) : undefined;
    host = entry.published === undefined ? undefined : String(entry.published);
    protocol = entry.protocol ? String(entry.protocol) : 'tcp';
  } else {
    const [spec, proto] = String(entry).split('/');
    protocol = proto || 'tcp';
    let rest = spec;
    const bracket = /^\[([^\]]*)\]:(.*)$/.exec(spec);
    if (bracket) {
      ip = bracket[1];
      rest = bracket[2];
    }
    const parts = rest.split(':');
    if (!bracket && parts.length === 3) ip = parts[0];
    host = parts.length >= 2 ? parts[parts.length - 2] : undefined;
  }
  if (!host) return null;
  const [low, high = low] = host.split('-').map(Number);
  if (
    !Number.isInteger(low) ||
    !Number.isInteger(high) ||
    low < 1 ||
    high < low ||
    high - low > 4096
  )
    return null;
  const ports: number[] = [];
  for (let port = low; port <= high; port++) ports.push(port);
  return { ip, ports, protocol };
}

/**
 * The host ports `service` publishes on a node whose published ports listen on `nodeAddress` (`null`: loopback,
 * as the agent does for a node without an address). An entry that names a host IP keeps it. `loopbackIngress` puts
 * the ingress port on `127.0.0.1`, as the agent does when only the managed Caddy dials it. A rolling service
 * publishes no declared host port: the agent gives each revision a port of its own range.
 */
export function hostPortUses(
  name: string,
  service: ComposeService,
  nodeAddress: string | null,
  loopbackIngress: boolean,
): HostPortUse[] {
  if (isRolling(service)) return [];
  const ingressPort = loopbackIngress ? service['x-tug']?.ingress?.port : undefined;
  const uses: HostPortUse[] = [];
  for (const entry of service.ports || []) {
    const parsed = entryHostPorts(entry);
    if (!parsed) continue;
    const address = hasHostIp(entry)
      ? parsed.ip
      : ingressPort !== undefined && entryPublishedPort(entry, ingressPort) != null
        ? '127.0.0.1'
        : (nodeAddress ?? '127.0.0.1');
    for (const port of parsed.ports)
      uses.push({
        service: name,
        address: normalizeAddress(address ?? ''),
        port,
        protocol: parsed.protocol,
      });
  }
  return uses;
}

/** The host ports of every service of `state` placed on `node`. */
export function nodeHostPorts(
  state: DesiredState,
  node: string,
  topology: { nodes: readonly string[]; ingressNodes: readonly string[] },
  nodeAddress: string | null,
): HostPortUse[] {
  const loopback = new Set(
    loopbackIngressServices(state, node, topology.ingressNodes, topology.nodes),
  );
  const uses: HostPortUse[] = [];
  for (const [name, spec] of Object.entries(state.services)) {
    const placed = spec.placement?.nodes || [];
    if (placed.length ? !placed.includes(node) : false) continue;
    const service = state.compose.services?.[name];
    if (service) uses.push(...hostPortUses(name, service, nodeAddress, loopback.has(name)));
  }
  return uses;
}

/** Two listen addresses collide when they are equal or either one listens on every address. */
const overlaps = (a: string, b: string): boolean => a === b || a === WILDCARD || b === WILDCARD;

/**
 * Host ports `candidate` publishes that another project's state in `others` already publishes on the same node and
 * an overlapping address. States of `candidate`'s own project are skipped: a redeploy replaces them.
 */
export function findPortClashes(
  candidate: DesiredState,
  others: readonly DesiredState[],
  topology: { nodes: readonly string[]; ingressNodes: readonly string[] },
  addressOf: (node: string) => string | null,
): PortClash[] {
  const clashes: PortClash[] = [];
  for (const node of topology.nodes) {
    const address = addressOf(node);
    const mine = nodeHostPorts(candidate, node, topology, address);
    if (!mine.length) continue;
    for (const other of others) {
      if (other.project === candidate.project) continue;
      for (const theirs of nodeHostPorts(other, node, topology, address))
        for (const use of mine)
          if (
            use.port === theirs.port &&
            use.protocol === theirs.protocol &&
            overlaps(use.address, theirs.address)
          )
            clashes.push({
              node,
              address: use.address === WILDCARD ? theirs.address : use.address,
              port: use.port,
              protocol: use.protocol,
              service: use.service,
              otherProject: other.project,
              otherService: theirs.service,
            });
    }
  }
  return clashes;
}

/** The refusal message for a clash; `otherProject` is `another project` when the actor may not see its name. */
export function portClashMessage(clash: PortClash, otherProject: string): string {
  const address = clash.address === WILDCARD ? 'every address' : clash.address;
  const proto = clash.protocol === 'tcp' ? '' : `/${clash.protocol}`;
  return `${clash.service}: host port ${clash.port}${proto} on node ${clash.node} (${address}) is already published by ${otherProject === 'another project' ? otherProject : `${clash.otherService} in project ${otherProject}`}; publish a different host port or place one of them on another node`;
}
