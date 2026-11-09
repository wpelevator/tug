import { columnWidth } from '../width.ts';
import { deriveCounters } from './derive.ts';
import { fit, sanitize } from './format.ts';
import type { Style } from './format.ts';
import { allocate, selectionKey, visible } from './panes.ts';
import type { Pane } from './panes.ts';
import {
  CHROME_ROWS,
  hints,
  screenHeight,
  screenLines,
  screenTop,
  selectedIndex,
  top,
} from './state.ts';
import type { Env, UiState } from './state.ts';
import type { Table, Tone } from './types.ts';

export interface RenderOptions {
  style: Style;
  /** Short name of the control plane: the host of the credential's URL. */
  controlLabel: string;
  cliVersion: string;
}

const GAP = 2;

/** Column widths for a table that must fit `width` columns: natural widths, the widest columns shrinking first. */
export function columnWidths(table: Table, width: number): number[] {
  const widths = table.columns.map((name, i) =>
    Math.max(columnWidth(name), ...table.rows.map((row) => columnWidth(row.cells[i] ?? ''))),
  );
  const primary =
    table.primary === undefined
      ? -1
      : table.primary < 0
        ? table.columns.length + table.primary
        : table.primary;
  const natural = [...widths];
  const header = table.columns.map((name) => Math.max(columnWidth(name), 6));
  const total = () => widths.reduce((sum, w) => sum + w, 0) + GAP * (widths.length - 1);
  /** Shrinks the widest of `candidates` one column at a time until the table fits or none can go below its floor. */
  const shrink = (candidates: number[], floor: (i: number) => number): void => {
    while (total() > width) {
      let widest = -1;
      for (const i of candidates)
        if (widths[i] > floor(i) && (widest < 0 || widths[i] > widths[widest])) widest = i;
      if (widest < 0) return;
      widths[widest] -= 1;
    }
  };
  const others = widths.map((_, i) => i).filter((i) => i !== primary);
  const all = widths.map((_, i) => i);
  // The column that carries the reason shrinks last: the others give way first (to a readable floor), then it does,
  // and only on a very narrow terminal does anything go down to its header width.
  shrink(others, (i) => Math.min(natural[i], Math.max(header[i], 14)));
  if (primary >= 0) shrink([primary], (i) => Math.min(natural[i], 24));
  shrink(all, (i) => Math.min(natural[i], header[i]));
  return widths;
}

function tableLines(
  table: Table,
  width: number,
  height: number,
  selected: number,
  focused: boolean,
  style: Style,
): string[] {
  if (height <= 0) return [];
  const widths = columnWidths(table, width);
  const join = (cells: string[]) =>
    cells.map((value, i) => fit(value, widths[i])).join(' '.repeat(GAP));
  const lines = [style.dim(fit(join(table.columns), width))];
  const room = height - 1;
  if (!table.rows.length) {
    if (room > 0) lines.push(style.dim(fit(table.empty, width)));
    return lines;
  }
  const first = selected < room ? 0 : selected - room + 1;
  table.rows.slice(first, first + room).forEach((row, offset) => {
    const text = fit(join(row.cells), width);
    lines.push(
      focused && first + offset === selected
        ? style.inverse(text)
        : style.tone(row.tone as Tone | undefined, text),
    );
  });
  return lines;
}

const rule = (title: string, width: number, style: Style, focused: boolean, extra = ''): string => {
  const label = ` ${title}${extra ? ` ${extra}` : ''} `;
  const plain = `─${label}`;
  const text = fit(plain + '─'.repeat(Math.max(0, width - columnWidth(plain))), width);
  return focused ? style.bold(text) : style.dim(text);
};

/** Parts of a line with their own tone, laid out between a left and a right edge. */
interface Part {
  text: string;
  tone?: Tone;
  bold?: boolean;
}
function spread(left: Part[], right: Part[], width: number, style: Style): string {
  const paint = (parts: Part[]) =>
    parts
      .map((part) =>
        part.bold ? style.bold(style.tone(part.tone, part.text)) : style.tone(part.tone, part.text),
      )
      .join('');
  const widthOf = (parts: Part[]) => parts.reduce((sum, part) => sum + columnWidth(part.text), 0);
  const gap = Math.max(1, width - widthOf(left) - widthOf(right));
  if (widthOf(left) + widthOf(right) + 1 > width) {
    // Too narrow for both edges: drop the right edge, then clip the left.
    const plain = left.map((part) => part.text).join('');
    return fit(plain, width);
  }
  return paint(left) + ' '.repeat(gap) + paint(right);
}

