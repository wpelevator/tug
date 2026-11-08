// The JSON Schema editors use for Compose files with the `x-tug` extension. Hand-written here,
// but never edited in x-tug.schema.json directly: `npm run schema` rewrites that committed file,
// and a test compares it against a fresh generation, so the schema cannot drift from the
// validator and `tug lint`.
import { RETENTION_KEYS } from './backup-config.ts';
import { SUPPORTED_SERVICE_KEYS, SUPPORTED_VOLUME_KEYS } from './compose.ts';

/** The stable URL the docs tell editors to load the schema from. */
export const SCHEMA_URL = 'https://unpkg.com/@wpelevator/tug/x-tug.schema.json';

/** A JSON Schema value; no external validator runs here, so keep it loose. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonSchema = any;

/** Allowed non-`x-` property names, as the validator accepts them, plus the `x-` extension prefix. */
const composePropertyNames = (supported: readonly string[]): JsonSchema => ({
  anyOf: [{ enum: [...supported].sort() }, { pattern: '^x-' }],
});

const duration = (description: string): JsonSchema => ({
  description,
  oneOf: [
    { type: 'number', description: 'milliseconds' },
    { type: 'string', pattern: '^\\d+(ms|s|m)?$', description: 'such as 500ms, 2s or 1m' },
  ],
});

const labels = (): JsonSchema => ({
  oneOf: [
    { type: 'object', additionalProperties: true },
    { type: 'array', items: { type: 'string' } },
  ],
});

const placement = (): JsonSchema => ({
  description:
    'Where the service or volume runs. With one registered node it may be omitted; with several, every service chooses nodes or labels (see docs/service-placement.md).',
  type: 'object',
  properties: {
    nodes: {
      type: 'array',
      minItems: 1,
      items: { type: 'string', description: 'a registered node name' },
    },
    labels: {
      type: 'array',
      items: { type: 'string', description: 'a node label set with `tug node add --label`' },
    },
  },
  additionalProperties: false,
});

const health = (): JsonSchema => ({
  description:
    'Checked by the agent after the container starts; the service becomes serving once it passes. An unknown type is rejected.',
  type: 'object',
  properties: {
    type: {
      description:
        'docker waits for the container to run and be healthy per its Dockerfile HEALTHCHECK; tcp dials the port on the container IP; http GETs http://<container-ip>:<port><path> and expects 2xx.',
      enum: ['docker', 'tcp', 'http'],
    },
    port: {
      description: 'Required for tcp; http defaults to 80.',
      oneOf: [{ type: 'integer', minimum: 1, maximum: 65535 }, { type: 'string' }],
    },
    path: {
      type: 'string',
      pattern: '^/',
      description: 'http only: the request path (default /).',
    },
    interval: duration('Time between attempts (default 2s).'),
    timeout: duration('Per-attempt limit (default 2s).'),
    retries: {
      oneOf: [{ type: 'integer', minimum: 1 }, { type: 'string' }],
      description: 'Attempts before failing (default 10).',
    },
  },
  required: ['type'],
  additionalProperties: false,
});

const ingress = (): JsonSchema => ({
  description:
    'Publishes the service on a hostname through the managed Caddy edge (see docs/networking.md#layer-b-ingress-and-tls).',
  type: 'object',
  properties: {
    host: {
      type: 'string',
      description:
        'A fully qualified hostname, unique across the file; point its DNS at the ingress node.',
    },
    port: {
      type: 'integer',
      minimum: 1,
      maximum: 65535,
      description: 'The container (or published host) port the edge reaches; must appear in ports.',
    },
    tls: {
      enum: ['auto', 'custom', 'off'],
      description:
        '`auto` is ACME (default; a wildcard host is issued per name on demand); `custom` needs cert and key; `off` is plain HTTP.',
    },
    cert: {
      type: 'string',
      description: 'tls custom: the project secret holding the PEM certificate chain.',
    },
    key: {
      type: 'string',
      description: 'tls custom: the project secret holding the PEM private key.',
    },
    maintenance: {
      type: 'boolean',
      description:
        'Answer 503 with a short page for this host instead of reaching the service, for planned work. Default false.',
    },
  },
  required: ['host', 'port'],
  additionalProperties: false,
});

const rollout = (): JsonSchema => ({
  description:
    'How the service is replaced on a new deployment. `rolling` needs x-tug.ingress, x-tug.health and exactly one entry in ports (see docs/compose.md#rolling-rollouts).',
  type: 'object',
  properties: {
    strategy: {
      description:
        '`recreate` (default) replaces in place; `rolling` starts the new revision and switches traffic only once it is healthy.',
      enum: ['recreate', 'rolling'],
    },
    drain: duration('How long the previous revision keeps running after takeover (default 30s).'),
  },
  additionalProperties: false,
});

const retention = (): JsonSchema => ({
  description: 'A restic keep policy; at least one key is required (see docs/backups.md).',
  type: 'object',
  properties: Object.fromEntries(
    RETENTION_KEYS.map((key) => [key, { type: 'integer', minimum: 1 }]),
  ),
  additionalProperties: false,
});

