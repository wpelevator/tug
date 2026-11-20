import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { directoryProject } from '../compose/load.ts';

/** Where the project name came from, in the order {@link resolveProject} tries them. */
export type ProjectSource = 'flag' | 'env' | 'config' | 'compose-name' | 'directory';

/** The Compose file names Compose itself looks for, in its order of preference. */
export const COMPOSE_FILE_NAMES = [
  'compose.yaml',
  'compose.yml',
  'docker-compose.yaml',
  'docker-compose.yml',
];

/** The first conventional Compose file name in `cwd`; `docker-compose.yml` when none exists. */
export function defaultComposeFileName(cwd: string): string {
  return (
    COMPOSE_FILE_NAMES.find((name) => existsSync(path.join(cwd, name))) ?? 'docker-compose.yml'
  );
}

/** The top-level `name:` of a Compose file, which Compose would use as the project name; undefined when the file or key is missing. */
export function composeNameSync(file: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  return /^name:\s*["']?([A-Za-z0-9][\w.-]*)["']?\s*(?:#.*)?$/m.exec(text)?.[1];
}

export interface ProjectInputs {
  /** `--project`. */
  flag?: string;
  /** `TUG_PROJECT`. */
  env?: string;
  /** `project:` of `tug.yml` (or its overlay). */
  config?: string;
  /** The Compose file the project would be deployed from, absolute or relative to `cwd`. */
  file?: string;
  cwd: string;
}

/**
 * The one place that decides which project a command works on: `--project`, `TUG_PROJECT`, `project:` in `tug.yml`, the
 * Compose file's `name:`, then the name of the directory that holds the Compose file (the working directory when
 * there is no file). The last two are what Compose would call the project, so an existing stack keeps its name.
 */
export function resolveProject(inputs: ProjectInputs): { project: string; source: ProjectSource } {
  if (inputs.flag) return { project: inputs.flag, source: 'flag' };
  if (inputs.env) return { project: inputs.env, source: 'env' };
  if (inputs.config) return { project: inputs.config, source: 'config' };
  const file = path.resolve(inputs.cwd, inputs.file ?? defaultComposeFileName(inputs.cwd));
  const declared = composeNameSync(file);
  if (declared) return { project: declared, source: 'compose-name' };
  const project = directoryProject(path.dirname(file));
  if (!project)
    throw new Error(
      `cannot derive a project name from the directory ${path.dirname(file)}: set project: in tug.yml, TUG_PROJECT or pass --project`,
    );
  return { project, source: 'directory' };
}
