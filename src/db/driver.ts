/** The portable subset shared by synchronous SQLite runtimes. Only anonymous ? bindings are supported. */
export type SqlValue = string | number | bigint | null | Uint8Array;
export type SqlRow = Record<string, SqlValue>;

export interface Db {
  get<T = SqlRow>(sql: string, ...values: SqlValue[]): T | undefined;
  all<T = SqlRow>(sql: string, ...values: SqlValue[]): T[];
  run(sql: string, ...values: SqlValue[]): { changes: number };
  exec(sql: string): void;
  close(): void;
}

export type ConnectDb = (filename: string, options: { readOnly: boolean }) => Db;

export class DbError extends Error {
  readonly kind: 'unique' | 'busy';

  constructor(kind: DbError['kind'], cause: Error) {
    super(cause.message, { cause });
    this.name = 'DbError';
    this.kind = kind;
  }
}

export function isUniqueViolation(error: unknown): boolean {
  return error instanceof DbError && error.kind === 'unique';
}
