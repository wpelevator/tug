// Injectable seams for the agent's side effects so rollout/health/secret logic can be unit-tested
// without a real Docker daemon or control plane. Docker itself is the `DockerApi` in `docker-api.ts`.
import { run } from './build.ts';
import type { RunResult } from './build.ts';

export type HttpClient = typeof fetch;

/** Runs a host binary (`wg`, `ip`); rejects on a non-zero exit. */
export type HostRunner = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string },
) => Promise<RunResult>;

export function createHostRunner(): HostRunner {
  return (cmd, args, opts) => run(cmd, args, opts);
}
