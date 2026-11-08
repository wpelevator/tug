import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Guards the source layout documented in docs/architecture.md#source-layout: the three runtime roles (cli, control,
// agent) never import each other, everything else is a domain module any role may use, and runtime imports have no cycles.

const srcDir = path.dirname(fileURLToPath(import.meta.url));
const ROLES = ['cli', 'control', 'agent'] as const;
const FOLDERS = ['agent', 'backup', 'cli', 'compose', 'control', 'db', 'images', 'templates'];

interface Edge {
  from: string;
  to: string;
  typeOnly: boolean;
}

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'templates' ? [] : sourceFiles(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [full] : [];
  });
}

const relative = (file: string) => path.relative(srcDir, file).split(path.sep).join('/');

/** Every relative import in non-test source, static or dynamic, with whether it is `import type` only. */
function importEdges(): Edge[] {
  const edges: Edge[] = [];
  for (const file of sourceFiles(srcDir)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(
      /(?:import|export)\s+(type\s+)?(?:[^'";]*?\sfrom\s+)?'(\.{1,2}\/[^']+)'/g,
    )) {
      edges.push({
        from: relative(file),
        to: relative(path.resolve(path.dirname(file), m[2])),
        typeOnly: Boolean(m[1]),
      });
    }
    for (const m of text.matchAll(/import\(\s*'(\.{1,2}\/[^']+)'\s*\)/g)) {
      edges.push({
        from: relative(file),
        to: relative(path.resolve(path.dirname(file), m[1])),
        typeOnly: false,
      });
    }
  }
  return edges;
}

const roleOf = (file: string) => ROLES.find((role) => file.startsWith(`${role}/`));
const ENTRY_POINTS = ['cli.ts', 'main.ts'];

test('source folders are the documented ones, so no catch-all folder appears', () => {
  const folders = fs
    .readdirSync(srcDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(
    folders,
    FOLDERS,
    'src/ holds only the role and domain folders listed in docs/architecture.md',
  );
});

test('cli, control and agent never import one another, and domain modules import no role', () => {
  const violations = importEdges()
    .filter((edge) => {
      const target = roleOf(edge.to);
      if (!target || ENTRY_POINTS.includes(edge.from)) return false;
      return roleOf(edge.from) !== target;
    })
    .map((edge) => `${edge.from} -> ${edge.to}`);
  assert.deepEqual(
    violations,
    [],
    'a role may import domain modules and itself, never another role',
  );
});

test('cli.ts imports no control or agent code, and main.ts imports no CLI code', () => {
  const violations = importEdges()
    .filter((edge) => {
      const target = roleOf(edge.to);
      if (!target) return false;
      if (edge.from === 'cli.ts') return target !== 'cli';
      if (edge.from === 'main.ts') return target === 'cli';
      return false;
    })
    .map((edge) => `${edge.from} -> ${edge.to}`);
  assert.deepEqual(
    violations,
    [],
    'cli.ts is the operator entry and main.ts the control and agent entry',
  );
});

test('runtime imports contain no cycles (type-only imports are erased and ignored)', () => {
  const graph = new Map<string, string[]>();
  for (const edge of importEdges()) {
    if (edge.typeOnly) continue;
    graph.set(edge.from, [...(graph.get(edge.from) ?? []), edge.to]);
  }
  const state = new Map<string, 'visiting' | 'done'>();
  const cycles: string[] = [];
  const visit = (file: string, stack: string[]) => {
    if (state.get(file) === 'done') return;
    if (state.get(file) === 'visiting') {
      cycles.push([...stack.slice(stack.indexOf(file)), file].join(' -> '));
      return;
    }
    state.set(file, 'visiting');
    for (const next of graph.get(file) ?? []) visit(next, [...stack, file]);
    state.set(file, 'done');
  };
  for (const file of graph.keys()) visit(file, []);
  assert.deepEqual(cycles, [], 'no module imports itself through a chain of runtime imports');
});
