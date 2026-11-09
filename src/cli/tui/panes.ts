import { ageOf, sanitize } from './format.ts';
import { contentFor, eventsTable, filterTable } from './tables.ts';
import type { Content } from './tables.ts';
import type { Attention, Row, Snapshot, Table, ViewRef } from './types.ts';

export const PANE_IDS = ['attention', 'projects', 'nodes', 'events'] as const;
export type PaneId = (typeof PANE_IDS)[number];
export interface Pane {
  id: PaneId;
  title: string;
  table: Table;
}

const ICON = { error: '✖', warn: '▲', info: '·' } as const;

export function attentionTable(items: Attention[], now: number, waiting = false): Table {
  const rows: Row[] = items.map((item) => ({
    key: item.key,
    cells: [
      item.rank === 1 ? ICON.error : item.rank === 4 ? ICON.info : ICON.warn,
      sanitize(item.subject),
      sanitize(item.reason),
      item.since ? ageOf(item.since, now) : '',
    ],
    tone: item.rank === 1 ? 'error' : item.rank === 4 ? 'dim' : 'warn',
    open: item.target,
    context: item.context,
    record: item,
  }));
  return {
    columns: ['', 'WHAT', 'WHY', 'AGE'],
    primary: 2,
    rows,
    empty: waiting ? 'Waiting for the control plane…' : 'Nothing needs attention',
  };
}

/** The four overview panes, in tab order. Only the focused pane takes the filter. */
export function overviewPanes(
  snapshot: Snapshot,
  now: number,
  attention: Attention[],
  focusId: PaneId,
  filter: string,
): Pane[] {
  const tables: Record<PaneId, Table> = {
    attention: attentionTable(
      attention,
      now,
      !snapshot.status.data && snapshot.status.error === undefined,
    ),
    projects: contentFor({ name: 'projects' }, snapshot, now, '').table!,
    nodes: contentFor({ name: 'nodes' }, snapshot, now, '').table!,
    events: eventsTable(snapshot, now, undefined, 50),
  };
  const titles: Record<PaneId, string> = {
    attention: `Attention${attention.length ? ` (${attention.length})` : ''}`,
    projects: 'Projects',
    nodes: 'Nodes',
    events: 'Events',
  };
  return PANE_IDS.map((id) => ({
    id,
    title: titles[id],
    table: id === focusId ? filterTable(tables[id], filter) : tables[id],
  }));
}

/** Key under which a table's selection is remembered. */
export const selectionKey = (ref: ViewRef, focusId: PaneId): string =>
  ref.name === 'overview'
    ? `overview:${focusId}`
    : `view:${ref.name}:${ref.project ?? ''}:${ref.service ?? ''}:${ref.node ?? ''}`;

export interface Visible {
  content: Content;
  table?: Table;
  panes?: Pane[];
}
/** What the top view shows, with the filter applied to the table the keys act on. */
export function visible(
  ref: ViewRef,
  focusId: PaneId,
  filter: string,
  snapshot: Snapshot,
  now: number,
  attention: Attention[],
  defaultProject: string,
): Visible {
  const content = contentFor(ref, snapshot, now, defaultProject);
  if (ref.name === 'overview') {
    const panes = overviewPanes(snapshot, now, attention, focusId, filter);
    return { content, panes, table: panes.find((pane) => pane.id === focusId)!.table };
  }
  return { content, table: content.table && filterTable(content.table, filter) };
}

/**
 * Splits the body height among the overview panes. Each pane needs a title, a header and at least one row. Panes are
 * admitted in priority order (attention, the focused pane, then the rest in tab order) while they fit; the space left
 * grows the admitted panes up to what their rows need, and anything still left goes to events, or to the focused pane
 * when events are not shown. Panes are returned in tab order.
 */
export function allocate(
  panes: Pane[],
  height: number,
  focusId: PaneId,
): { pane: Pane; height: number }[] {
  const MIN = 3;
  const by = (id: PaneId) => panes.find((pane) => pane.id === id)!;
  const want = (id: PaneId): number =>
    2 + Math.max(1, Math.min(by(id).table.rows.length, id === 'attention' ? 6 : 8));
  const priority = (['attention', focusId, ...PANE_IDS] as PaneId[]).filter(
    (id, i, all) => all.indexOf(id) === i,
  );
  const chosen: PaneId[] = [];
  for (const id of priority) if ((chosen.length + 1) * MIN <= height) chosen.push(id);
  const sizes = new Map(chosen.map((id) => [id, MIN]));
  let spare = height - chosen.length * MIN;
  for (const id of chosen) {
    const add = Math.min(spare, want(id) - MIN);
    sizes.set(id, sizes.get(id)! + add);
    spare -= add;
  }
  if (spare > 0) {
    const sink = chosen.includes('events') ? 'events' : focusId;
    sizes.set(sink, (sizes.get(sink) ?? MIN) + spare);
  }
  return PANE_IDS.filter((id) => sizes.has(id)).map((id) => ({
    pane: by(id),
    height: sizes.get(id)!,
  }));
}
