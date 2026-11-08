import { isIP } from 'node:net';

const HOST_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;

/** An IP literal or DNS hostname with no port, brackets, whitespace or other syntax that could reach generated configuration. */
export const isNodeHost = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= 253 &&
  (isIP(value) !== 0 || value.split('.').every((label) => HOST_LABEL.test(label)));

/** A TCP port: an integer in 1..65535, never a string, so it cannot carry configuration syntax. */
export function isPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;
}

/**
 * True for an IP address that is routable on the internet: anything outside loopback, private
 * (RFC 1918, IPv6 ULA), link-local, CGNAT (`100.64.0.0/10`) and the unspecified address. The
 * unspecified addresses `0.0.0.0` and `::` count as public, since listening there means every
 * interface. Hostnames and other non-IP strings return false.
 */
export function isPublicAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, '');
  const kind = isIP(ip);
  if (kind === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (ip === '0.0.0.0') return true;
    return !(
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (kind === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::') return true;
    if (lower === '::1') return false;
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicAddress(mapped[1]);
    const first = Number.parseInt(lower.split(':')[0] || '0', 16);
    return !((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80);
  }
  return false;
}
