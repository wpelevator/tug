import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Db } from './db.ts';
import { isUniqueViolation } from './db-driver.ts';
import { hashToken, id, now, token } from './util.ts';

/** Roles are cumulative: `deploy` includes `read`, and `admin` includes both. */
export const ROLES = ['read', 'deploy', 'admin'] as const;
export type Role = (typeof ROLES)[number];
export type RouteRole = Role | 'public';
const RANK: Record<Role, number> = { read: 1, deploy: 2, admin: 3 };

/** Name recorded in the audit trail for the root operator token. */
export const OPERATOR_ACTOR = 'operator';
/** Reserved actor for rollbacks control starts on its own. Token names cannot contain a colon, so no token can use it. */
export const AUTO_ROLLBACK_ACTOR = 'system:auto-rollback';
export const TOKEN_PREFIX = 'tug_tok';
export const TOKEN_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;
export const PROJECT_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
/** `last_used_at` is refreshed at most this often per token, so reads do not turn into writes. */
const LAST_USED_INTERVAL_MS = 60_000;

/**
 * The single source of truth for who may call what. Every `/api/v1` route must appear here: createApp refuses to
 * register an unlisted route, and a test compares this table with the live router. `public` routes do their own
 * credential check and are not behind the token guard. docs/access-control.md mirrors this table.
 */
export const ROUTE_ROLES: Record<string, RouteRole> = {
  'GET /api/v1/live': 'deploy',
  'GET /api/v1/status': 'read',
  'GET /api/v1/events': 'read',
  'GET /api/v1/projects/:project': 'read',
  'GET /api/v1/deployments/:id': 'read',
  'GET /api/v1/volumes': 'read',
  'GET /api/v1/secrets': 'read',
  'POST /api/v1/projects': 'deploy',
  'POST /api/v1/deployments': 'deploy',
  'POST /api/v1/deployments/:id/cancel': 'deploy',
  'POST /api/v1/rollback': 'deploy',
  'POST /api/v1/scale': 'deploy',
  'POST /api/v1/restart': 'deploy',
  'POST /api/v1/logs': 'deploy',
  'GET /api/v1/commands/:id': 'deploy',
  'POST /api/v1/secrets': 'admin',
  'DELETE /api/v1/secrets/:name': 'admin',
  'DELETE /api/v1/volumes/:name': 'admin',
  'GET /api/v1/nodes': 'admin',
  'POST /api/v1/nodes/register': 'admin',
  'POST /api/v1/nodes/enroll-token': 'admin',
  'POST /api/v1/nodes/:name/rotate-wg-key': 'admin',
  'POST /api/v1/nodes/:name/ingress': 'admin',
  'DELETE /api/v1/nodes/:name': 'admin',
  'GET /api/v1/backup/destination': 'admin',
  'POST /api/v1/backup/destination': 'admin',
  'DELETE /api/v1/backup/destination': 'admin',
  'GET /api/v1/backup/key': 'admin',
  'POST /api/v1/control/backups/run': 'admin',
  'POST /api/v1/control/restore': 'admin',
  'GET /api/v1/diagnostics': 'admin',
  'POST /api/v1/diagnostics/nodes': 'admin',
  'POST /api/v1/tokens': 'admin',
  'GET /api/v1/tokens': 'admin',
  'DELETE /api/v1/tokens/:name': 'admin',
};

/** The authenticated caller of an API request. `projects` is null when the credential is not project-scoped. */
export interface Actor {
  name: string;
  role: Role;
  projects: string[] | null;
}
export interface TokenRow {
  id: string;
  name: string;
  token_hash: string;
  role: Role;
  projects_json: string | null;
  created_at: string;
  created_by: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}
