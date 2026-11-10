import type { Role } from '../roles.ts';

/** The parts of an event row that can carry a one-off command line. */
export interface RedactableEvent {
  type: string;
  message: string;
  metadata_json: string | null;
}

/**
 * What a caller of this role may read of an audit event. A `job.run` event records the command line of the one-off
 * container (`tug run`), which can hold a secret typed as an argument, so a `read` credential sees the event without
 * it. `deploy` and `admin` keep seeing the command: they can already `exec` into the workload and read its secrets, so
 * hiding it from them protects nothing. The row itself is stored in full, which keeps the audit trail intact.
 */
export function eventForRole<T extends RedactableEvent>(event: T, role: Role): T {
  if (role !== 'read' || event.type !== 'job.run') return event;
  let metadata: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(event.metadata_json ?? '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      metadata = parsed as Record<string, unknown>;
  } catch {
    // an unreadable record has nothing to keep
  }
  const { command: _command, ...kept } = metadata;
  // The message is `<actor> ran a one-off <service> container on <node>: <command>`; the node ends the part to keep.
  const marker = typeof kept.node === 'string' ? ` container on ${kept.node}` : undefined;
  const end = marker ? event.message.indexOf(marker) : -1;
  const message =
    end >= 0
      ? event.message.slice(0, end + (marker as string).length)
      : event.message.replace(/:\s[\s\S]*$/, '');
  return { ...event, message, metadata_json: JSON.stringify(kept) };
}
