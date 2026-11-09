import type { Role } from '../../roles.ts';
import { ACTIONS, actionByKey, roleAllows } from './actions.ts';
import type { ActionId } from './actions.ts';
import { sanitize } from './format.ts';
import { nodeReports } from './derive.ts';
import { PANE_IDS, selectionKey, visible } from './panes.ts';
import type { PaneId } from './panes.ts';
import type { Attention, Row, RowContext, Snapshot, Tone, ViewRef } from './types.ts';

/** The terminal rows used by the header (2), the message line and the key hints. */
export const CHROME_ROWS = 4;
export const LOG_LINES_MAX = 2000;

export type Mode = 'normal' | 'command' | 'filter' | 'confirm' | 'help' | 'pick';
export type LiveKind = 'logs' | 'shell' | 'inspect' | 'ps';

export interface Screen {
  kind: 'text' | 'logs';
  title: string;
  lines: string[];
  scroll: number;
  follow: boolean;
  filter: string;
  status: string;
}
export interface Picker {
  title: string;
  options: string[];
  index: number;
  next: { kind: LiveKind; project: string; service?: string };
}
export interface UiState {
  stack: ViewRef[];
  focus: PaneId;
  sel: Record<string, { key?: string; index: number }>;
  filter: string;
  mode: Mode;
  input: string;
  flash?: { text: string; tone: Tone; until: number };
  confirm?: { action: ActionId; context: RowContext; prompt: string };
  picker?: Picker;
  screen?: Screen;
  columns: number;
  rows: number;
  readonly: boolean;
  /** The project the config resolves to; the lists that belong to one project open on it. */
  defaultProject: string;
  now: number;
}

export interface Key {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
}
export type Input =
  | { type: 'key'; key: Key }
  | { type: 'resize'; columns: number; rows: number }
  | { type: 'tick'; now: number }
  | { type: 'logs.append'; lines: string[] }
  | { type: 'screen.status'; status: string }
  | { type: 'text.set'; lines: string[] }
  | { type: 'flash'; text: string; tone: Tone };
export type Effect =
  | { type: 'quit' }
  | { type: 'refresh' }
  | { type: 'load'; view: ViewRef }
  | { type: 'logs.open'; project: string; service: string; node: string }
  | { type: 'logs.close' }
  | { type: 'text.open'; op: 'inspect' | 'ps'; project: string; service?: string; node: string }
  | { type: 'text.close' }
  | { type: 'shell'; project: string; service: string; node: string }
  | { type: 'action'; action: ActionId; context: RowContext };
export interface Env {
  snapshot: Snapshot;
  attention: Attention[];
}

export function initialState(options: {
  columns: number;
  rows: number;
  readonly: boolean;
  defaultProject: string;
  now: number;
  view?: ViewRef;
}): UiState {
  return {
    stack: [{ name: 'overview' }, ...(options.view ? [options.view] : [])],
    focus: 'attention',
    sel: {},
    filter: '',
    mode: 'normal',
    input: '',
    columns: options.columns,
    rows: options.rows,
    readonly: options.readonly,
    defaultProject: options.defaultProject,
    now: options.now,
  };
}

export const top = (state: UiState): ViewRef => state.stack[state.stack.length - 1];

/** The canonical command names, in the order `:` completes them. */
export const COMMANDS = [
  'overview',
  'projects',
  'nodes',
  'services',
  'deployments',
  'events',
  'backups',
  'restores',
  'domains',
  'volumes',
  'secrets',
  'credentials',
  'help',
  'quit',
] as const;
const ALIASES: Record<string, string> = {
  q: 'quit',
  ev: 'events',
  dep: 'deployments',
  creds: 'credentials',
  svc: 'services',
  ov: 'overview',
  '?': 'help',
};

