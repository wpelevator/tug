import type { Db, SqlValue } from './db-driver.ts';

/**
 * A lifecycle stored as a string column. The transition table is the single declaration of which moves are legal;
 * `advance` and `advanceWhere` are the only code that should write the column after the row exists.
 */
export interface Machine<S extends string> {
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
export function defineMachine<S extends string>(machine: Machine<S>): Machine<S> {
  const states = Object.keys(machine.transitions) as S[];
  for (const name of [machine.table, machine.column])
    if (!IDENTIFIER.test(name)) throw new Error(`${machine.name}: invalid identifier ${name}`);
  for (const state of machine.initial)
    if (!states.includes(state))
      throw new Error(`${machine.name}: initial state ${state} is not declared`);
  for (const [from, targets] of Object.entries<readonly S[]>(machine.transitions))
    for (const to of targets)
      if (!states.includes(to))
        throw new Error(`${machine.name}: ${from} moves to undeclared state ${to}`);
  return machine;
}

export const statesOf = <S extends string>(machine: Machine<S>): S[] =>
  Object.keys(machine.transitions) as S[];

export const isTerminal = <S extends string>(machine: Machine<S>, state: string): boolean =>
  (machine.transitions[state as S]?.length ?? 0) === 0;

export const terminalStates = <S extends string>(machine: Machine<S>): S[] =>
  statesOf(machine).filter((state) => isTerminal(machine, state));

/** States that can still change: every state with at least one exit. */
export const activeStates = <S extends string>(machine: Machine<S>): S[] =>
  statesOf(machine).filter((state) => !isTerminal(machine, state));

export const canMove = <S extends string>(machine: Machine<S>, from: string, to: string): boolean =>
  machine.transitions[from as S]?.includes(to as S) ?? false;

/** Quoted list for `state IN (...)`; the names come from the machine, never from input. */
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
  machine: Machine<S>,
  from: S | readonly S[],
  to: S,
  where: Where,
  set: Record<string, SqlValue> = {},
): number {
  const sources = (Array.isArray(from) ? from : [from]) as readonly S[];
  for (const source of sources)
    if (!canMove(machine, source, to))
      throw new Error(`${machine.name}: ${source} cannot move to ${to}`);
  const columns = Object.keys(set);
  for (const column of columns)
    if (!IDENTIFIER.test(column)) throw new Error(`${machine.name}: invalid column ${column}`);
  const assignments = [machine.column, ...columns].map((column) => `${column}=?`).join(',');
  return db.run(
    `UPDATE ${machine.table} SET ${assignments} WHERE (${where.sql}) AND ${machine.column} IN (${sources.map(() => '?').join(',')})`,
    to,
    ...columns.map((column) => set[column]),
    ...(where.params ?? []),
    ...sources,
  ).changes;
}

/** Moves one row by id. Returns false when the row was not in `from`, which is how a lost race shows. */
export function advance<S extends string>(
  db: Db,
  machine: Machine<S>,
  rowId: string,
  from: S | readonly S[],
  to: S,
  set: Record<string, SqlValue> = {},
): boolean {
  return advanceWhere(db, machine, from, to, { sql: 'id=?', params: [rowId] }, set) === 1;
}
