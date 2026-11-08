#!/usr/bin/env node
// Regenerates the committed x-tug.schema.json from src/x-tug-schema.ts. The schema is generated,
// never hand-edited in place: a test fails when the committed file no longer matches.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { xTugSchema } from '../../src/compose/x-tug-schema.ts';

const target = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'x-tug.schema.json',
);
await fs.writeFile(target, `${JSON.stringify(xTugSchema(), null, 2)}\n`);
console.log(`wrote ${path.relative(process.cwd(), target)}`);
