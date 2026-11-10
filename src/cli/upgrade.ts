import { isIP } from 'node:net';
import { compareCompat, majorMinor } from '../protocol.ts';
import { isPort } from '../node-address.ts';
import { CONTROL_CONTAINER, shellQuote as sh } from './install.ts';
import { CONTROL_VOLUME } from './migrate.ts';

/** Tag the previous control image is kept under while an upgrade replaces it, so `control upgrade --rollback` can go back. */
export const ROLLBACK_TAG = 'tug:rollback';

/** The settings of a running control container that an upgrade must carry over; only the image changes. */
export interface ControlInstall {
  /** The image reference the container was started from. */
  image: string;
  /** The image ID, so the previous image can be tagged even when its reference was a mutable tag. */
  imageId: string;
  bindings: ControlBinding[];
  /** The `TUG_CONTROL_URL` advertised to clients. */
  controlUrl: string;
  extraSans: string[];
}

export interface ControlBinding {
  hostIp?: string;
  port: number;
}

type PortBindings = Record<string, { HostIp?: string; HostPort?: string }[] | null>;

interface InspectedContainer {
  Image?: string;
  Config?: { Image?: string; Env?: string[] | null };
  HostConfig?: { NetworkMode?: string; PortBindings?: PortBindings | null };
  NetworkSettings?: { Ports?: PortBindings | null };
}

export function controlPortMapping({ hostIp, port }: ControlBinding): string {
  const address = hostIp && isIP(hostIp) === 6 ? `[${hostIp}]` : hostIp;
  return `${address ? `${address}:` : ''}${port}:8443`;
}

function inspected(json: string, what: string): InspectedContainer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new Error(`could not read \`docker inspect\` output for ${what}`, { cause: e });
  }
  const container = Array.isArray(parsed)
    ? (parsed[0] as InspectedContainer | undefined)
    : undefined;
  if (!container?.Config?.Image) throw new Error(`\`docker inspect\` returned no ${what}`);
  return container;
}

function envValue(container: InspectedContainer, name: string): string | undefined {
  const prefix = `${name}=`;
  const entry = container.Config?.Env?.find((e) => e.startsWith(prefix));
  return entry === undefined ? undefined : entry.slice(prefix.length);
}

