// Checks relative Markdown links and anchors in README.md and docs/**.
// Usage: node tools/scripts/check-doc-links.mjs
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';

const root = resolve(import.meta.dirname, '../..');

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return path.endsWith('.md') ? [path] : [];
  });
}

function slug(heading) {
  return heading
    .replace(/`/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/ /g, '-');
}

function anchors(file) {
  const text = readFileSync(file, 'utf8').replace(/^```[\s\S]*?^```/gm, '');
  const seen = new Map();
  return new Set(
    [...text.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => {
      const base = slug(m[1].replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'));
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      return n === 0 ? base : `${base}-${n}`;
    }),
  );
}

const files = [
  join(root, 'README.md'),
  ...walk(join(root, 'docs')),
  join(root, 'examples/README.md'),
].filter(existsSync);
const problems = [];
for (const file of files) {
  const text = readFileSync(file, 'utf8').replace(/^```[\s\S]*?^```/gm, '');
  for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const href = m[1];
    if (/^[a-z]+:/i.test(href)) continue;
    const [pathPart, hash] = href.split('#');
    const target = pathPart ? resolve(dirname(file), pathPart) : file;
    const where = `${relative(root, file)}: ${href}`;
    if (!existsSync(target)) problems.push(`${where} (missing file)`);
    else if (hash && target.endsWith('.md') && !anchors(target).has(hash)) {
      problems.push(`${where} (missing anchor)`);
    }
  }
}
if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`Checked ${files.length} files: all relative links and anchors resolve.`);