function header(state: UiState, env: Env, options: RenderOptions): string[] {
  const { style } = options;
  const width = state.columns;
  const snapshot = env.snapshot;
  const who = snapshot.whoami.data;
  const version = snapshot.version.data;
  const status = snapshot.status;
  const age = status.fetchedAt
    ? Math.max(0, Math.round((state.now - status.fetchedAt) / 1000))
    : undefined;
  const connection: Part =
    status.error !== undefined
      ? { text: `◌ disconnected${age !== undefined ? ` · data ${age}s old` : ''}`, tone: 'error' }
      : age === undefined
        ? { text: '○ connecting', tone: 'dim' }
        : snapshot.watch.connected
          ? { text: '● live · push', tone: 'ok' }
          : { text: `● live ${age}s`, tone: age > 15 ? 'warn' : 'ok' };
  const skew = version && version !== options.cliVersion ? ` (cli ${options.cliVersion})` : '';
  const first = spread(
    [
      { text: ' tug', bold: true },
      { text: `  ${sanitize(options.controlLabel)}` },
      ...(version ? [{ text: `  v${version}${skew}`, tone: (skew ? 'warn' : 'dim') as Tone }] : []),
      ...(who
        ? [
            {
              text: `  ${who.role}${who.projects ? ` (${who.projects.join(',')})` : ''}`,
              tone: 'dim' as Tone,
            },
          ]
        : []),
      ...(state.readonly ? [{ text: '  read-only', tone: 'warn' as Tone }] : []),
    ],
    [connection, { text: '  ' }],
    width,
    style,
  );
  const counters = deriveCounters(snapshot, state.now, env.attention);
  const parts: Part[] = [
    {
      text: ` Nodes ${counters.nodesOnline}/${counters.nodesTotal} online`,
      tone: counters.nodesTotal && counters.nodesOnline < counters.nodesTotal ? 'warn' : 'plain',
    },
    { text: `   Projects ${counters.projects}` },
    {
      text: `   Services ${counters.servicesServing}/${counters.servicesTotal} serving`,
      tone: counters.servicesServing < counters.servicesTotal ? 'error' : 'plain',
    },
    {
      text: counters.backupProblems
        ? `   Backups ${counters.backupProblems} problem${counters.backupProblems === 1 ? '' : 's'}`
        : '   Backups ok',
      tone: counters.backupProblems ? 'warn' : 'plain',
    },
    {
      text: `   Events ${counters.eventErrors} error · ${counters.eventWarnings} warn`,
      tone: counters.eventErrors ? 'error' : counters.eventWarnings ? 'warn' : 'plain',
    },
  ];
  const plain = parts.map((part) => part.text).join('');
  const second =
    columnWidth(plain) > width
      ? fit(plain, width)
      : parts.map((part) => style.tone(part.tone, part.text)).join('');
  return [first, second];
}

const HELP = [
  'Navigation',
  '  up/down, j/k       move        pgup/pgdn  page        g/G  first/last',
  '  enter              open the row          esc  go back, or clear the filter',
  '  tab / shift-tab    next pane (overview)',
  '  :name [project]    jump to a view: overview projects nodes services deployments',
  '                     events backups restores domains volumes secrets credentials',
  '  /text              filter rows: word, !word to exclude, column=word for one column',
  '',
  'Inspect',
  '  e   events of the selected project      d   describe the row as JSON',
  '  l   follow logs   i   inspect the container   p   list project containers',
  '  s   shell in the container (needs the deploy role; not in read-only mode)',
  '',
  'Act (each asks first; needs the deploy role; not in read-only mode)',
  '  r   restart the service        R   roll the project back',
  '  x   cancel the active deployment   b   back up now',
  '',
  'Logs view: space or f follow/pause, / filter, c clear, g/G top/bottom, esc close',
  'Other: ctrl-r poll now, ? this help, q quit, ctrl-c quit anywhere',
  '',
  'Press any key to close this help.',
];

