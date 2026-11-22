# Design records

These pages record why tug is built the way it is and what is planned. They are for contributors and evaluators. Operators find how-to guidance in the [documentation index](index.md). Each page opens with its status.

| Page | Status | What it holds |
| --- | --- | --- |
| [Roadmap](roadmap.md) | Living | Goals, principles, topology and milestones |
| [Security audit](security-audit.md) | Record | The 10 November 2026 audit, its fixes and trust boundaries |
| [Real-host evaluation](real-host-evaluation.md) | Record | An operator trial on real hosts and the friction it found |
| [Ingress design](ingress-design.md) | Partly built | How the managed ingress compares with peers, and the planned per-route options |
| [Private control network](private-control-network.md) | Proposed | Keeping control's mutual TLS port on a tailnet: the operator setup end to end, what tug does and what the operator owns, and the proposed `--bind`, boot-order, enrollment and doctor changes |
| [Observability](observability.md) | Mostly proposed | What exists today and the planned metrics, logs and alerts |
| [Capabilities](capabilities.md) | Proposed | Delegated, attenuated authority beyond the three roles |
| [Consoles and agent-built control planes](consoles.md) | Proposed | A controller API and MCP server for prompt-built dashboards |
| [File-mounted workload secrets](workload-secrets.md) | Proposed | Mounting secrets as files instead of environment variables |
| [Podman and other container engines](container-engines.md) | Proposed | Supporting engines other than Docker |
| [Standalone binary](standalone-binary.md) | Prototyped | A compiled client without Node.js |
| [tug compared with Docker Swarm](swarm-comparison.md) | Record | A dated source assessment of overlap and gaps, with evidence |
| [Terminal UI design](tui-design.md) | Phases 1 to 3 built | User flows, screen design, architecture and the remaining phases of `tug tui` |
| [Test suite performance](test-performance.md) | Record | Where the 2 minute 49 second `npm test` run went and what cut it to about 77 seconds |
| [Terminology review](terminology-review.md) | Record | The 1 November 2026 naming review behind the vocabulary |
