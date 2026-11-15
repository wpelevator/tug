import fs from 'node:fs/promises';
import os from 'node:os';
import type { ContainerStats, DockerApi } from './docker-api.ts';

/** What `tug doctor` shows for host resources; every field is absent when it cannot be read on this platform. */
export interface HostResources {
  load?: { one: number; five: number; fifteen: number; cpus: number };
  memory?: { totalBytes: number; availableBytes: number };
  /** Free space on the filesystem of `path`; for an agent that is the state volume, which Docker keeps under its data root. */
  disk?: { path: string; freeBytes: number; totalBytes: number; dockerRoot?: string };
  containers: ContainerResources[];
}

export interface ContainerResources {
  name: string;
  /** Percent of one CPU, so 100 is one fully used core. */
  cpuPercent?: number;
  memoryBytes?: number;
  error?: string;
}

/** `/proc/loadavg`: the three load averages. The CPU count is the host's, since `/proc` is not namespaced. */
export function parseLoadavg(text: string, cpus: number): HostResources['load'] {
  const [one, five, fifteen] = text.trim().split(/\s+/).slice(0, 3).map(Number);
  if (![one, five, fifteen].every(Number.isFinite)) return undefined;
  return { one, five, fifteen, cpus };
}

/** `/proc/meminfo`: total and available memory in bytes (`MemAvailable` counts reclaimable cache as available). */
export function parseMeminfo(text: string): HostResources['memory'] {
  const kib = (key: string) => {
    const match = text.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, 'm'));
    return match ? Number(match[1]) * 1024 : undefined;
  };
  const totalBytes = kib('MemTotal');
  const availableBytes = kib('MemAvailable');
  return totalBytes === undefined || availableBytes === undefined
    ? undefined
    : { totalBytes, availableBytes };
}

/** CPU and memory the way `docker stats` computes them: cache is not counted as used memory. */
export function containerUsage(name: string, stats: ContainerStats): ContainerResources {
  const cpu = stats.cpu_stats;
  const pre = stats.precpu_stats;
  const cpuDelta = (cpu?.cpu_usage?.total_usage ?? 0) - (pre?.cpu_usage?.total_usage ?? 0);
  const systemDelta = (cpu?.system_cpu_usage ?? 0) - (pre?.system_cpu_usage ?? 0);
  const memory = stats.memory_stats;
  const cache = memory?.stats?.inactive_file ?? memory?.stats?.total_inactive_file ?? 0;
  return {
    name,
    ...(cpuDelta >= 0 &&
      systemDelta > 0 && {
        cpuPercent:
          Math.round(
            (cpuDelta / systemDelta) * (cpu?.online_cpus || os.cpus().length || 1) * 1000,
          ) / 10,
      }),
    ...(memory?.usage !== undefined && { memoryBytes: Math.max(0, memory.usage - cache) }),
  };
}

async function readText(file: string): Promise<string | undefined> {
  return fs.readFile(file, 'utf8').catch(() => undefined);
}

/**
 * Reads load, memory, disk and the named containers' usage. It only reads, never throws and never marks anything
 * as failed: a value that cannot be read is left out. `containers` are names or IDs; one that is not running is
 * reported with an error so a stopped agent or Caddy is visible.
 */
export async function collectResources(
  docker: Pick<DockerApi, 'stats' | 'info'>,
  options: { diskPath: string; containers: { id: string; label: string }[]; proc?: string },
): Promise<HostResources> {
  const proc = options.proc ?? '/proc';
  const [loadText, memText, statfs, info] = await Promise.all([
    readText(`${proc}/loadavg`),
    readText(`${proc}/meminfo`),
    fs.statfs(options.diskPath).catch(() => undefined),
    docker.info().catch(() => undefined),
  ]);
  const containers = await Promise.all(
    options.containers.map(async ({ id, label }): Promise<ContainerResources> => {
      try {
        return containerUsage(label, await docker.stats(id));
      } catch (error) {
        return { name: label, error: error instanceof Error ? error.message : String(error) };
      }
    }),
  );
  const load = loadText ? parseLoadavg(loadText, os.cpus().length) : undefined;
  const memory = memText ? parseMeminfo(memText) : undefined;
  return {
    ...(load && { load }),
    ...(memory && { memory }),
    ...(statfs && {
      disk: {
        path: options.diskPath,
        freeBytes: statfs.bavail * statfs.bsize,
        totalBytes: statfs.blocks * statfs.bsize,
        ...(typeof info?.DockerRootDir === 'string' && { dockerRoot: info.DockerRootDir }),
      },
    }),
    containers,
  };
}

/**
 * The container this process runs in, named by its hostname (Docker sets it to the container ID), or `fallback`
 * by name when the process runs outside a container. Undefined when neither exists.
 */
export async function ownContainer(
  docker: Pick<DockerApi, 'inspectContainer'>,
  fallback: string,
): Promise<string | undefined> {
  for (const id of [os.hostname(), fallback]) {
    try {
      return (await docker.inspectContainer(id)).Name.replace(/^\//, '') || id;
    } catch {
      /* try the next name */
    }
  }
  return undefined;
}
