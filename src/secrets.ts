import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { ensureDir, exists } from './util.ts';
import path from 'node:path';

export async function loadOrCreateMasterKey(file: string): Promise<string> {
  await ensureDir(path.dirname(file));
  if (await exists(file)) return (await fs.readFile(file, 'utf8')).trim();
  const key = crypto.randomBytes(32).toString('base64');
  await fs.writeFile(file, key, { mode: 0o600 });
  return key;
}

function keyBytes(key: string) {
  return crypto.createHash('sha256').update(key).digest();
}
export function encrypt(value: unknown, masterKey: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBytes(masterKey), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}
export function decrypt(payload: string, masterKey: string): string {
  const buf = Buffer.from(payload, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBytes(masterKey), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
