// Injectable seams for the agent's side effects so rollout/health/secret logic can be unit-tested
// without a real Docker daemon or control plane.
import { run } from './build.ts';
import type { RunResult } from './build.ts';

export type DockerRunner = (args: string[], opts?: { cwd?: string }) => Promise<RunResult>;
export type HttpClient = typeof fetch;

/** Default runner: `docker <args>` via the shared `run()` helper. */
export function createDockerRunner(): DockerRunner {
  return (args, opts) => run('docker', args, opts);
}

/** Runs a host binary (`wg`, `ip`); rejects on a non-zero exit like the docker runner. */
export type HostRunner = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string },
) => Promise<RunResult>;

export function createHostRunner(): HostRunner {
  return (cmd, args, opts) => run(cmd, args, opts);
}
