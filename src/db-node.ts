import { DatabaseSync } from 'node:sqlite';
import { DbError } from './db-driver.ts';
import type { ConnectDb, SqlValue } from './db-driver.ts';

function sqliteCall<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof Error && 'errcode' in error) {
      const code = Number(error.errcode);
      if (code === 1555 || code === 2067) throw new DbError('unique', error);
      if ((code & 255) === 5 || (code & 255) === 6) throw new DbError('busy', error);
    }
    throw error;
  }
}

/** Count anonymous placeholders outside SQL literals, quoted identifiers and comments. */
function checkBindings(sql: string, values: SqlValue[]): void {
  const tokens =
    sql.match(
      /'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|--[^\r\n]*|\/\*[\s\S]*?\*\/|\?\d*|[:@$][\w]+/g,
    ) ?? [];
  const parameters = tokens.filter((token) => /^[?:@$]/.test(token));
  if (parameters.some((token) => token !== '?'))
    throw new TypeError('Only anonymous ? SQL parameters are supported');
  if (parameters.length !== values.length)
    throw new TypeError(`Expected ${parameters.length} SQL bindings, received ${values.length}`);
  for (const value of values) {
    if (
      value !== null &&
      typeof value !== 'string' &&
      typeof value !== 'bigint' &&
      !(typeof value === 'number' && Number.isFinite(value)) &&
      !(value instanceof Uint8Array)
    )
      throw new TypeError(
        'SQL bindings must be strings, finite numbers, bigints, null or Uint8Array',
      );
  }
}

/** This module is the only runtime-specific adapter; replace it at build time for a future Bun bundle. */
export const connectNodeDb: ConnectDb = (filename, { readOnly }) => {
  const database = sqliteCall(() => new DatabaseSync(filename, { readOnly }));
  const prepare = (sql: string, values: SqlValue[]) => {
    checkBindings(sql, values);
    return database.prepare(sql);
  };
  return {
    get: <T>(sql: string, ...values: SqlValue[]) =>
      sqliteCall(() => {
        const row = prepare(sql, values).get(...values);
        return row === undefined ? undefined : ({ ...row } as T);
      }),
    all: <T>(sql: string, ...values: SqlValue[]) =>
      sqliteCall(() =>
        prepare(sql, values)
          .all(...values)
          .map((row) => ({ ...row }) as T),
      ),
    run: (sql, ...values) =>
      sqliteCall(() => {
        const { changes } = prepare(sql, values).run(...values);
        const count = Number(changes);
        if (!Number.isSafeInteger(count))
          throw new RangeError('SQL change count exceeds the safe integer range');
        return { changes: count };
      }),
    exec: (sql) => sqliteCall(() => database.exec(sql)),
    close: () => sqliteCall(() => database.close()),
  };
};
