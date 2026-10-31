import yaml from 'js-yaml';

export const MESH_RUN_FLAGS = '--network host --cap-add NET_ADMIN';
export function shellQuote(value: unknown): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function dockerRunSnippet(image: string, joinKey: string, mesh = false): string {
  return `docker run -d --name tug-agent --restart unless-stopped ${mesh ? `${MESH_RUN_FLAGS} -e TUG_MESH=true ` : ''}-v /var/run/docker.sock:/var/run/docker.sock -v tug-agent:/var/lib/tug -e TUG_JOIN_KEY=${shellQuote(joinKey)} ${shellQuote(image)} agent`;
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