/** The install settings recorded in the `docker inspect` JSON of the control container. */
export function parseControlInspect(json: string): ControlInstall {
  const container = inspected(json, 'control container');
  const networkMode = container.HostConfig?.NetworkMode ?? '';
  if (networkMode === 'host' || networkMode === 'none' || networkMode.startsWith('container:'))
    throw new Error('control has an unsupported network mode; upgrade this installation manually');
  const configured = container.HostConfig?.PortBindings;
  const published = container.NetworkSettings?.Ports;
  if (
    [configured, published].some((ports) =>
      Object.entries(ports ?? {}).some(
        ([target, bindings]) => target !== '8443/tcp' && bindings?.length,
      ),
    )
  )
    throw new Error(
      'control publishes additional container ports; upgrade this installation manually',
    );
  // What was asked for (`-p` as typed) is replayed, not what the daemon made of it: a wildcard `-p 9443:8443` is published
  // as both 0.0.0.0 and :: on an IPv6 host, and replaying those as explicit mappings would fail on a host that no longer
  // has IPv6, where the wildcard itself would still work. The published list is only the fallback for an empty request.
  const requested = configured?.['8443/tcp'];
  const rawBindings = requested?.length ? requested : published?.['8443/tcp'];
  if (!rawBindings?.length)
    throw new Error(
      'the control container publishes no port 8443; it was not created by `tug control setup`, so rerun that instead',
    );
  const bindings = rawBindings.map((binding) => {
    const port = Number(binding?.HostPort);
    const hostIp = binding?.HostIp;
    if (!isPort(port) || (hostIp !== undefined && hostIp !== '' && !isIP(hostIp)))
      throw new Error(
        'control has an unsupported port 8443 binding; upgrade this installation manually',
      );
    return { port, ...(hostIp ? { hostIp } : {}) };
  });
  const controlUrl = envValue(container, 'TUG_CONTROL_URL');
  if (!controlUrl)
    throw new Error(
      'the control container has no TUG_CONTROL_URL; it was not created by `tug control setup`, so rerun that instead',
    );
  return {
    image: container.Config!.Image!,
    imageId: container.Image ?? container.Config!.Image!,
    bindings,
    controlUrl,
    extraSans: (envValue(container, 'TUG_EXTRA_SANS') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

/**
 * The agent's own `TUG_ROLLOUT_PORTS`, kept across an upgrade so a node with a custom range does not silently go back to
 * the default. Only its shape is checked here (the agent validates the range); anything else is refused rather than
 * carried into a shell command.
 */
function rolloutSetting(container: InspectedContainer): { rolloutPorts?: string } {
  const rolloutPorts = envValue(container, 'TUG_ROLLOUT_PORTS')?.trim();
  if (!rolloutPorts) return {};
  if (!/^\d{1,5}-\d{1,5}$/.test(rolloutPorts))
    throw new Error(
      `the agent's TUG_ROLLOUT_PORTS ${JSON.stringify(rolloutPorts)} is not LOW-HIGH; upgrade this node manually`,
    );
  return { rolloutPorts };
}

/** What an agent container records: its image and, when it dials control at a connect-only address, that address. */
export interface AgentInstall {
  image: string;
  /** The image ID the container runs, which is what decides whether an upgrade changes anything. */
  imageId: string;
  controlUrl?: string;
  rolloutPorts?: string;
}

export function parseAgentInspect(json: string): AgentInstall {
  const container = inspected(json, 'agent container');
  return {
    image: container.Config!.Image!,
    imageId: container.Image ?? container.Config!.Image!,
    controlUrl: envValue(container, 'TUG_CONTROL_URL') || undefined,
    ...rolloutSetting(container),
  };
}

/** The remote command that prints the container's `docker inspect` JSON; it fails when no such container exists. */
export const inspectScript = (container: string): string => `docker inspect ${sh(container)}`;
export const inspectControlScript = inspectScript(CONTROL_CONTAINER);
export const inspectAgentScript = inspectScript('tug-agent');

/** Tags the image the old container ran, so the upgrade can be undone; skipped when nothing changes image. */
export function rollbackTagScript(imageId: string): string {
  return `docker tag ${sh(imageId)} ${sh(ROLLBACK_TAG)}`;
}

/** Fails (exit 1) when the rollback image is not on the host. */
export const rollbackImageScript = `docker image inspect ${sh(ROLLBACK_TAG)} >/dev/null 2>&1 || { echo 'there is no ${ROLLBACK_TAG} image on this host: only an earlier \`control upgrade\` leaves one' >&2; exit 1; }`;

/**
 * The control CA, read from the data volume with a throwaway container rather than `docker exec`: a control that is
 * restarting (a newer database it cannot open, the case `control upgrade --rollback` exists for) has no running
 * container to exec into, and the CA is on the volume either way.
 */
export const readControlCaScript = (image: string): string =>
  `docker run --rm -v ${sh(`${CONTROL_VOLUME}:/data`)} --entrypoint cat ${sh(image)} /data/pki/ca.crt`;

/**
 * The image ID of a reference on the host, or undefined when the host does not have it. Image IDs, not tag names,
 * decide sameness: a rebuilt local image keeps its tag name only on the first build, and `tug:local` and
 * `tug:local-<id>` can name one image.
 */
export const imageIdScript = (ref: string): string =>
  `docker image inspect --format '{{.Id}}' ${sh(ref)} 2>/dev/null || true`;
export function parseImageId(output: string): string | undefined {
  const id = output.trim();
  return id.startsWith('sha256:') ? id : undefined;
}

/** Whether a running image already is the target: nothing to do unless the operator forces a recreate. */
export function alreadyRunning(
  currentImageId: string,
  targetImageId: string | undefined,
  force: boolean | undefined,
): boolean {
  return !force && targetImageId !== undefined && currentImageId === targetImageId;
}

/**
 * Whether an upgrade must keep the running image as the rollback image: only when the new image is a different image.
 * Moving the tag onto the image it already names would make `--rollback` a no-op that leaves the new image running.
 */
export function rollbackTagNeeded(currentImageId: string, newImageId: string | undefined): boolean {
  return currentImageId !== newImageId;
}

/**
 * Agents must never run ahead of the control (the control refuses them). `to` is the version asked for with `--to`;
 * refuses when it is on a newer compatibility key than the control.
 */
export function assertNotAheadOfControl(to: string, controlVersion: string): void {
  const target = majorMinor(to);
  const control = majorMinor(controlVersion);
  if (!target || !control) return;
  if (compareCompat(target, control) > 0)
    throw new Error(
      `the control runs ${controlVersion}, older than the ${to} you asked for; upgrade it first with \`tug control upgrade --to ${to}\``,
    );
}