/** Fields every `x-tug.backup` target takes; the kind-specific ones come separately. */
const backupCommon = (): JsonSchema => ({
  schedule: {
    type: 'string',
    description:
      'Five-field cron in UTC, or @daily/@hourly/@weekly/@monthly/@yearly; required unless the project-level x-tug.backup.schedule sets it.',
  },
  retention: retention(),
  jitter: {
    type: 'integer',
    minimum: 0,
    maximum: 3600,
    description:
      'Seconds of delay after the scheduled minute; the default is a stable value under 15 minutes.',
  },
  timeout: {
    description: 'Hard limit for one run, from 1m to 24h (default 2h).',
    oneOf: [{ type: 'integer' }, { type: 'string', pattern: '^\\d+(s|m|h)?$' }],
  },
  memory: {
    type: 'string',
    description: 'Memory of the restic helper container, from 128m to 16g (default 512m).',
  },
  writers: {
    type: 'array',
    items: { type: 'string' },
    description:
      'Services to hold during a restore; discovered from depends_on and volume mounts without it.',
  },
});

const commandOrArgv = (description: string): JsonSchema => ({
  description,
  oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
});

/** `x-tug.backup` as a value: `false`, the project defaults, a cron string or the full object. */
const backupValue = (kind: 'service' | 'volume', objectProperties: JsonSchema): JsonSchema => ({
  description:
    kind === 'service'
      ? 'A service backup runs `command` in the running container and stores its standard output (see docs/backups.md).'
      : 'A volume backup mounts the volume read-only and archives its files (see docs/backups.md).',
  oneOf: [
    {
      enum: [true],
      description:
        kind === 'service'
          ? 'not enough by itself: a service target still needs a schedule and a command'
          : 'enables the target with the project defaults',
    },
    { enum: [false], description: 'turns the target off' },
    { type: 'string', description: 'a cron string, meaning true with that schedule' },
    { type: 'object', properties: objectProperties, additionalProperties: false },
  ],
});

const serviceXtug = (): JsonSchema => ({
  description:
    'Tug settings for this service, described in docs/compose.md and checked by `tug lint`.',
  type: 'object',
  properties: {
    placement: placement(),
    replicas: {
      type: 'integer',
      minimum: 1,
      description:
        'With explicit nodes it must equal the node count; with labels it selects up to that many matching nodes. At most one replica runs per node.',
    },
    global: {
      type: 'boolean',
      description:
        'Run one replica on every node matching placement.labels, or on every node without labels.',
    },
    health: health(),
    ingress: ingress(),
    rollout: rollout(),
    backup: backupValue('service', {
      ...backupCommon(),
      command: commandOrArgv(
        'What to run in the container; a string runs through sh -c. Required.',
      ),
      restore: commandOrArgv(
        'Run in the container to load the stored snapshot back; the file arrives on stdin.',
      ),
      filename: {
        type: 'string',
        pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$',
        description: 'Name of the file inside the snapshot (default <service>.out).',
      },
      verify: {
        type: 'string',
        description:
          'Text that must appear in the last 4 KiB of output, such as `-- Dump completed`.',
      },
    }),
  },
  additionalProperties: false,
});

const volumeXtug = (): JsonSchema => ({
  description: 'Tug settings for this top-level volume.',
  type: 'object',
  properties: {
    type: {
      type: 'string',
      description: 'Recorded by control; `local` (default) is a named volume on the node.',
    },
    driver: { type: 'string' },
    persistent: {
      type: 'boolean',
      description: 'A persistent volume needs --delete-data on `tug volume remove`.',
    },
    placement: placement(),
    backup: backupValue('volume', {
      ...backupCommon(),
      exclude: {
        type: 'array',
        items: { type: 'string' },
        description: 'Restic exclude patterns.',
      },
    }),
  },
  additionalProperties: false,
});

