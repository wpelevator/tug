import { db } from './db.js';
await db.query(
  'CREATE TABLE IF NOT EXISTS files (id uuid PRIMARY KEY, name text NOT NULL, object_key text NOT NULL)',
);
await db.end();
