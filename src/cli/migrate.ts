import { CONTROL_CONTAINER, shellQuote as sh } from './install.ts';

/** Docker volume holding the agent's state (identity, applied revisions, ingress config) on every node. */
export const AGENT_VOLUME = 'tug-agent';
/** Docker volume holding the control plane's `/data` (database, master key, PKI, build archives). */
export const CONTROL_VOLUME = 'tug-control';
/**
 * Written into a volume last by a migration, so a half-copied volume is never mistaken for a finished one. Its content
 * is the host-layout version the volume is at (1: seeded from the old host directory), so a later host-side step can
 * tell what is still pending. Changes that stay inside a volume belong in the database migrations (src/db/db.ts).
 */
export const MIGRATED_MARKER = '.tug-migrated';
export const LAYOUT_VERSION = 1;
/** Host directories the agent and control used before their state moved into volumes. */
export const LEGACY_AGENT_DIR = '/var/lib/tug';
export const LEGACY_CONTROL_DIR = '/var/lib/tug-control';
/** The container name of the agent, which migration stops and the install replaces. */
export const AGENT_CONTAINER = 'tug-agent';
export const CONTROL_COMPOSE_FILE = '/opt/tug-control/docker-compose.yml';

/** Exit code of a refused install, so callers and scripts can tell it from an SSH or Docker failure. */
export const LEGACY_STATE_EXIT = 30;

/** A subject whose state moved from a host directory into a named volume. */
interface Subject {
  /** Human name used in messages. */
  what: string;
  volume: string;
  /** Files whose presence means the directory or volume holds real state. */
  stateFiles: string[];
  /** The command the operator runs to migrate it. */
  migrateCommand: string;
}

const AGENT: Subject = {
  what: 'agent state',
  volume: AGENT_VOLUME,
  stateFiles: ['agent.json', 'agent-pending.json'],
  migrateCommand: 'tug node migrate',
};

const CONTROL: Subject = {
  what: 'control data',
  volume: CONTROL_VOLUME,
  stateFiles: ['tug.db', 'master.key', 'pki'],
  migrateCommand: 'tug control migrate',
};

/** `docker run` prefix for a throwaway container from the Tug image that runs a shell command against a volume. */
const throwaway = (imageRef: string, mounts: string) =>
  `docker run --rm --entrypoint sh ${mounts} ${imageRef} -c`;

const anyExists = (dir: string, files: string[]) =>
  files.map((f) => `[ -e ${dir}/${f} ]`).join(' || ');
const testAnyIn = (dir: string, files: string[]) =>
  files.map((f) => `test -e ${dir}/${f}`).join(' || ');

/** Makes sure the image is on the host before a throwaway container needs it; a locally loaded image is left alone. */
const ensureImage = (image: string) =>
  `docker image inspect ${sh(image)} >/dev/null 2>&1 || docker pull --quiet ${sh(image)} >/dev/null`;

/**
 * The script that refuses to install over a host that still keeps its state in the old host directory. Without it a
 * new install would start on an empty volume: the agent would have no identity (control would refuse a fresh key for
 * a node it already knows) and a new control would create a second CA. It runs before the install writes anything.
 * The volume counts as holding state when it has any of the state files or the migration marker.
 */