/** The command a typed prefix names, or undefined when it names none or several. */
export function resolveCommand(word: string): (typeof COMMANDS)[number] | undefined {
  const text = word.trim().toLowerCase();
  if (!text) return undefined;
  const alias = ALIASES[text];
  if (alias) return alias as (typeof COMMANDS)[number];
  const matches = COMMANDS.filter((name) => name.startsWith(text));
  return matches.length === 1 || matches[0] === text ? matches[0] : undefined;
}
/** Completion for the command line: the first command the typed text is a prefix of. */
export function completeCommand(input: string): string {
  const [word, ...rest] = input.split(' ');
  if (rest.length) return input;
  return COMMANDS.find((name) => name.startsWith(word.toLowerCase())) ?? input;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

function view(state: UiState, env: Env) {
  return visible(
    top(state),
    state.focus,
    state.filter,
    env.snapshot,
    state.now,
    env.attention,
    state.defaultProject,
  );
}
const selKey = (state: UiState): string => selectionKey(top(state), state.focus);

/** The index of the selected row: the remembered row if it is still there, else the remembered position, clamped. */
export function selectedIndex(
  rows: Row[],
  sel: { key?: string; index: number } | undefined,
): number {
  if (!rows.length) return 0;
  if (sel?.key !== undefined) {
    const found = rows.findIndex((row) => row.key === sel.key);
    if (found >= 0) return found;
  }
  return clamp(sel?.index ?? 0, 0, rows.length - 1);
}
export function selectedRow(state: UiState, env: Env): Row | undefined {
  const table = view(state, env).table;
  return table?.rows[selectedIndex(table.rows, state.sel[selKey(state)])];
}

const withSelection = (state: UiState, rows: Row[], index: number): UiState => {
  const i = clamp(index, 0, Math.max(0, rows.length - 1));
  return { ...state, sel: { ...state.sel, [selKey(state)]: { key: rows[i]?.key, index: i } } };
};
function moveSelection(
  state: UiState,
  env: Env,
  change: (index: number, count: number) => number,
): UiState {
  const rows = view(state, env).table?.rows ?? [];
  if (!rows.length) return state;
  return withSelection(
    state,
    rows,
    change(selectedIndex(rows, state.sel[selKey(state)]), rows.length),
  );
}

const flash = (state: UiState, text: string, tone: Tone = 'plain'): UiState => ({
  ...state,
  flash: { text, tone, until: state.now + (tone === 'error' ? 8000 : 4000) },
});

const pageSize = (state: UiState): number => Math.max(1, state.rows - CHROME_ROWS - 3);

/** The selected row's context, completed from the view the screen is in (a project view knows its project). */
export function contextOf(state: UiState, env: Env): RowContext {
  const row = selectedRow(state, env);
  const ref = top(state);
  const fromView: RowContext =
    ref.name === 'placement'
      ? { project: ref.project, service: ref.service, node: ref.node }
      : ref.name === 'project' ||
          ref.name === 'deployments' ||
          ref.name === 'backups' ||
          ref.name === 'events' ||
          ref.name === 'restores' ||
          ref.name === 'services'
        ? { project: ref.project }
        : ref.name === 'node'
          ? { node: ref.node }
          : {};
  return { ...stripUndefined(fromView), ...stripUndefined(row?.context ?? {}) };
}
const stripUndefined = <T extends object>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;

/** Nodes that report the service (or, with no service, the project). */
function hosts(env: Env, project: string, service?: string): string[] {
  const status = env.snapshot.status.data;
  if (!status) return [];
  return [
    ...new Set(
      nodeReports(status)
        .filter(
          (report) =>
            report.project === project &&
            (!service || report.services.some((item) => item.name === service)),
        )
        .map((report) => report.node),
    ),
  ].sort();
}

function startLive(
  state: UiState,
  env: Env,
  kind: LiveKind,
): { state: UiState; effects: Effect[] } {
  const context = contextOf(state, env);
  const needsService = kind !== 'ps';
  if (!context.project || (needsService && !context.service))
    return {
      state: flash(
        state,
        needsService ? 'select a service first' : 'select a project first',
        'warn',
      ),
      effects: [],
    };
  const role = env.snapshot.whoami.data?.role;
  if (!roleAllows(role, 'deploy'))
    return {
      state: flash(state, `${kind} needs the deploy role; this credential is ${role}`, 'warn'),
      effects: [],
    };
  if (kind === 'shell' && state.readonly)
    return { state: flash(state, 'read-only mode: shell is disabled', 'warn'), effects: [] };
  const candidates = context.node ? [context.node] : hosts(env, context.project, context.service);
  if (!candidates.length)
    return { state: flash(state, 'no node reports this service yet', 'warn'), effects: [] };
  if (candidates.length > 1)
    return {
      state: {
        ...state,
        mode: 'pick',
        picker: {
          title: `Which node? (${kind})`,
          options: candidates,
          index: 0,
          next: { kind, project: context.project, service: context.service },
        },
      },
      effects: [],
    };
  return launch(state, { kind, project: context.project, service: context.service }, candidates[0]);
}

function launch(
  state: UiState,
  next: { kind: LiveKind; project: string; service?: string },
  node: string,
): { state: UiState; effects: Effect[] } {
  const label = next.service
    ? `${next.project}/${next.service}@${node}`
    : `${next.project}@${node}`;
  if (next.kind === 'shell')
    return {
      state,
      effects: [{ type: 'shell', project: next.project, service: next.service!, node }],
    };
  if (next.kind === 'logs')
    return {
      state: {
        ...state,
        screen: {
          kind: 'logs',
          title: `logs ${label}`,
          lines: [],
          scroll: 0,
          follow: true,
          filter: '',
          status: 'connecting…',
        },
      },
      effects: [{ type: 'logs.open', project: next.project, service: next.service!, node }],
    };
  return {
    state: {
      ...state,
      screen: {
        kind: 'text',
        title: `${next.kind} ${label}`,
        lines: ['Loading…'],
        scroll: 0,
        follow: false,
        filter: '',
        status: '',
      },
    },
    effects: [
      { type: 'text.open', op: next.kind, project: next.project, service: next.service, node },
    ],
  };
}

function push(state: UiState, ref: ViewRef): { state: UiState; effects: Effect[] } {
  const listed = ['domains', 'volumes', 'secrets', 'credentials'].includes(ref.name);
  return {
    state: { ...state, stack: [...state.stack, ref], filter: '' },
    effects: listed ? [{ type: 'load', view: ref }] : [],
  };
}

function runCommand(state: UiState, env: Env, line: string): { state: UiState; effects: Effect[] } {
  const [word, arg] = line.trim().split(/\s+/);
  const name = resolveCommand(word ?? '');
  const base = { ...state, mode: 'normal' as Mode, input: '' };
  if (!word) return { state: base, effects: [] };
  if (!name) return { state: flash(base, `unknown command :${word}`, 'error'), effects: [] };
  if (name === 'quit') return { state: base, effects: [{ type: 'quit' }] };
  if (name === 'help') return { state: { ...base, mode: 'help' }, effects: [] };
  const project = arg || contextOf(base, env).project || state.defaultProject;
  const ref: ViewRef =
    name === 'overview'
      ? { name }
      : {
          name: name as ViewRef['name'],
          ...(arg || ['domains', 'volumes', 'secrets'].includes(name) ? { project } : {}),
        };
  const next = {
    ...base,
    stack: [{ name: 'overview' } as ViewRef, ...(ref.name === 'overview' ? [] : [ref])],
    filter: '',
  };
  return {
    state: next,
    effects: ['domains', 'volumes', 'secrets', 'credentials'].includes(ref.name)
      ? [{ type: 'load', view: ref }]
      : [],
  };
}

const printable = (key: Key): string | undefined =>
  key.sequence &&
  key.sequence.length === 1 &&
  !key.ctrl &&
  !key.meta &&
  key.sequence >= ' ' &&
  key.sequence !== '\x7f'
    ? key.sequence
    : undefined;

function editLine(value: string, key: Key): string | undefined {
  if (key.name === 'backspace') return value.slice(0, -1);
  if (key.ctrl && key.name === 'u') return '';
  const ch = printable(key);
  return ch === undefined ? undefined : value + ch;
}

function screenLines(screen: Screen): string[] {
  const needle = screen.filter.toLowerCase();
  return needle ? screen.lines.filter((line) => line.toLowerCase().includes(needle)) : screen.lines;
}
export const screenHeight = (state: UiState): number => Math.max(1, state.rows - CHROME_ROWS - 1);
/** First visible line of a screen: pinned to the end while following. */
export function screenTop(screen: Screen, height: number): number {
  const bottom = Math.max(0, screenLines(screen).length - height);
  return screen.follow ? bottom : clamp(screen.scroll, 0, bottom);
}
export { screenLines };

function scrollScreen(
  state: UiState,
  change: (top: number, height: number, bottom: number) => number,
): UiState {
  const screen = state.screen!;
  const height = screenHeight(state);
  const bottom = Math.max(0, screenLines(screen).length - height);
  const next = clamp(change(screenTop(screen, height), height, bottom), 0, bottom);
  return {
    ...state,
    screen: { ...screen, scroll: next, follow: screen.kind === 'logs' && next >= bottom },
  };
}

function screenKey(state: UiState, key: Key): { state: UiState; effects: Effect[] } {
  const screen = state.screen!;
  const close = (): { state: UiState; effects: Effect[] } => ({
    state: { ...state, screen: undefined, mode: 'normal', input: '' },
    effects: [{ type: screen.kind === 'logs' ? 'logs.close' : 'text.close' }],
  });
  const ch = printable(key);
  if (key.name === 'escape' || ch === 'q') return close();
  const result = (next: UiState) => ({ state: next, effects: [] as Effect[] });
  if (key.name === 'up' || ch === 'k') return result(scrollScreen(state, (t) => t - 1));
  if (key.name === 'down' || ch === 'j') return result(scrollScreen(state, (t) => t + 1));
  if (key.name === 'pageup') return result(scrollScreen(state, (t, h) => t - h + 1));
  if (key.name === 'pagedown' || (ch === ' ' && screen.kind === 'text'))
    return result(scrollScreen(state, (t, h) => t + h - 1));
  if (key.name === 'home' || ch === 'g') return result(scrollScreen(state, () => 0));
  if (key.name === 'end' || ch === 'G')
    return result(scrollScreen(state, (_t, _h, bottom) => bottom));
  if (screen.kind === 'logs') {
    if (ch === ' ' || ch === 'f')
      return result({
        ...state,
        screen: {
          ...screen,
          follow: !screen.follow,
          scroll: screenTop(screen, screenHeight(state)),
        },
      });
    if (ch === 'c') return result({ ...state, screen: { ...screen, lines: [], scroll: 0 } });
    if (ch === '/') return result({ ...state, mode: 'filter', input: screen.filter });
  }
  return result(state);
}

/** Pure state transition: the next state and what the runtime must do about it. */
export function reduce(
  state: UiState,
  input: Input,
  env: Env,
): { state: UiState; effects: Effect[] } {
  const none = (next: UiState) => ({ state: next, effects: [] as Effect[] });
  switch (input.type) {
    case 'resize':
      return none({ ...state, columns: input.columns, rows: input.rows });
    case 'tick':
      return none({
        ...state,
        now: input.now,
        ...(state.flash && state.flash.until <= input.now && { flash: undefined }),
      });
    case 'flash':
      return none(flash(state, input.text, input.tone));
    case 'text.set':
      return none(
        state.screen?.kind === 'text'
          ? { ...state, screen: { ...state.screen, lines: input.lines, scroll: 0 } }
          : state,
      );
    case 'screen.status':
      return none(
        state.screen ? { ...state, screen: { ...state.screen, status: input.status } } : state,
      );
    case 'logs.append': {
      if (state.screen?.kind !== 'logs') return none(state);
      const lines = [...state.screen.lines, ...input.lines];
      return none({
        ...state,
        screen: {
          ...state.screen,
          lines: lines.length > LOG_LINES_MAX ? lines.slice(-LOG_LINES_MAX) : lines,
        },
      });
    }
    case 'key':
      break;
  }
  const key = input.key;
  if (key.ctrl && key.name === 'c') return { state, effects: [{ type: 'quit' }] };
  const ch = printable(key);

  if (state.mode === 'help') return none({ ...state, mode: 'normal' });

  if (state.mode === 'confirm') {
    const pending = state.confirm!;
    const cleared = { ...state, mode: 'normal' as Mode, confirm: undefined };
    if (ch === 'y' || ch === 'Y')
      return {
        state: flash(cleared, `${pending.action}…`),
        effects: [{ type: 'action', action: pending.action, context: pending.context }],
      };
    return none(flash(cleared, 'cancelled; nothing was changed'));
  }

  if (state.mode === 'pick') {
    const picker = state.picker!;
    if (key.name === 'escape' || ch === 'q')
      return none({ ...state, mode: 'normal', picker: undefined });
    if (key.name === 'up' || ch === 'k')
      return none({ ...state, picker: { ...picker, index: Math.max(0, picker.index - 1) } });
    if (key.name === 'down' || ch === 'j')
      return none({
        ...state,
        picker: { ...picker, index: Math.min(picker.options.length - 1, picker.index + 1) },
      });
    if (key.name === 'return')
      return launch(
        { ...state, mode: 'normal', picker: undefined },
        picker.next,
        picker.options[picker.index],
      );
    return none(state);
  }

  if (state.mode === 'command') {
    if (key.name === 'escape') return none({ ...state, mode: 'normal', input: '' });
    if (key.name === 'return') return runCommand(state, env, state.input);
    if (key.name === 'tab') return none({ ...state, input: completeCommand(state.input) });
    const edited = editLine(state.input, key);
    return none(edited === undefined ? state : { ...state, input: edited });
  }

  if (state.mode === 'filter') {
    const toScreen = Boolean(state.screen);
    const apply = (value: string, mode: Mode): UiState =>
      toScreen
        ? { ...state, mode, input: '', screen: { ...state.screen!, filter: value } }
        : { ...state, mode, input: '', filter: value };
    if (key.name === 'escape') return none(apply('', 'normal'));
    if (key.name === 'return') return none(apply(state.input, 'normal'));
    const edited = editLine(state.input, key);
    if (edited === undefined) return none(state);
    return none(
      toScreen
        ? { ...state, input: edited, screen: { ...state.screen!, filter: edited } }
        : { ...state, input: edited, filter: edited },
    );
  }

  if (state.screen) return screenKey(state, key);

  // Normal mode.
  if (key.name === 'escape') {
    if (state.filter) return none({ ...state, filter: '' });
    if (state.stack.length > 1)
      return none({ ...state, stack: state.stack.slice(0, -1), filter: '' });
    return none(state);
  }
  if (ch === 'q') return { state, effects: [{ type: 'quit' }] };
  if (ch === ':') return none({ ...state, mode: 'command', input: '' });
  if (ch === '/') return none({ ...state, mode: 'filter', input: state.filter });
  if (ch === '?') return none({ ...state, mode: 'help' });
  if (key.ctrl && key.name === 'r')
    return { state: flash(state, 'refreshing…'), effects: [{ type: 'refresh' }] };
  if (key.name === 'tab' && top(state).name === 'overview') {
    const step = key.shift ? PANE_IDS.length - 1 : 1;
    return none({
      ...state,
      focus: PANE_IDS[(PANE_IDS.indexOf(state.focus) + step) % PANE_IDS.length],
      filter: '',
    });
  }
  if (key.name === 'up' || ch === 'k') return none(moveSelection(state, env, (i) => i - 1));
  if (key.name === 'down' || ch === 'j') return none(moveSelection(state, env, (i) => i + 1));
  if (key.name === 'pageup') return none(moveSelection(state, env, (i) => i - pageSize(state)));
  if (key.name === 'pagedown') return none(moveSelection(state, env, (i) => i + pageSize(state)));
  if (key.name === 'home' || ch === 'g') return none(moveSelection(state, env, () => 0));
  if (key.name === 'end' || ch === 'G')
    return none(moveSelection(state, env, (_i, count) => count - 1));
  if (key.name === 'return') {
    const row = selectedRow(state, env);
    if (!row?.open) return none(state);
    return push(state, row.open);
  }
  if (ch === 'e') {
    const project = contextOf(state, env).project;
    return push(state, project ? { name: 'events', project } : { name: 'events' });
  }
  if (ch === 'd') {
    const row = selectedRow(state, env);
    if (!row?.record) return none(flash(state, 'nothing to describe here', 'warn'));
    const lines = (JSON.stringify(row.record, null, 2) ?? '').split('\n').map(sanitize);
    return none({
      ...state,
      screen: {
        kind: 'text',
        title: `describe ${row.key}`,
        lines,
        scroll: 0,
        follow: false,
        filter: '',
        status: '',
      },
    });
  }
  if (ch === 'l') return startLive(state, env, 'logs');
  if (ch === 's') return startLive(state, env, 'shell');
  if (ch === 'i') return startLive(state, env, 'inspect');
  if (ch === 'p') return startLive(state, env, 'ps');
  const action = ch ? actionByKey(ch) : undefined;
  if (action) {
    if (state.readonly)
      return none(flash(state, `read-only mode: ${action.label} is disabled`, 'warn'));
    const role: Role | undefined = env.snapshot.whoami.data?.role;
    if (!roleAllows(role, action.role))
      return none(
        flash(
          state,
          `${action.label} needs the ${action.role} role; this credential is ${role}`,
          'warn',
        ),
      );
    const context = contextOf(state, env);
    const reason = action.unavailable(context);
    if (reason) return none(flash(state, reason, 'warn'));
    return none({
      ...state,
      mode: 'confirm',
      confirm: { action: action.id, context, prompt: action.prompt(context) },
    });
  }
  return none(state);
}

/** Keys the footer offers for the current view and role: only what would work. */
export function hints(state: UiState, env: Env): string[] {
  const role = env.snapshot.whoami.data?.role;
  const base = [':view', '/ filter', 'enter open', 'e events', 'd describe'];
  const live = roleAllows(role, 'deploy')
    ? ['l logs', 'i inspect', 'p ps', ...(state.readonly ? [] : ['s shell'])]
    : [];
  const acts =
    state.readonly || !roleAllows(role, 'deploy')
      ? []
      : ACTIONS.map((action) => `${action.key} ${action.label}`);
  return ['? help', 'q quit', ...base, ...live, ...acts];
}
