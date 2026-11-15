# Deploy your first service

Install Tug's control plane and agent on one Linux VPS, deploy nginx, and open its welcome page. You end with a running service that you can roll back, back up and put behind HTTPS.

```sh
npm install -g @wpelevator/tug
tug setup root@203.0.113.5
tug node add root@203.0.113.5 --name app1
tug deploy
```

The steps below explain each command, with the Compose file `tug deploy` reads in step 3.

## Before you start

You need:

- A VPS with a public IP and SSH access as root. Debian, Ubuntu, Fedora or a RHEL-compatible distribution lets Tug install Docker for you. On any other distribution, install Docker Engine first.
- Node.js 22.18 or newer on your computer. Docker is needed there only for `--build-local`.
- Outbound access from the VPS to pull images.
- TCP 8443 open from your computer and the agent to control, and TCP 8080 open from your computer for this temporary example. Check the provider firewall as well as any host firewall.

Replace `203.0.113.5` with your VPS address. The commands assume an interactive terminal, where Tug explains each choice and waits for you to confirm. For automation see [Setup in the CLI reference](cli.md#setup).

## Optional: check your own app first

`tug lint` reads a Compose file offline and needs no control plane, credential or Docker. Run it in a directory with a `compose.yaml`:

```sh
cd path/to/your-app
tug lint
```

```text
compose.yaml: ok
```

When something is unsupported, each finding names the service and the rule, and the command exits 1:

```text
bad.yaml: web: networks other than the default network are not supported
bad.yaml: web: x-tug.rollback is not supported (supported: placement, replicas, global, health, ingress, rollout, backup)
```

[What Tug accepts](compose.md#not-supported) lists the unsupported keys. Existing Compose volumes are not reused: Tug names its volumes differently, so data moves in explicitly.

## 1. Install Tug and control

On your computer, create a directory for this project. The CLI is the one you installed at the top:

```sh
mkdir my-first-tug && cd my-first-tug
tug setup root@203.0.113.5
```

Allow Tug to install Docker if necessary and confirm the plan. Setup installs control and imports a root operator credential to your computer. The credential has full administrative access; keep it private. Setup creates `tug.yml` for shared defaults and a local overlay pointing to the credential. Keep working in this directory: the CLI searches the current directory for configuration, not its parents. See [project and configuration selection](cli.md#arguments-options-and-configuration).

```sh
tug status
```

You should see a control-wide status summary. If it cannot connect, check the address printed during setup and TCP 8443; see [Troubleshooting](troubleshooting.md).

## 2. Add the same VPS as a node

```sh
tug node add root@203.0.113.5 --name app1
tug node list
```

Accept Docker installation if prompted, choose an address belonging to the VPS and confirm the plan. You can decline managed ingress for this example and enable it later when you add a hostname. A private interface address is useful when you add a second server. The agent connects out to control and should appear in the node list with a recent contact time. The control plane and agent now share the VPS.

## 3. Deploy and visit a service

Save this as `compose.yaml` in the same directory:

```yaml
# yaml-language-server: $schema=https://unpkg.com/@wpelevator/tug/x-tug.schema.json
services:
  web:
    image: nginx:1.27-alpine
    ports:
      - "0.0.0.0:8080:80"
    x-tug:
      health:
        type: http
        port: 80
        path: /
```

```sh
tug deploy
tug status
tug logs web
curl http://203.0.113.5:8080/
```

The deploy should report success, status should show `web` serving on `app1`, and curl should return the nginx welcome page. The explicit `0.0.0.0` publishes the example on all IPv4 interfaces; restrict TCP 8080 to your computer in the provider firewall while trying it. For a real site, use [managed ingress and HTTPS](ingress.md#set-up-ingress), remove this explicit public binding, and redeploy. Tug otherwise binds published ports to the node address or loopback; a public node address can still make them public. See [port exposure](networking.md#published-ports-private-by-default).

With one node, omitted placement selects it automatically. The HTTP check verifies nginx responds before Tug marks it serving; see [Health checks](health-checks.md). If the deploy fails or the page is unreachable, start with [Troubleshooting](troubleshooting.md).

## Choose a next step

- [Add a hostname and HTTPS](ingress.md#set-up-ingress): enable ingress, point DNS at the VPS and route a service.
- [Deploy an application and database](https://github.com/wpelevator/tug/blob/main/README.md#your-compose-file-plus-a-little-x-tug): use a volume and a project secret, then explore the [WordPress example](https://github.com/wpelevator/tug/blob/main/examples/wordpress/README.md).
- [Set secrets and variables](compose.md#where-values-come-from): keep private values with `tug secret`, visible ones such as image tags with `tug var`, move an existing `.env` in with `tug secret import`, and check the result with `tug deploy --dry-run`.
- [Back up and recover](backups.md): protect workload data and the control plane separately, then rehearse a restore.
- [Add another node](placement.md): pin stateful services and spread a stateless service across servers.
- [Choose health checks and safer rollouts](health-checks.md): understand readiness, failures and rollback.
- [Give CI or teammates access](access-control.md): create credentials appropriate for trusted operators.

The service and control plane will keep running after this tutorial. Before retiring a host that contains data, follow [Retire a host](migration.md#retire-a-host); teardown can delete volumes and credentials. The [CLI reference](cli.md), [Compose reference](compose.md) and [configuration reference](configuration.md) describe all options.
