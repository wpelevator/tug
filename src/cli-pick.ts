import readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';

export interface PickIO {
  input: Readable & {
    setRawMode?: (mode: boolean) => unknown;
    ref?: () => unknown;
    unref?: () => unknown;
  };
  output: Writable & { columns?: number; rows?: number };
}

/** Keyboard menus: `one` returns the chosen index, `many` the chosen indexes in list order. */
export interface Picker {
  one(question: string, labels: readonly string[], initial?: number): Promise<number>;
  many(question: string, labels: readonly string[]): Promise<number[]>;
}

export const CANCELLED = 'cancelled; nothing was changed';

const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const ERASE_BELOW = '\r\x1b[J';

/** A label is one line of plain text: control characters would break the cursor arithmetic or inject escapes. */
// eslint-disable-next-line no-control-regex
const plain = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');

/**
 * A menu drawn in place on `output` and driven by keypresses on `input`: arrows or j/k move, a digit jumps to that
 * entry, space toggles (or picks, in a single-choice menu), `a` toggles all, Enter confirms, and q, Esc or Ctrl-C cancel.
 * Nothing is preselected and a multi-choice menu cannot be confirmed empty, so Enter alone never picks a target.
 */
function pick(
  io: PickIO,
  question: string,
  labels: readonly string[],
  multiple: boolean,
  initial: number,
): Promise<number[]> {
  const { input, output } = io;
  const entries = labels.map(plain);
  const chosen = new Set<number>();
  let cursor = Math.min(Math.max(initial, 0), entries.length - 1);
  let top = 0;
  let note = '';
  let drawn = 0;
  const hint = multiple ? 'space select, a all, enter done, q cancel' : 'enter select, q cancel';
  const width = () => Math.max(20, (output.columns ?? 80) - 1);
  const clip = (text: string) => (text.length > width() ? `${text.slice(0, width() - 1)}…` : text);
  const pageSize = () => Math.max(3, Math.min(entries.length, (output.rows ?? 24) - 4));

  const erase = () => {
    output.write(`${drawn ? `\x1b[${drawn}A` : ''}${ERASE_BELOW}`);
    drawn = 0;
  };
  const render = () => {
    const size = pageSize();
    if (cursor < top) top = cursor;
    if (cursor >= top + size) top = cursor - size + 1;
    const last = Math.min(top + size, entries.length);
    const lines = [clip(plain(question)), clip(`  (${hint})`)];
    for (let i = top; i < last; i++)
      lines.push(
        clip(
          `${i === cursor ? '>' : ' '} ${multiple ? (chosen.has(i) ? '[x] ' : '[ ] ') : ''}${entries[i]}`,
        ),
      );
    if (entries.length > size) lines.push(clip(`  ${top + 1}-${last} of ${entries.length}`));
    if (note) lines.push(clip(note));
    erase();
    output.write(`${lines.join('\n')}\n`);
    drawn = lines.length;
  };

  return new Promise<number[]>((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | undefined, indexes: number[] = []) => {
      if (settled) return;
      settled = true;
      input.off('keypress', onKey);
      input.off('end', onEnd);
      input.off('error', onError);
      input.setRawMode?.(false);
      input.pause();
      // A paused stdin can keep its handle reading after a later consumer resumed it; never let a finished menu hold the process open.
      input.unref?.();
      erase();
      output.write(SHOW_CURSOR);
      if (error) return reject(error);
      output.write(`${plain(question)}: ${indexes.map((i) => entries[i]).join(', ')}\n`);
      resolve(indexes);
    };
    const confirm = () => {
      if (multiple && !chosen.size) {
        note = 'Select at least one entry with space, or press q to cancel';
        return render();
      }
      finish(undefined, multiple ? [...chosen].sort((a, b) => a - b) : [cursor]);
    };
    const onKey = (text: string | undefined, key: readline.Key | undefined) => {
      const name = key?.name;
      if ((key?.ctrl && name === 'c') || name === 'escape' || text === 'q')
        return finish(new Error(CANCELLED));
      note = '';
      if (name === 'up' || text === 'k') cursor = (cursor + entries.length - 1) % entries.length;
      else if (name === 'down' || text === 'j') cursor = (cursor + 1) % entries.length;
      else if (name === 'home') cursor = 0;
      else if (name === 'end') cursor = entries.length - 1;
      else if (text && /^[1-9]$/.test(text) && Number(text) <= entries.length)
        cursor = Number(text) - 1;
      else if (name === 'return' || name === 'enter') return confirm();
      else if (text === ' ') {
        if (!multiple) return confirm();
        if (!chosen.delete(cursor)) chosen.add(cursor);
      } else if (multiple && text === 'a') {
        if (chosen.size === entries.length) chosen.clear();
        else entries.forEach((_, i) => chosen.add(i));
      } else return;
      render();
    };
    const onEnd = () => finish(new Error('input closed before an answer was given'));
    const onError = (error: Error) => finish(error);

    readline.emitKeypressEvents(input);
    input.ref?.();
    input.setRawMode?.(true);
    input.on('keypress', onKey);
    input.once('end', onEnd);
    input.once('error', onError);
    output.write(HIDE_CURSOR);
    render();
    input.resume();
  });
}

/** The pickers for a terminal: keys from stdin, the menu on stderr so stdout stays clean for results. */
export function createPicker(io: PickIO): Picker {
  return {
    async one(question, labels, initial = 0) {
      return (await pick(io, question, labels, false, initial))[0];
    },
    many: (question, labels) => pick(io, question, labels, true, 0),
  };
}

const terminalIO = (): PickIO => ({
  input: process.stdin as PickIO['input'],
  output: process.stderr,
});

/** Resolved on use so importing this module never touches stdin. */
export const terminalPicker: Picker = {
  one: (question, labels, initial) => createPicker(terminalIO()).one(question, labels, initial),
  many: (question, labels) => createPicker(terminalIO()).many(question, labels),
};
