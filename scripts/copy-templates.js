// tsc only emits TypeScript; copy the data templates next to the emitted dist/cli.js
// so `templatesDir` (resolved relative to the running file) works in the built image.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
fs.cpSync(path.join(root, 'src', 'templates'), path.join(root, 'dist', 'templates'), { recursive: true });
console.log('copied src/templates -> dist/templates');
