import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const now = () => new Date().toISOString();
export const id = (prefix) => `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
export const token = (prefix = 'lp') => `${prefix}_${crypto.randomBytes(24).toString('base64url')}`;
export const hashToken = (value) => crypto.createHash('sha256').update(value).digest('hex');
export async function ensureDir(dir) { await fs.mkdir(dir, { recursive: true }); }
export async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }
export function requireEnv(name, fallback) { const v = process.env[name] ?? fallback; if (!v) throw new Error(`Missing ${name}`); return v; }
export function projectRoot() { return process.cwd(); }
export function safeJoin(base, child) { const out = path.resolve(base, child); if (!out.startsWith(path.resolve(base))) throw new Error('unsafe path'); return out; }
export function renderTemplate(str, vars) { return str.replace(/\{\{(\w+)\}\}/g, (m, key) => { if (!(key in vars)) throw new Error(`missing template var ${key}`); return vars[key]; }); }
export async function loadTemplate(templatesDir, name, vars) { return renderTemplate(await fs.readFile(path.join(templatesDir, name), 'utf8'), vars); }