export interface TokenInfo {
  name: string;
  role: Role;
  projects: string[] | null;
  createdAt: string;
  createdBy: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

declare module 'express-serve-static-core' {
  interface Request {
    actor?: Actor;
  }
}

const statusError = (status: number, message: string) =>
  Object.assign(new Error(message), { status });
export const isRole = (value: unknown): value is Role =>
  typeof value === 'string' && (ROLES as readonly string[]).includes(value);
export const hasRole = (actor: Actor, required: Role): boolean =>
  RANK[actor.role] >= RANK[required];

/** Validates a token request body, throwing a 400 error describing the first problem. */
export function parseTokenRequest(body: unknown): {
  name: string;
  role: Role;
  projects: string[] | null;
  expiresAt: string | null;
} {
  const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const { name, role, projects, expiresInSeconds } = input;
  if (typeof name !== 'string' || !TOKEN_NAME_PATTERN.test(name))
    throw statusError(
      400,
      'token name must be 1-64 letters, numbers, dots, underscores or hyphens, starting with a letter or number',
    );
  if (name === OPERATOR_ACTOR)
    throw statusError(400, `token name ${OPERATOR_ACTOR} is reserved for the root operator token`);
  if (!isRole(role)) throw statusError(400, `role must be one of ${ROLES.join(', ')}`);
  let scope: string[] | null = null;
  if (projects !== undefined && projects !== null) {
    if (
      !Array.isArray(projects) ||
      !projects.length ||
      projects.length > 100 ||
      projects.some((p) => typeof p !== 'string' || !PROJECT_NAME_PATTERN.test(p))
    )
      throw statusError(
        400,
        'projects must be a nonempty list of valid project names, or omitted for all projects',
      );
    if (role === 'admin')
      throw statusError(
        400,
        'admin tokens manage the whole control plane and cannot be limited to projects',
      );
    scope = [...new Set(projects as string[])].sort();
  }
  let expiresAt: string | null = null;
  if (expiresInSeconds !== undefined && expiresInSeconds !== null) {
    if (
      typeof expiresInSeconds !== 'number' ||
      !Number.isSafeInteger(expiresInSeconds) ||
      expiresInSeconds < 1 ||
      expiresInSeconds > 10 * 365 * 86400
    )
      throw statusError(400, 'expiresInSeconds must be a positive integer of at most ten years');
    expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();
  }
  return { name, role, projects: scope, expiresAt };
}

const info = (row: TokenRow): TokenInfo => ({
  name: row.name,
  role: row.role,
  projects: row.projects_json ? JSON.parse(row.projects_json) : null,
  createdAt: row.created_at,
  createdBy: row.created_by,
  lastUsedAt: row.last_used_at,
  expiresAt: row.expires_at,
  revokedAt: row.revoked_at,
});

/** Creates a token. The plaintext is returned once; only its hash is stored. */
export function createToken(
  db: Db,
  request: ReturnType<typeof parseTokenRequest>,
  createdBy: string,
): TokenInfo & { token: string } {
  const value = token(TOKEN_PREFIX);
  try {
    db.run(
      'INSERT INTO api_tokens(id,name,token_hash,role,projects_json,created_at,created_by,expires_at) VALUES(?,?,?,?,?,?,?,?)',
      id('tok'),
      request.name,
      hashToken(value),
      request.role,
      request.projects ? JSON.stringify(request.projects) : null,
      now(),
      createdBy,
      request.expiresAt,
    );
  } catch (e) {
    if (isUniqueViolation(e))
      throw statusError(
        409,
        `token name ${request.name} is already used (revoked tokens keep their names for the audit trail)`,
      );
    throw e;
  }
  return {
    ...info(db.get<TokenRow>('SELECT * FROM api_tokens WHERE name=?', request.name)!),
    token: value,
  };
}

export function listTokens(db: Db): TokenInfo[] {
  return db.all<TokenRow>('SELECT * FROM api_tokens ORDER BY created_at, name').map(info);
}

/** Revokes a token immediately. Returns false if no such token exists; revoking twice keeps the first revocation time. */
export function revokeToken(db: Db, name: string): boolean {
  const row = db.get<TokenRow>('SELECT * FROM api_tokens WHERE name=?', name);
  if (!row) return false;
  db.run('UPDATE api_tokens SET revoked_at=? WHERE id=? AND revoked_at IS NULL', now(), row.id);
  return true;
}

/** Resolves a bearer value to an actor by hash lookup: the root operator token first, then named tokens. */
export function authenticate(db: Db, raw: string): Actor | null {
  if (!raw) return null;
  const hash = hashToken(raw);
  const operator = db.get<{ value: string }>(
    'SELECT value FROM meta WHERE key=?',
    'operator_token_hash',
  );
  if (operator && hash === operator.value)
    return { name: OPERATOR_ACTOR, role: 'admin', projects: null };
  const row = db.get<TokenRow>('SELECT * FROM api_tokens WHERE token_hash=?', hash);
  if (!row || row.revoked_at || (row.expires_at && row.expires_at <= now())) return null;
  // Best effort and throttled: bookkeeping failures must never fail authentication.
  if (!row.last_used_at || Date.parse(row.last_used_at) < Date.now() - LAST_USED_INTERVAL_MS)
    try {
      db.run('UPDATE api_tokens SET last_used_at=? WHERE id=?', now(), row.id);
    } catch {
      /* Best-effort bookkeeping. */
    }
  return {
    name: row.name,
    role: row.role,
    projects: row.projects_json ? JSON.parse(row.projects_json) : null,
  };
}

/**
 * Which project a request targets: a name, `null` for control-wide data (admin only), or `undefined` when it cannot be
 * resolved (for example an unknown ID). Unresolvable targets are denied to scoped tokens without saying why, so they
 * cannot probe which IDs or projects exist.
 */
export type ProjectResolver = (
  req: Request,
) => string | null | undefined | Promise<string | null | undefined>;
export const bodyProject: ProjectResolver = (req) => String(req.body?.project || 'site');
export const queryProject: ProjectResolver = (req) => String(req.query.project || 'site');
const FORBIDDEN_PROJECT = 'forbidden: this token may not access that project';

/** Throws 403 unless the actor may act on `project`. Used where the project is only known after the body is parsed. */
export function assertProject(actor: Actor, project: string): void {
  if (actor.projects && !actor.projects.includes(project))
    throw statusError(403, FORBIDDEN_PROJECT);
}

/** Builds the request guard: authenticate (401), check the role (403), then check project scope (403). */
export function createGuard(db: Db) {
  return (required: Role, resolve?: ProjectResolver): RequestHandler =>
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const actor = authenticate(db, (req.headers.authorization || '').replace(/^Bearer /, ''));
        if (!actor) {
          res.status(401).json({ error: 'unauthorized' });
          return;
        }
        if (!hasRole(actor, required)) {
          res.status(403).json({ error: `forbidden: this action requires the ${required} role` });
          return;
        }
        if (resolve) {
          const project = await resolve(req);
          if (project === null && !hasRole(actor, 'admin')) {
            res.status(403).json({ error: 'forbidden: this action requires the admin role' });
            return;
          }
          if (
            actor.projects &&
            (project === undefined || project === null || !actor.projects.includes(project))
          ) {
            res.status(403).json({ error: FORBIDDEN_PROJECT });
            return;
          }
        }
        req.actor = actor;
        next();
      } catch (error) {
        next(error);
      }
    };
}

/** Appends a control-originated audit event naming the acting token. */
export function recordEvent(
  db: Db,
  event: {
    actor: string;
    type: string;
    message: string;
    project?: string | null;
    deploymentId?: string | null;
    metadata?: Record<string, unknown>;
  },
): void {
  db.run(
    'INSERT INTO events(id,project_id,deployment_id,node_id,level,type,message,metadata_json,created_at,actor) VALUES(?,?,?,?,?,?,?,?,?,?)',
    id('evt'),
    event.project ?? null,
    event.deploymentId ?? null,
    null,
    'info',
    event.type,
    event.message,
    JSON.stringify(event.metadata ?? {}),
    now(),
    event.actor,
  );
}
