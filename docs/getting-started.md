# Deploy your first service

Install Tug's control plane and agent on one Linux VPS, deploy nginx, and visit its welcome page.

A typical VPS is a durable, always-on computer with enough CPU, memory and disk to host several sites or a medium-size application and its database, so you do not need a cluster, a per-app platform plan or a pile of managed services to run it well. Tug gives you the parts that usually make self-hosting a chore, namely image delivery (with an optional registry), rollbacks, scheduled backups, HTTPS and encrypted secrets, so you can keep the savings of a plain server. This tutorial uses one server; adding more later is covered in [service placement](service-placement.md).

## Before you start

You need a VPS with a public IP and SSH access as root, Node.js 22.18 or newer and Docker Compose v2 on your computer. The VPS must run Debian, Ubuntu, Fedora or a RHEL-compatible distribution if you want Tug to install Docker; otherwise install Docker Engine and the Compose plugin there first. The VPS needs outbound access to pull images. Allow your computer and the agent to reach control on TCP 8443, and allow your computer to reach TCP 8080 for this temporary example. Check your provider firewall as well as any host firewall.

Replace `203.0.113.5` below with your VPS address. These commands assume an interactive terminal, where Tug explains and confirms the installation choices. For automation see [Setup in the CLI reference](cli.md#setup).

## 1. Install Tug and control

On your computer, create a directory for this project and install the CLI:

```sh
mkdir my-first-tug && cd my-first-tug
npm install -g @wpelevator/tug
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

The deploy should report success, status should show `web` serving on `app1`, and curl should return the nginx welcome page. The explicit `0.0.0.0` publishes the example on all IPv4 interfaces; restrict TCP 8080 to your computer in the provider firewall while trying it. For a real site, use [managed ingress and HTTPS](networking.md#layer-b-ingress-and-tls), remove this explicit public binding, and redeploy. Tug otherwise binds published ports to the node address or loopback; a public node address can still make them public. See [port exposure](networking.md#published-ports-private-by-default).

With one node, omitted placement selects it automatically. The HTTP check verifies nginx responds before Tug marks it serving; see [Health checks](healthchecks.md). If the deploy fails or the page is unreachable, start with [Troubleshooting](troubleshooting.md).

## Choose a next step

- [Add a hostname and HTTPS](networking.md#layer-b-ingress-and-tls): enable ingress, point DNS at the VPS and route a service.
- [Deploy an application and database](../README.md#your-compose-file-plus-a-little-x-tug): use a volume and a project secret, then explore the [WordPress example](../examples/wordpress/README.md).
- [Back up and recover](backups.md): protect workload data and the control plane separately, then rehearse a restore.
- [Add another node](service-placement.md): pin stateful services and spread a stateless service across servers.
- [Choose health checks and safer rollouts](healthchecks.md): understand readiness, failures and rollback.
- [Give CI or teammates access](access-control.md): create credentials appropriate for trusted operators.

The service and control plane will keep running after this tutorial. Before retiring a host that contains data, follow [Retire a host](migration.md#retire-a-host); teardown can delete volumes and credentials. The [CLI reference](cli.md), [Compose reference](compose.md) and [configuration reference](configuration.md) describe all options.
