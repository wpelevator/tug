// Builds the standalone `tug` executable with `bun build --compile` (Bun is a build-time tool, not a dependency).
// Usage: node tools/scripts/build-binary.js [target ...]   e.g. bun-darwin-arm64 bun-linux-x64 (default: host)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = path.join(root, 'dist-bin');
fs.mkdirSync(out, { recursive: true });
const bun = process.env.BUN || 'bun';

// The release is built with one pinned Bun: it supplies its own fetch, ws and undici, so TLS and WebSocket behavior
// follows its version. Bump this deliberately and re-run the binary smoke test.
export const BUN_VERSION = '1.4.4';
const found = spawnSync(bun, ['--version'], { encoding: 'utf8' });
if (found.error || found.stdout.trim() !== BUN_VERSION) {
  console.error(
    `build-binary: need Bun ${BUN_VERSION}, found ${found.stdout?.trim() || 'none'} (set BUN=/path/to/bun)`,
  );
  process.exit(1);
}
const targets = process.argv.slice(2);
for (const target of targets.length ? targets : [undefined]) {
  const name = target ? `tug-${target.replace(/^bun-/, '')}` : 'tug';
  // A compiled Bun executable loads bunfig.toml, .env, tsconfig.json and package.json from the working directory
  // by default: a bunfig `preload` runs code and a .env can repoint the control URL. A CLI run inside any checkout
  // must do neither, so every autoload is off.
  const args = [
    'build',
    '--compile',
    '--no-compile-autoload-bunfig',
    '--no-compile-autoload-dotenv',
    '--no-compile-autoload-tsconfig',
    '--no-compile-autoload-package-json',
    'tools/binary/entry.ts',
    '--outfile',
    path.join(out, name),
  ];
  if (target) args.push(`--target=${target}`);
  const r = spawnSync(bun, args, { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
