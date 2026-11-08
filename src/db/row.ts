import crypto from 'node:crypto';

export const now = () => new Date().toISOString();
export const id = (prefix: string) => `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