const projectXtug = (): JsonSchema => ({
  description: 'Project-level Tug settings.',
  type: 'object',
  properties: {
    rollback: {
      description:
        '`auto` creates a rollback deployment when a deployment fails on health; `manual` (default) only reports it.',
      enum: ['auto', 'manual'],
    },
    backup: {
      description: 'Defaults for every x-tug.backup target; sets nothing on its own.',
      type: 'object',
      properties: {
        schedule: {
          type: 'string',
          description: 'Five-field cron in UTC, or @daily/@hourly/@weekly/@monthly/@yearly.',
        },
        retention: retention(),
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
});

/** Standard Compose keys Tug passes through, plus the `x-tug` block. */
const serviceProperties = (): JsonSchema => ({
  image: {
    type: 'string',
    description: 'The image reference; control resolves published tags to image@sha256 once.',
  },
  build: {
    oneOf: [{ type: 'string' }, { type: 'object' }],
    description: 'Built by control from uploaded source, or here with `tug deploy --build-local`.',
  },
  command: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
  entrypoint: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
  environment: {
    description: 'Control secrets are referenced as ${NAME} and substituted by the agent.',
    oneOf: [
      { type: 'object', additionalProperties: true },
      { type: 'array', items: { type: 'string' } },
    ],
  },
  ports: {
    type: 'array',
    description:
      'Bindings without a host IP go to the node address or 127.0.0.1, not every interface.',
    items: {
      oneOf: [
        { type: 'string' },
        {
          type: 'number',
          description: 'a container port, published and reachable on any interface',
        },
        {
          type: 'object',
          properties: {
            target: { type: 'number' },
            published: { oneOf: [{ type: 'number' }, { type: 'string' }] },
            host_ip: { type: 'string' },
            protocol: { type: 'string' },
          },
          additionalProperties: true,
        },
      ],
    },
  },
  expose: { type: 'array', items: { oneOf: [{ type: 'string' }, { type: 'number' }] } },
  volumes: { type: 'array', items: { oneOf: [{ type: 'string' }, { type: 'object' }] } },
  tmpfs: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
  healthcheck: { type: 'object' },
  restart: { type: 'string' },
  labels: labels(),
  depends_on: {
    description:
      'Start order on a node; condition service_healthy also waits on the dependency x-tug.health.',
    oneOf: [
      { type: 'array', items: { type: 'string' } },
      {
        type: 'object',
        additionalProperties: {
          type: 'object',
          properties: { condition: { enum: ['service_started', 'service_healthy'] } },
          additionalProperties: true,
        },
      },
    ],
  },
  extra_hosts: {
    oneOf: [
      { type: 'object', additionalProperties: { type: 'string' } },
      { type: 'array', items: { type: 'string' } },
    ],
  },
  user: { type: 'string' },
  working_dir: { type: 'string' },
  hostname: { type: 'string' },
  init: { type: 'boolean' },
  read_only: { type: 'boolean' },
  shm_size: { oneOf: [{ type: 'string' }, { type: 'number' }] },
  mem_limit: { oneOf: [{ type: 'string' }, { type: 'number' }] },
  mem_reservation: { oneOf: [{ type: 'string' }, { type: 'number' }] },
  cpus: { type: 'number' },
  pids_limit: { oneOf: [{ type: 'number' }, { type: 'string' }] },
  cap_add: { type: 'array', items: { type: 'string' } },
  cap_drop: { type: 'array', items: { type: 'string' } },
  ulimits: { type: 'object' },
  logging: { type: 'object' },
  stop_grace_period: { type: 'string' },
  stop_signal: { type: 'string' },
  networks: {
    description: 'Only the default network: Tug runs everything on its own project network.',
    oneOf: [
      { type: 'array', maxItems: 1, items: { const: 'default' } },
      { type: 'object', propertyNames: { enum: ['default'] } },
    ],
  },
  pull_policy: {
    type: 'string',
    description: 'Accepted but ignored: Tug decides when images change.',
  },
  'x-tug': serviceXtug(),
});

const volumeProperties = (): JsonSchema => ({
  name: { type: 'string' },
  driver: { type: 'string' },
  driver_opts: { type: 'object', additionalProperties: true },
  labels: labels(),
  external: {
    oneOf: [
      { type: 'boolean' },
      { type: 'object', properties: { name: { type: 'string' } }, additionalProperties: false },
    ],
  },
  'x-tug': volumeXtug(),
});

/** Tug ignores `pull_policy` on purpose, so the schema names it; `deploy` (Swarm) is not listed, and the validator rejects it. */
const serviceKeys = [
  ...SUPPORTED_SERVICE_KEYS.filter((key) => key !== 'x-tug'),
  'networks',
  'pull_policy',
  'x-tug',
];

const service = (): JsonSchema => ({
  type: 'object',
  properties: serviceProperties(),
  propertyNames: composePropertyNames(serviceKeys),
});

const volume = (): JsonSchema => ({
  type: 'object',
  properties: volumeProperties(),
  propertyNames: composePropertyNames(SUPPORTED_VOLUME_KEYS),
});

/** The published schema; a test in the suite keeps the committed x-tug.schema.json at this shape. */
export function xTugSchema(): JsonSchema {
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: SCHEMA_URL,
    title: 'Tug deploy file',
    description:
      'A Docker Compose file with the x-tug extension for Tug deployments (docs/compose.md). `tug lint` checks a file against this schema from the command line.',
    type: 'object',
    properties: {
      services: {
        description:
          'The services to deploy. Unknown keys are rejected by the validator and squiggled by this schema.',
        type: 'object',
        patternProperties: { '.+': service() },
      },
      volumes: {
        description: 'Named volumes: placed, backed up and managed per project.',
        type: 'object',
        patternProperties: { '.+': volume() },
      },
      networks: {
        description: 'Only the default network is accepted.',
        oneOf: [
          { type: 'array', maxItems: 1, items: { const: 'default' } },
          { type: 'object', propertyNames: { enum: ['default'] } },
        ],
      },
      name: {
        type: 'string',
        description:
          'The Compose project name; `tug deploy` warns when it differs from the Tug project.',
      },
      'x-tug': projectXtug(),
    },
    required: ['services'],
    propertyNames: {
      anyOf: [{ enum: ['name', 'networks', 'services', 'volumes', 'x-tug'] }, { pattern: '^x-' }],
    },
  };
}
