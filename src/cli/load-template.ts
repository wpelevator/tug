import fs from 'node:fs/promises';
import path from 'node:path';

function renderTemplate(str: string, vars: Record<string, string>): string {
  return str.replace(/\{\{(\w+)\}\}/g, (m, key) => {
    if (!(key in vars)) throw new Error(`missing template var ${key}`);
    return vars[key];
  });
}
export async function loadTemplate(
  templatesDir: string,
  name: string,
  vars: Record<string, string>,
): Promise<string> {
  return renderTemplate(await fs.readFile(path.join(templatesDir, name), 'utf8'), vars);
}