function bodyLines(state: UiState, env: Env, options: RenderOptions): string[] {
  const { style } = options;
  const width = state.columns;
  const height = Math.max(1, state.rows - CHROME_ROWS);
  if (state.mode === 'help') return HELP.map((line) => fit(line, width));
  if (state.mode === 'pick' && state.picker) {
    const { picker } = state;
    return [
      rule(picker.title, width, style, true),
      ...picker.options.map((option, index) =>
        index === picker.index ? style.inverse(fit(` ${option}`, width)) : fit(` ${option}`, width),
      ),
      '',
      style.dim(fit(' up/down choose, enter select, esc cancel', width)),
    ];
  }
  if (state.screen) {
    const { screen } = state;
    const lines = screenLines(screen);
    const rows = screenHeight(state);
    const first = screenTop(screen, rows);
    const extra = [
      screen.status,
      screen.filter && `/${screen.filter}`,
      screen.kind === 'logs' ? (screen.follow ? 'following' : 'paused') : '',
    ]
      .filter(Boolean)
      .join(' · ');
    return [
      rule(screen.title, width, style, true, extra ? `· ${extra}` : ''),
      ...lines.slice(first, first + rows).map((line) => fit(sanitize(line), width)),
    ];
  }
  const ref = top(state);
  const shown = visible(
    ref,
    state.focus,
    state.filter,
    env.snapshot,
    state.now,
    env.attention,
    state.defaultProject,
  );
  const selection = (key: string, rows: Table['rows']) => selectedIndex(rows, state.sel[key]);
  if (shown.panes) {
    return allocate(shown.panes, height, state.focus).flatMap(
      ({ pane, height: room }: { pane: Pane; height: number }) => {
        const focused = pane.id === state.focus;
        return [
          rule(
            pane.title,
            width,
            style,
            focused,
            focused && state.filter ? `/${state.filter}` : '',
          ),
          ...tableLines(
            pane.table,
            width,
            room - 1,
            selection(selectionKey(ref, pane.id), pane.table.rows),
            focused,
            style,
          ),
        ];
      },
    );
  }
  const crumbs = state.stack
    .map(
      (item) =>
        visible(item, state.focus, '', env.snapshot, state.now, env.attention, state.defaultProject)
          .content.crumb,
    )
    .join(' › ');
  const lines = [rule(crumbs, width, style, true, state.filter ? `/${state.filter}` : '')];
  for (const intro of shown.content.intro) lines.push(fit(` ${intro}`, width));
  const room = height - lines.length;
  if (shown.table)
    lines.push(
      ...tableLines(
        shown.table,
        width,
        room,
        selection(selectionKey(ref, state.focus), shown.table.rows),
        true,
        style,
      ),
    );
  else if (shown.content.lines)
    lines.push(
      ...shown.content.lines
        .slice(0, Math.max(0, room))
        .map((line) => fit(` ${sanitize(line)}`, width)),
    );
  return lines;
}

function messageLine(state: UiState, options: RenderOptions): string {
  const { style } = options;
  const width = state.columns;
  if (state.mode === 'command') return fit(`:${state.input}▏`, width);
  if (state.mode === 'filter') return fit(`/${state.input}▏`, width);
  if (state.mode === 'confirm' && state.confirm)
    return style.bold(style.tone('warn', fit(` ${state.confirm.prompt} [y/N]`, width)));
  if (state.flash && state.flash.until > state.now)
    return style.tone(state.flash.tone, fit(` ${sanitize(state.flash.text)}`, width));
  return '';
}

/** One full frame, exactly `state.rows` lines of at most `state.columns` columns each. */
export function render(state: UiState, env: Env, options: RenderOptions): string[] {
  const body = bodyLines(state, env, options).slice(0, Math.max(1, state.rows - CHROME_ROWS));
  const room = Math.max(1, state.rows - CHROME_ROWS);
  while (body.length < room) body.push('');
  const hintText =
    state.mode === 'help'
      ? ''
      : state.screen
        ? state.screen.kind === 'logs'
          ? ' esc close  space follow/pause  / filter  c clear  g/G top/bottom'
          : ' esc close  up/down scroll  g/G top/bottom'
        : ` ${hints(state, env).join('  ')}`;
  return [
    ...header(state, env, options),
    ...body,
    messageLine(state, options),
    options.style.dim(fit(hintText, state.columns)),
  ].slice(0, state.rows);
}
