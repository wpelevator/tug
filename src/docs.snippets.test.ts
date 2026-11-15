import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findMissingValues } from './cli/values.ts';

// `tug deploy` takes every unescaped `$NAME` and `${NAME}` in a Compose file from control, and refuses the deploy when
// control lacks one. A documentation snippet that writes `-p"$MARIADB_ROOT_PASSWORD"` for the container shell therefore
// fails for the reader. This test runs the product's own check (`findMissingValues`, the call `tug deploy` makes) over
// every Compose snippet. A snippet declares the names control provides with a comment before its fence:
//
//   <!-- tug-values: DB_PASSWORD, DB_ROOT_PASSWORD -->
//
// For a file under examples/, the names its README lists in backticks are the ones the reader sets on control.

const root = new URL('..', import.meta.url).pathname;

interface Snippet {
  where: string;
  source: string;
  declared: string[];
}

const DECLARATION = /^<!--\s*tug-values:\s*([^>]*?)\s*-->$/;

/** The Compose snippets of one Markdown file: `yaml` fences with a top-level `services` or `x-tug` key. */
export function composeSnippets(file: string, markdown: string): Snippet[] {
  const lines = markdown.split('\n');
  const snippets: Snippet[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^```ya?ml\s*$/.test(lines[i])) continue;
    const end = lines.indexOf('```', i + 1);
    const source = lines.slice(i + 1, end).join('\n');
    // The declaration sits on the line before the fence, or the one before a single blank line.
    const before = [lines[i - 1], lines[i - 2]].map((line) => DECLARATION.exec(line?.trim() ?? ''));
    const found = before.find(Boolean);
    if (/^(?:services|x-tug):/m.test(source))
      snippets.push({
        where: `${file}:${i + 1}`,
        source,
        declared: found ? found[1].split(/[\s,]+/).filter(Boolean) : [],
      });
    i = end;
  }
  return snippets;
}

/** What `tug deploy` would reject in a snippet: names it needs from control that the snippet does not declare. */
export async function undeclaredValues(snippet: Snippet): Promise<string[]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tug-snippet-'));
  try {
    const file = path.join(dir, 'compose.yaml');
    fs.writeFileSync(file, snippet.source);
    return await findMissingValues(file, new Set(snippet.declared));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function unusedDeclarations(snippet: Snippet): Promise<string[]> {
  const missingWithNothing = await undeclaredValues({ ...snippet, declared: [] });
  return snippet.declared.filter((name) => !missingWithNothing.includes(name));
}

test('a single-dollar reference meant for the container shell is reported as a value control must provide', async () => {
  const [snippet] = composeSnippets(
    'sample.md',
    [
      '```yaml',
      'services:',
      '  db:',
      '    x-tug:',
      '      backup:',
      '        restore: mariadb -uroot -p"$MARIADB_ROOT_PASSWORD"',
      '```',
    ].join('\n'),
  );
  assert.deepEqual(
    await undeclaredValues(snippet),
    ['MARIADB_ROOT_PASSWORD'],
    'a single $ in a snippet should be flagged, since tug deploy would demand it from control',
  );
});

test('an escaped dollar, a default, a comment and a declared control value pass', async () => {
  const snippets = composeSnippets(
    'sample.md',
    [
      '<!-- tug-values: DB_PASSWORD -->',
      '```yaml',
      'services:',
      '  db:',
      '    environment:',
      '      MARIADB_PASSWORD: ${DB_PASSWORD}',
      '      TZ: ${TZ:-UTC}',
      '    # restore with -p"$MARIADB_ROOT_PASSWORD"',
      '    x-tug:',
      '      backup:',
      '        restore: mariadb -uroot -p"$$MARIADB_ROOT_PASSWORD"',
      '```',
    ].join('\n'),
  );
  assert.equal(snippets.length, 1, 'the Compose snippet should be found');
  assert.deepEqual(
    snippets[0].declared,
    ['DB_PASSWORD'],
    'the declaration before the fence should be read',
  );
  assert.deepEqual(
    await undeclaredValues(snippets[0]),
    [],
    '$$, ${NAME:-default}, comments and declared names should not be flagged',
  );
});

test('an undeclared ${NAME} is flagged and a declaration of a name the snippet does not use is stale', async () => {
  const [snippet] = composeSnippets(
    'sample.md',
    [
      '<!-- tug-values: OTHER -->',
      '',
      '```yaml',
      'services:',
      '  web:',
      '    environment:',
      '      KEY: ${APP_KEY}',
      '```',
    ].join('\n'),
  );
  assert.deepEqual(
    await undeclaredValues(snippet),
    ['APP_KEY'],
    'a reference that no declaration covers should be flagged',
  );
  assert.deepEqual(
    await unusedDeclarations(snippet),
    ['OTHER'],
    'a declared name that the snippet never requires should be reported as stale',
  );
});

test('yaml fences that are not Compose files are not checked', () => {
  const snippets = composeSnippets(
    'sample.md',
    [
      '```yaml',
      'groups:',
      '  - name: x',
      '    annotations: { summary: "$labels.node" }',
      '```',
    ].join('\n'),
  );
  assert.equal(snippets.length, 0, 'a Prometheus rule file should not be treated as Compose');
});

test('every Compose snippet in README.md and docs takes only declared values from control', async () => {
  const files = ['README.md', ...fs.readdirSync(path.join(root, 'docs')).map((f) => `docs/${f}`)]
    .filter((f) => f.endsWith('.md'))
    .sort();
  let checked = 0;
  const problems: string[] = [];
  for (const file of files) {
    const markdown = fs.readFileSync(path.join(root, file), 'utf8');
    for (const snippet of composeSnippets(file, markdown)) {
      checked++;
      const missing = await undeclaredValues(snippet);
      if (missing.length)
        problems.push(
          `${snippet.where} needs ${missing.join(', ')} from control: write $$ where the container shell should expand it, or declare the name with <!-- tug-values: NAME --> above the fence`,
        );
      const stale = await unusedDeclarations(snippet);
      if (stale.length)
        problems.push(`${snippet.where} declares ${stale.join(', ')} but does not reference it`);
    }
  }
  assert.ok(checked > 10, 'the documentation should contain Compose snippets to check');
  assert.deepEqual(
    problems,
    [],
    'documentation snippets should deploy without unset control values',
  );
});

test('every example Compose file takes only values its README tells the reader to set', async () => {
  const examples = path.join(root, 'examples');
  const problems: string[] = [];
  let checked = 0;
  for (const dir of fs.readdirSync(examples, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const compose = path.join(examples, dir.name, 'docker-compose.yml');
    if (!fs.existsSync(compose)) continue;
    checked++;
    const readme = fs.readFileSync(path.join(examples, dir.name, 'README.md'), 'utf8');
    const listed = new Set(
      [...readme.matchAll(/`([A-Z][A-Z0-9_]*)`|tug (?:secret|var) set ([A-Z][A-Z0-9_]*)/g)].map(
        (match) => match[1] ?? match[2],
      ),
    );
    const missing = await findMissingValues(compose, listed);
    if (missing.length)
      problems.push(
        `examples/${dir.name} needs ${missing.join(', ')} from control but its README does not list them: use $$ for container-shell variables or add the name to the README`,
      );
  }
  assert.ok(checked >= 4, 'the examples directory should hold Compose files to check');
  assert.deepEqual(problems, [], 'example files should deploy once the README steps are done');
});
