import { isIP } from 'node:net';

const HOST_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;

/** An IP literal or DNS hostname with no port, brackets, whitespace or other syntax that could reach generated configuration. */
export const isNodeHost = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= 253 &&
  (isIP(value) !== 0 || value.split('.').every((label) => HOST_LABEL.test(label)));
