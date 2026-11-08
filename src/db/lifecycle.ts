import type { Db, SqlValue } from './driver.ts';

/**
 * A lifecycle stored as a string column. The transition table is the single declaration of which moves are legal;
 * `advance` and `advanceWhere` are the only code that should write the column after the row exists.
 */
export interface Lifecycle<S extends string> {
  readonly name: string;
  readonly table: string;
  readonly column: string;
  /** States a row may be inserted in. */
  readonly initial: readonly S[];
  /** For every state, the states it may move to. A state with no exits is terminal. */
  readonly transitions: Readonly<Record<S, readonly S[]>>;
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/** Validates the table once so a typo fails at startup, not at the first transition. */
export function defineLifecycle<S extends string>(lifecycle: Lifecycle<S>): Lifecycle<S> {
  const states = Object.keys(lifecycle.transitions) as S[];
  for (const name of [lifecycle.table, lifecycle.column])
    if (!IDENTIFIER.test(name)) throw new Error(`${lifecycle.name}: invalid identifier ${name}`);
  for (const state of lifecycle.initial)
    if (!states.includes(state))
      throw new Error(`${lifecycle.name}: initial state ${state} is not declared`);
  for (const [from, targets] of Object.entries<readonly S[]>(lifecycle.transitions))
    for (const to of targets)
      if (!states.includes(to))
        throw new Error(`${lifecycle.name}: ${from} moves to undeclared state ${to}`);
  return lifecycle;
}

export const statesOf = <S extends string>(lifecycle: Lifecycle<S>): S[] =>
  Object.keys(lifecycle.transitions) as S[];

export const isTerminal = <S extends string>(lifecycle: Lifecycle<S>, state: string): boolean =>
  (lifecycle.transitions[state as S]?.length ?? 0) === 0;

export const terminalStates = <S extends string>(lifecycle: Lifecycle<S>): S[] =>
  statesOf(lifecycle).filter((state) => isTerminal(lifecycle, state));

/** States that can still change: every state with at least one exit. */
export const activeStates = <S extends string>(lifecycle: Lifecycle<S>): S[] =>
  statesOf(lifecycle).filter((state) => !isTerminal(lifecycle, state));

export const canMove = <S extends string>(
  lifecycle: Lifecycle<S>,
  from: string,
  to: string,
): boolean => lifecycle.transitions[from as S]?.includes(to as S) ?? false;

/** Quoted list for `state IN (...)`; the names come from the lifecycle, never from input. */
export const statesSql = <S extends string>(states: readonly S[]): string =>
  states.map((state) => `'${state}'`).join(',');

export interface Where {
  sql: string;
  params?: SqlValue[];
}

/**
 * Moves every row matching `where` that is in one of `from` to `to`, and returns how many moved. Every `from` must
 * be allowed to reach `to`; asking for anything else is a programming error and throws. Rows in another state are
 * left alone, so a concurrent writer that got there first simply makes the count smaller.
 */
export function advanceWhere<S extends string>(
  db: Db,
  lifecycle: Lifecycle<S>,
  from: S | readonly S[],
  to: S,
  where: Where,
  set: Record<string, SqlValue> = {},
): number {
  const sources = (Array.isArray(from) ? from : [from]) as readonly S[];
  for (const source of sources)
    if (!canMove(lifecycle, source, to))
      throw new Error(`${lifecycle.name}: ${source} cannot move to ${to}`);
  const columns = Object.keys(set);
  for (const column of columns)
    if (!IDENTIFIER.test(column)) throw new Error(`${lifecycle.name}: invalid column ${column}`);
  const assignments = [lifecycle.column, ...columns].map((column) => `${column}=?`).join(',');
  return db.run(
    `UPDATE ${lifecycle.table} SET ${assignments} WHERE (${where.sql}) AND ${lifecycle.column} IN (${sources.map(() => '?').join(',')})`,
    to,
    ...columns.map((column) => set[column]),
    ...(where.params ?? []),
    ...sources,
  ).changes;
}

/** Moves one row by id. Returns false when the row was not in `from`, which is how a lost race shows. */
export function advance<S extends string>(
  db: Db,
  lifecycle: Lifecycle<S>,
  rowId: string,
  from: S | readonly S[],
  to: S,
  set: Record<string, SqlValue> = {},
): boolean {
  return advanceWhere(db, lifecycle, from, to, { sql: 'id=?', params: [rowId] }, set) === 1;
}

/** Column constraint for the lifecycle's state column, generated from the same table so the two cannot drift. */
export const stateCheck = <S extends string>(lifecycle: Lifecycle<S>): string =>
  `CHECK(${lifecycle.column} IN (${statesSql(statesOf(lifecycle))}))`;
