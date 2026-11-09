import * as yaml from 'js-yaml';

/** The agent dials container IPs for health checks; from the default bridge they are unreachable on current Docker (29.x), so it always shares the host network namespace. */
export const HOST_NETWORK_FLAG = '--network host';

/** Docker platform for the architecture a host reports with `uname -m`. */
export function dockerPlatform(uname: string): string {
  const arch = uname.trim();
  if (arch === 'x86_64' || arch === 'amd64') return 'linux/amd64';
  if (arch === 'aarch64' || arch === 'arm64') return 'linux/arm64';
  throw new Error(
    `unsupported host architecture '${arch}'; --build-local-image supports x86_64 and aarch64`,
  );
}

/** Build for the host the image will run on, not the lifecycle that builds it (an arm64 laptop and an amd64 VPS differ). */
export function localImageBuildArgs(imageTag: string, uname: string): string[] {
  return ['build', '--platform', dockerPlatform(uname), '-t', imageTag, '.'];
}

export function shellQuote(value: unknown): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function dockerRunSnippet(image: string, joinKey: string, address?: string): string {
  return `docker run -d --name tug-agent --restart unless-stopped ${HOST_NETWORK_FLAG} -v /var/run/docker.sock:/var/run/docker.sock -v tug-agent:/var/lib/tug -e TUG_JOIN_KEY=${shellQuote(joinKey)} ${address ? `-e TUG_NODE_ADDRESS=${shellQuote(address)} ` : ''}${shellQuote(image)} agent`;
}

/** The bootstrap runs in its own shell so its idempotent early exit cannot skip enrollment. */
export function enrollmentCloudInit(bootstrap: string, command: string): string {
  return (
    '#cloud-config\n' +
    yaml.dump(
      {
        write_files: [
          { path: '/opt/tug/install-docker.sh', permissions: '0700', content: bootstrap },
        ],
        runcmd: [['sh', '-eu', '-c', `sh /opt/tug/install-docker.sh && ${command}`]],
      },
      { lineWidth: -1, noRefs: true },
    )
  );
}

/**
 * Name of the container `control setup` creates. It is the name Compose gave it (project `tug-control`, service
 * `control`) when control was a Compose project; keeping it lets an upgrade replace that container and keeps
 * `control migrate`, the port check and the credential commands addressing the same container.
 */
export const CONTROL_CONTAINER = 'tug-control-control-1';

/** A TCP port is free, or is held by the control container this install would replace, so installing again upgrades in place. */
export function controlPortCheck(port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('port must be an integer from 1 to 65535');
  return `command -v ss >/dev/null 2>&1 || exit 0
ss -ltn | awk '{print $4}' | grep -qE '[.:]${port}$' || exit 0
[ -n "$(docker ps -q --filter 'name=^/${CONTROL_CONTAINER}$' --filter 'publish=${port}' 2>/dev/null)" ]
`;
}

/** The host of an SSH target: `host`, `user@host`, `ssh://user@host:2222` or bracketed IPv6. */
export function sshHost(sshTarget: string): string {
  let host = sshTarget
    .trim()
    .replace(/^ssh:\/\//, '')
    .replace(/\/.*$/, '');
  host = host.replace(/^[^@]*@/, '');
  const bracketed = /^\[([^\]]+)\]/.exec(host);
  if (bracketed) host = bracketed[1];
  else if (host.split(':').length === 2) host = host.split(':')[0];
  if (!host || /[\s'"]/.test(host))
    throw new Error(`cannot derive a host from SSH target ${sshTarget}`);
  return host;
}

/**
 * The default control URL for `control setup`: the SSH target's host and the published port. Accepts
 * `host`, `user@host`, `ssh://user@host:2222` and bracketed IPv6. An SSH alias from ~/.ssh/config is used as written,
 * so pass `--control-url` when the alias is not a name or address clients can reach.
 */
export function defaultControlUrl(sshTarget: string, port: number | string): string {
  const host = sshHost(sshTarget);
  return `https://${host.includes(':') ? `[${host}]` : host}:${port}`;
}
