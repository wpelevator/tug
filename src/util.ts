import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isIP } from 'node:net';

export const now = () => new Date().toISOString();
export const id = (prefix: string) => `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
export const token = (prefix = 'tug') => `${prefix}_${crypto.randomBytes(24).toString('base64url')}`;
export const hashToken = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
export async function ensureDir(dir: string): Promise<void> { await fs.mkdir(dir, { recursive: true }); }
export async function exists(p: string): Promise<boolean> { try { await fs.access(p); return true; } catch { return false; } }
export function requireEnv(name: string, fallback?: string): string { const v = process.env[name] ?? fallback; if (!v) throw new Error(`Missing ${name}`); return v; }
export function projectRoot() { return process.cwd(); }
export function safeJoin(base: string, child: string): string { const out = path.resolve(base, child); if (!out.startsWith(path.resolve(base))) throw new Error('unsafe path'); return out; }
export function renderTemplate(str: string, vars: Record<string, string>): string { return str.replace(/\{\{(\w+)\}\}/g, (m, key) => { if (!(key in vars)) throw new Error(`missing template var ${key}`); return vars[key]; }); }
export async function loadTemplate(templatesDir: string, name: string, vars: Record<string, string>): Promise<string> { return renderTemplate(await fs.readFile(path.join(templatesDir, name), 'utf8'), vars); }
export const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Parses `500ms` / `2s` / `1m` or a millisecond number; `fallback` when it does not parse. */
export function parseDuration(value: string | number, fallback = 2000): number {
  if (typeof value === 'number') return value;
  const m = String(value).match(/^(\d+)(ms|s|m)?$/);
  if (!m) return fallback;
  const n = Number(m[1]);
  return m[2] === 'm' ? n * 60000 : m[2] === 'ms' ? n : n * 1000;
}
export const isDuration = (value: unknown): boolean => (typeof value === 'number' && Number.isFinite(value) && value >= 0) || (typeof value === 'string' && /^\d+(ms|s|m)?$/.test(value));

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
    return !(a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127));
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
