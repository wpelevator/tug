import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

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
