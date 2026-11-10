import { compareCompat, majorMinor } from '../protocol.ts';
import { CONTROL_CONTAINER, shellQuote as sh } from './install.ts';

/** Tag the previous control image is kept under while an upgrade replaces it, so `control upgrade --rollback` can go back. */
export const ROLLBACK_TAG = 'tug:rollback';

/** The settings of a running control container that an upgrade must carry over; only the image changes. */
export interface ControlInstall {
  /** The image reference the container was started from. */
  image: string;
  /** The image ID, so the previous image can be tagged even when its reference was a mutable tag. */
  imageId: string;
  /** The published host port. */
  port: number;
  /** The `TUG_CONTROL_URL` advertised to clients. */
  controlUrl: string;
  extraSans: string[];
}

interface InspectedContainer {
  Image?: string;
  Config?: { Image?: string; Env?: string[] | null };
  HostConfig?: { PortBindings?: Record<string, { HostPort?: string }[] | null> | null };
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
  const binding = container.HostConfig?.PortBindings?.['8443/tcp']?.[0]?.HostPort;
  const port = Number(binding);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(
      'the control container publishes no port 8443; it was not created by `tug control setup`, so rerun that instead',
    );
  const controlUrl = envValue(container, 'TUG_CONTROL_URL');
  if (!controlUrl)
    throw new Error(
      'the control container has no TUG_CONTROL_URL; it was not created by `tug control setup`, so rerun that instead',
    );
  return {
    image: container.Config!.Image!,
    imageId: container.Image ?? container.Config!.Image!,
    port,
    controlUrl,
    extraSans: (envValue(container, 'TUG_EXTRA_SANS') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

/** What an agent container records: its image and, when it dials control at a connect-only address, that address. */
export interface AgentInstall {
  image: string;
  controlUrl?: string;
}

export function parseAgentInspect(json: string): AgentInstall {
  const container = inspected(json, 'agent container');
  return {
    image: container.Config!.Image!,
    controlUrl: envValue(container, 'TUG_CONTROL_URL') || undefined,
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

export const readControlCaScript = `docker exec ${sh(CONTROL_CONTAINER)} cat /data/pki/ca.crt`;

/** Whether a running image already is the target: nothing to do unless the operator forces a recreate. */
export function alreadyRunning(
  current: string,
  target: string,
  force: boolean | undefined,
): boolean {
  return !force && current === target;
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
