/** Roles are cumulative: `deploy` includes `read`, and `admin` includes both. */
export const ROLES = ['read', 'deploy', 'admin'] as const;
export type Role = (typeof ROLES)[number];
export const isRole = (value: unknown): value is Role =>
  typeof value === 'string' && (ROLES as readonly string[]).includes(value);
export const CREDENTIAL_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;
export const PROJECT_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