function guard(subject: Subject, image: string, name: string, legacyDir: string): string {
  const { volume, stateFiles, migrateCommand, what } = subject;
  const hint = `${migrateCommand}${name ? ` ${name}` : ''}`;
  return [
    'set -eu',
    `{ ${anyExists(legacyDir, stateFiles)}; } || exit 0`,
    `if docker volume inspect ${volume} >/dev/null 2>&1; then`,
    `  ${ensureImage(image)}`,
    `  ${throwaway(sh(image), `-v ${volume}:/s:ro`)} ${sh(`${testAnyIn('/s', [...stateFiles, MIGRATED_MARKER])}`)} && exit 0`,
    'fi',
    `echo ${sh(`this host still keeps its ${what} in ${legacyDir}, which now lives in the Docker volume ${volume}; run \`${hint}\` first (see docs/migration.md)`)} >&2`,
    `exit ${LEGACY_STATE_EXIT}`,
    '',
  ].join('\n');
}

/** `legacyDir` is a parameter only so tests can point the scripts at a temporary directory. */
export const agentGuardScript = (image: string, name: string, legacyDir = LEGACY_AGENT_DIR) =>
  guard(AGENT, image, name, legacyDir);
export const controlGuardScript = (image: string, legacyDir = LEGACY_CONTROL_DIR) =>
  guard(CONTROL, image, '', legacyDir);

/**
 * The copy that seeds a volume from the old host directory, run in a throwaway container from the Tug image so it is
 * root, keeps ownership and modes (`agent.json` stays 0600) and carries the SQLite `-wal` and `-shm` files. The
 * marker goes in last: a volume without it is cleared and copied again, unless it already holds an identity or
 * database that differs from the old directory's (then it is real state of something else and nothing is touched).
 */
function seed(subject: Subject, imageRef: string, legacyDir: string): string {
  const { volume } = subject;
  const identity = subject === AGENT ? 'agent.json' : 'tug.db';
  const inner = [
    'set -eu',
    `[ -e /to/${MIGRATED_MARKER} ] && { echo 'volume already seeded'; exit 0; }`,
    `if [ -e /to/${identity} ] && ! cmp -s /from/${identity} /to/${identity}; then echo ${sh(`the volume ${volume} holds ${identity} that differs from ${legacyDir}/${identity}; refusing to overwrite it`)} >&2; exit 41; fi`,
    'find /to -mindepth 1 -delete',
    'cp -a /from/. /to/',
    `echo ${LAYOUT_VERSION} > /to/${MIGRATED_MARKER}`,
    'sync',
  ].join('\n');
  return `${throwaway(imageRef, `-v ${legacyDir}:/from:ro -v ${volume}:/to`)} ${sh(inner)}`;
}

/**
 * Migrates the agent's state on a node: stops the old agent (never removes it, so a failure can start it again),
 * seeds the volume, and leaves the install to the caller. The old container is restarted if the copy fails.
 */
export function agentMigrateScript(fallbackImage: string, legacyDir = LEGACY_AGENT_DIR): string {
  return [
    'set -eu',
    `[ -e ${legacyDir}/agent.json ] || [ -e ${legacyDir}/agent-pending.json ] || { echo ${sh(`nothing to migrate: ${legacyDir} holds no agent state`)}; exit 0; }`,
    `image=$(docker inspect --format '{{.Config.Image}}' ${AGENT_CONTAINER} 2>/dev/null || true)`,
    `[ -n "$image" ] || image=${sh(fallbackImage)}`,
    'docker image inspect "$image" >/dev/null 2>&1 || docker pull --quiet "$image" >/dev/null',
    `was_running=$(docker inspect --format '{{.State.Running}}' ${AGENT_CONTAINER} 2>/dev/null || echo false)`,
    `[ "$was_running" != true ] || docker stop ${AGENT_CONTAINER} >/dev/null`,
    `[ "$(docker inspect --format '{{.State.Running}}' ${AGENT_CONTAINER} 2>/dev/null || echo false)" = false ] || { echo 'the agent is still running; not copying a live database' >&2; exit 42; }`,
    `restore() { [ "$was_running" != true ] || docker start ${AGENT_CONTAINER} >/dev/null 2>&1 || true; }`,
    `if ! ${seed(AGENT, '"$image"', legacyDir)}; then restore; echo 'copy failed; the old agent was started again' >&2; exit 43; fi`,
    `echo ${sh(`agent state copied to the Docker volume ${AGENT_VOLUME}`)}`,
    '',
  ].join('\n');
}

/** The existing connect-only control URL of an agent installed the old way, so migration does not drop it. */
export const readLegacyControlUrlScript = `sed -n 's/^TUG_CONTROL_URL=//p' /etc/tug/agent.env 2>/dev/null | head -n 1 || true`;

/**
 * Migrates the control plane's `/data` on the control host: stops control (never removes it), seeds the volume, then
 * points the existing Compose file at the volume and recreates control on it. The Compose file is edited last, so a
 * rerun after a failure before that finds the old mount and skips the copy (the marker is set); a rerun after it finds
 * the new mount and goes straight to starting control and waiting for it, so a failed start is never reported as done. Control keeps the image,
 * port, URL and SANs it was installed with.
 */
export function controlMigrateScript(
  marker: string,
  { legacyDir = LEGACY_CONTROL_DIR, file = CONTROL_COMPOSE_FILE } = {},
): string {
  const oldMount = `${legacyDir}:/data`;
  const newMount = `${CONTROL_VOLUME}:/data`;
  return [
    'set -eu',
    `[ -e ${file} ] || { echo ${sh(`${file} not found; run tug control setup instead`)} >&2; exit 1; }`,
    `migrated=false`,
    `if grep -q ${sh(newMount)} ${file} && ! grep -q ${sh(oldMount)} ${file}; then migrated=true; echo 'control already runs on the volume; making sure it is up'; fi`,
    `[ "$migrated" = true ] || grep -q ${sh(oldMount)} ${file} || { echo ${sh(`${file} does not mount ${legacyDir}; cannot migrate it`)} >&2; exit 1; }`,
    'if [ "$migrated" = false ]; then',
    `image=$(docker inspect --format '{{.Config.Image}}' ${CONTROL_CONTAINER} 2>/dev/null || true)`,
    `[ -n "$image" ] || image=$(sed -n 's/^ *image: *"\\{0,1\\}\\([^"]*\\)"\\{0,1\\} *$/\\1/p' ${file} | head -n 1)`,
    '[ -n "$image" ] || { echo "cannot tell which image control runs" >&2; exit 1; }',
    'docker image inspect "$image" >/dev/null 2>&1 || docker pull --quiet "$image" >/dev/null',
    `docker volume create ${CONTROL_VOLUME} >/dev/null`,
    `was_running=$(docker inspect --format '{{.State.Running}}' ${CONTROL_CONTAINER} 2>/dev/null || echo false)`,
    `[ "$was_running" != true ] || docker stop ${CONTROL_CONTAINER} >/dev/null`,
    `[ "$(docker inspect --format '{{.State.Running}}' ${CONTROL_CONTAINER} 2>/dev/null || echo false)" = false ] || { echo 'control is still running; not copying a live database' >&2; exit 42; }`,
    `restore() { [ "$was_running" != true ] || docker start ${CONTROL_CONTAINER} >/dev/null 2>&1 || true; }`,
    `if ! ${seed(CONTROL, '"$image"', legacyDir)}; then restore; echo 'copy failed; the old control was started again' >&2; exit 43; fi`,
    `sed -e ${sh(`s#${oldMount}#${newMount}#`)} ${file} > ${file}.new`,
    `grep -q '^volumes:' ${file}.new || printf '\\nvolumes:\\n  ${CONTROL_VOLUME}:\\n    external: true\\n' >> ${file}.new`,
    `mv ${file}.new ${file}`,
    'fi',
    `echo ${sh(`${marker}Starting control on the volume`)}`,
    `docker compose -f ${file} up -d`,
    `echo ${sh(`${marker}Waiting for control to start`)}`,
    'for i in $(seq 1 60); do',
    `  docker exec ${sh(CONTROL_CONTAINER)} test -s /data/pki/ca.crt 2>/dev/null && { echo ${sh(`control data copied to the Docker volume ${CONTROL_VOLUME}`)}; exit 0; }`,
    '  sleep 1',
    'done',
    `echo ${sh(`control did not come back on the volume; check: docker logs ${CONTROL_CONTAINER}`)} >&2`,
    'exit 1',
    '',
  ].join('\n');
}

/** What migration leaves behind on the host for the operator to remove once the node or control is confirmed healthy. */
export const AGENT_LEFTOVERS = [LEGACY_AGENT_DIR, '/etc/tug'];
export const CONTROL_LEFTOVERS = [LEGACY_CONTROL_DIR];
