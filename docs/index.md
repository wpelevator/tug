# tug documentation

Find the page for what you want to do. New here: [Deploy your first service](getting-started.md) takes one VPS and about ten minutes.

## Do a task

| I want to | Run | Page |
| --- | --- | --- |
| Check a Compose file before touching a server | `tug lint` | [Compose extensions](compose.md#checking-the-file-with-tug-lint) |
| Install control and a first node | `tug setup`, `tug node add` | [Deploy your first service](getting-started.md) |
| Deploy, or undo a deploy | `tug deploy`, `tug rollback` | [Compose extensions](compose.md), [Health checks](healthchecks.md) |
| Fill `${NAME}` values and keep secrets out of git | `tug secret set`, `tug var set` | [Where values come from](compose.md#where-values-come-from) |
| Serve a hostname over HTTPS | `tug node ingress`, `x-tug.ingress` | [Ingress and HTTPS](ingress.md) |
| Back up a volume or database and restore it | `tug backup run`, `tug restore run` | [Backups and recovery](backups.md) |
| Add a server or spread services over servers | `tug node add`, `x-tug.placement` | [Service placement](placement.md), [Nodes](nodes.md) |
| Give CI a deploy key | `tug credential create ci --role deploy` | [Access control](access-control.md#deploying-from-github-actions) |
| Upgrade control and nodes | `tug upgrade` | [Upgrade control and nodes](upgrades.md), [Release notes for majors](releases.md#upgrading-to-40-the-image-you-wrote-is-the-image-that-runs) |
| Move a Compose app from one server to tug | `tug lint`, `tug values`, `tug exec -i` | [Migrating from Docker Compose](migrating-from-compose.md) |
| Move to new servers | `tug node add`, `tug node replace` | [Migrating to new servers](migration.md) |
| Run it for real | | [Production checklist](production-checklist.md) |
| Fix an error | `tug doctor` | [Troubleshooting](troubleshooting.md) |

## Look something up

- [CLI reference](cli.md), every command and flag
- [Compose extensions](compose.md), every `x-tug` key
- [Configuration](configuration.md), `tug.yml` keys and environment variables
- [Access control](access-control.md), roles and what each endpoint needs
- [Terminology](terminology.md), the words tug uses

## Understand how it works

- [Architecture](architecture.md), components and every flow
- [Control plane](control-plane.md), PKI, image delivery, backup and upgrade
- [Terminal UI](tui.md), `tug tui`
- [tug compared with Docker Swarm](swarm-comparison.md)

## Contribute and read the design record

- [Development](development.md), [Testing](testing.md) and [Releases](releases.md)
- [Design records](design-records.md): the roadmap, security audit, real-host evaluation and proposals for features that are not built
