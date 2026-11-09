import type { DockerApi } from '../docker-api.ts';
import { LABEL_PROJECT, LABEL_SERVICE } from '../container-spec.ts';

/** Exit codes of a container someone stopped on purpose (SIGKILL, SIGTERM); the agent does not call that a crash. */
const STOPPED_ON_PURPOSE = new Set([0, 137, 143]);

/**
 * The services of a project whose container Docker keeps restarting, or that stopped with an error and stays down.
 * A reconcile pass proves a service started once; this is what tells an operator it did not stay up. Rolling services
 * only count while restarting, because their older revisions are stopped on purpose during a rollout.
 */
export async function unstableServices(
  docker: DockerApi,
  project: string,
  services: string[],
  rolling: ReadonlySet<string> = new Set(),
): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  for (const service of services) {
    const containers = await docker.listContainers(
      { label: [`${LABEL_PROJECT}=${project}`, `${LABEL_SERVICE}=${service}`] },
      true,
    );
    for (const container of containers) {
      const restarting = container.State === 'restarting';
      const exited = container.State === 'exited' && !rolling.has(service);
      if (!restarting && !exited) continue;
      const code = (await docker.inspectContainer(container.Id)).State?.ExitCode;
      if (exited && (code === undefined || STOPPED_ON_PURPOSE.has(code))) continue;
      found[service] =
        `${restarting ? 'restarting after exiting' : 'exited'} with code ${code ?? 'unknown'}`;
      break;
    }
  }
  return found;
}
