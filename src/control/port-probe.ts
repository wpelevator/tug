import net from 'node:net';

/** What a TCP connect to a port returned. `open`: accepted. `timeout`: no answer. `refused`: actively rejected. `unreachable`: no route or host prohibited. */
export type PortState = 'open' | 'timeout' | 'refused' | 'unreachable';
export type PortProbe = (host: string, port: number, timeoutMs: number) => Promise<PortState>;

/**
 * Opens a TCP connection and closes it at once, sending nothing. A host firewall that drops packets shows as
 * `timeout`; one that rejects them shows as `refused` or `unreachable` (firewalld answers `host-prohibited`).
 */
export const probeTcpPort: PortProbe = (host, port, timeoutMs) =>
  new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (state: PortState) => {
      socket.destroy();
      resolve(state);
    };
    socket.setTimeout(timeoutMs, () => done('timeout'));
    socket.once('connect', () => done('open'));
    socket.once('error', (error: NodeJS.ErrnoException) =>
      done(error.code === 'ECONNREFUSED' ? 'refused' : 'unreachable'),
    );
  });

/** Ports the managed Caddy listens on, in the order they are reported. */
export const INGRESS_PORTS = [80, 443] as const;

const FIREWALL_REMEDY =
  'allow 80/tcp and 443/tcp on the host firewall (ufw: `ufw allow 80,443/tcp`; firewalld: `firewall-cmd --permanent --add-service=http --add-service=https && firewall-cmd --reload`) and in any provider firewall; tug never changes firewalls';

/** One sentence per closed port: which port, the likely cause and the remedy. */
export function describeClosedPort(
  node: string,
  address: string,
  port: number,
  state: Exclude<PortState, 'open'>,
): string {
  const where = `port ${port} on ingress node ${node} (${address})`;
  if (state === 'refused')
    return `${where} refused the connection: nothing listens there (the managed Caddy is not running; run tug ingress logs ${node}) or a host firewall rejects it; ${FIREWALL_REMEDY}`;
  if (state === 'unreachable')
    return `${where} is unreachable: a host firewall (firewalld rejects with host-prohibited) or a provider firewall is likely blocking it; ${FIREWALL_REMEDY}`;
  return `${where} did not answer: a host firewall (ufw drops packets by default) or a provider firewall is likely blocking it; ${FIREWALL_REMEDY}`;
}
