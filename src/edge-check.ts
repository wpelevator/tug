// Edge checks: before a rolling revision takes traffic, the ingress nodes that route to it dial it the way Caddy will.
// The app node's own health check dials the container IP, which says nothing about the path from the edge (a firewall
// between the nodes, a port bound to the wrong address). Control holds the app agent's request while the ingress
// agents answer, so the gate needs no extra rollout state on the app node.
import net from 'node:net';
import type { EdgeCheckResponse, EdgeProbe, EdgeProbeResult } from './protocol.ts';

export const EDGE_PROBE_TIMEOUT_MS = 3000;

/** Dials `host:port` once and reports why it failed, in words an operator can act on. */
export function probeUpstream(
  host: string,
  port: number,
  timeoutMs = EDGE_PROBE_TIMEOUT_MS,
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (result: { ok: boolean; error?: string }) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () =>
      done({ ok: false, error: `no answer from ${host}:${port} within ${timeoutMs}ms` }),
    );
    socket.once('connect', () => done({ ok: true }));
    socket.once('error', (e: NodeJS.ErrnoException) =>
      done({ ok: false, error: `${e.code ?? 'error'} dialing ${host}:${port}` }),
    );
  });
}

/** What an ingress agent does with `work.ingress.probes`: dial every upstream, keep going past failures. */
export async function runProbes(
  probes: EdgeProbe[],
  dial: typeof probeUpstream = probeUpstream,
): Promise<EdgeProbeResult[]> {
  return Promise.all(
    probes.map(async (probe) => ({ id: probe.id, ...(await dial(probe.host, probe.port)) })),
  );
}

interface PendingCheck {
  targets: Map<string, EdgeProbe>;
  results: Map<string, EdgeProbeResult>;
  settle: () => void;
}

/** Control's in-memory list of checks in flight. A restart drops them, and the waiting agent's request fails with it. */
export class EdgeChecks {
  private readonly pending = new Set<PendingCheck>();
  private seq = 0;

  /** Probes an ingress node still has to answer. */
  pendingFor(node: string): EdgeProbe[] {
    const out: EdgeProbe[] = [];
    for (const check of this.pending) {
      const probe = check.targets.get(node);
      if (probe && !check.results.has(node)) out.push(probe);
    }
    return out;
  }

  /** Records what an ingress node reported. Answers for unknown or finished probes are ignored. */
  onResults(node: string, results: EdgeProbeResult[]): void {
    for (const result of results)
      for (const check of this.pending) {
        if (check.targets.get(node)?.id !== result.id || check.results.has(node)) continue;
        check.results.set(node, result);
        if (check.results.size === check.targets.size) check.settle();
      }
  }

  /**
   * Dials from each of `hosts` (ingress node name to the address it dials) and waits for every answer, at most
   * `timeoutMs`. `wake` is called for each node so its agent fetches the probe now instead of at its next poll.
   * With no nodes there is nothing to ask and the check passes.
   */
  async run(
    hosts: Map<string, string>,
    port: number,
    timeoutMs: number,
    wake: (node: string) => void,
  ): Promise<EdgeCheckResponse> {
    const response: EdgeCheckResponse = { ok: true, reached: [], failed: [], unchecked: [] };
    if (!hosts.size) return response;
    const id = `edge-${Date.now().toString(36)}-${++this.seq}`;
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => (settle = resolve));
    const check: PendingCheck = {
      targets: new Map([...hosts].map(([node, host]) => [node, { id, host, port }])),
      results: new Map(),
      settle,
    };
    this.pending.add(check);
    for (const node of hosts.keys()) wake(node);
    const timer = setTimeout(settle, timeoutMs);
    try {
      await settled;
    } finally {
      clearTimeout(timer);
      this.pending.delete(check);
    }
    for (const node of hosts.keys()) {
      const result = check.results.get(node);
      if (!result) response.unchecked.push(node);
      else if (result.ok) response.reached.push(node);
      else response.failed.push({ node, error: result.error ?? 'could not connect' });
    }
    response.ok = response.failed.length === 0;
    return response;
  }
}
