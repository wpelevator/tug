import * as yaml from 'js-yaml';

/** The agent dials container IPs for health checks; from the default bridge they are unreachable on current Docker (29.x), so it always shares the host network namespace. */
export const HOST_NETWORK_FLAG = '--network host';
export const MESH_RUN_FLAGS = `${HOST_NETWORK_FLAG} --cap-add NET_ADMIN`;

/** Docker platform for the architecture a host reports with `uname -m`. */
export function dockerPlatform(uname: string): string {
  const arch = uname.trim();
  if (arch === 'x86_64' || arch === 'amd64') return 'linux/amd64';
  if (arch === 'aarch64' || arch === 'arm64') return 'linux/arm64';
  throw new Error(
    `unsupported host architecture '${arch}'; --build-local-image supports x86_64 and aarch64`,
  );
}

/** Build for the host the image will run on, not the machine that builds it (an arm64 laptop and an amd64 VPS differ). */
export function localImageBuildArgs(imageTag: string, uname: string): string[] {
  return ['build', '--platform', dockerPlatform(uname), '-t', imageTag, '.'];
}

export function shellQuote(value: unknown): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function dockerRunSnippet(image: string, joinKey: string, mesh = false): string {
  return `docker run -d --name tug-agent --restart unless-stopped ${mesh ? `${MESH_RUN_FLAGS} -e TUG_MESH=true ` : `${HOST_NETWORK_FLAG} `}-v /var/run/docker.sock:/var/run/docker.sock -v tug-agent:/var/lib/tug -e TUG_JOIN_KEY=${shellQuote(joinKey)} ${shellQuote(image)} agent`;
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

/** Name of the container `control-install` creates (Compose project `tug-control`, service `control`). */
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

/** An occupied mesh port is reusable only when the installed Tug agent owns the live key. */
export function meshPortCheck(port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('mesh port must be an integer from 1 to 65535');
  return `command -v ss >/dev/null 2>&1 || exit 1
listeners=$(ss -lun) || exit 1
if ! printf '%s\\n' "$listeners" | awk '{print $4}' | grep -qE '[.:]${port}$'; then exit 0; fi
[ "$(docker inspect --format '{{.HostConfig.NetworkMode}}' tug-agent 2>/dev/null)" = host ] || exit 1
[ "$(docker inspect --format '{{.State.Running}}' tug-agent 2>/dev/null)" = true ] || exit 1
docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' tug-agent 2>/dev/null | grep -qx 'TUG_MESH=true' || exit 1
[ "$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/tug"}}{{.Source}}{{end}}{{end}}' tug-agent 2>/dev/null)" = /var/lib/tug ] || exit 1
docker exec tug-agent sh -eu -c ${shellQuote(`
test -s /var/lib/tug/wireguard/private.key
test -s /var/lib/tug/wireguard/reported.pub
test "$(wg show wg0 listen-port)" = "${port}"
live_key=$(wg show wg0 public-key)
test -n "$live_key"
test "$live_key" = "$(wg pubkey < /var/lib/tug/wireguard/private.key)"
test "$live_key" = "$(cat /var/lib/tug/wireguard/reported.pub)"`)}
`;
}
