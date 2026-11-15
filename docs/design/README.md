# Design records

These pages record why Tug is built the way it is and what is planned. They are for contributors and evaluators. Operators find how-to guidance in the [documentation index](../index.md). Each page opens with its status.

| Page | Status | What it holds |
| --- | --- | --- |
| [Roadmap](roadmap.md) | Living | Goals, principles, topology and milestones |
| [Security audit](security.md) | Record | The 10 November 2026 audit, its fixes and trust boundaries |
| [Real-host evaluation](real-host-evaluation.md) | Record | An operator trial on real hosts and the friction it found |
| [Observability](observability.md) | Mostly proposed | What exists today and the planned metrics, logs and alerts |
| [Capabilities](capabilities.md) | Proposed | Delegated, attenuated authority beyond the three roles |
| [Consoles and agent-built control planes](consoles.md) | Proposed | A controller API and MCP server for prompt-built dashboards |
| [File-mounted workload secrets](secrets.md) | Proposed | Mounting secrets as files instead of environment variables |
| [Podman and other container engines](container-engines.md) | Proposed | Supporting engines other than Docker |
| [Standalone binary](standalone-binary.md) | Prototyped | A compiled client without Node.js |
| [Terminal UI design](tui.md) | Phases 1 to 3 built | User flows, screen design, architecture and the remaining phases of `tug tui` |
| [Terminology review](terminology-review.md) | Record | The 1 November 2026 naming review behind the vocabulary |
