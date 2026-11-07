import readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { ask } from './cli-prompt.ts';

export interface PickIO {
  input: Readable & {
    setRawMode?: (mode: boolean) => unknown;
    ref?: () => unknown;
    unref?: () => unknown;
  };
  output: Writable & { columns?: number; rows?: number };
}

/**
 * Menus: `one` returns the chosen index, `many` the chosen indexes in list order. `initial` is the entry a plain Enter
 * takes; without it nothing is chosen until the person picks.
 */
export interface Picker {
  one(question: string, labels: readonly string[], initial?: number): Promise<number>;
  many(question: string, labels: readonly string[]): Promise<number[]>;
}

export const CANCELLED = 'cancelled; nothing was changed';

const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const ERASE_BELOW = '\r\x1b[J';
/** Digits typed within this time of each other form one number, so `12` reaches the twelfth entry. */
const NUMBER_TYPING_MS = 1000;

/** A label is one line of plain text: control characters would break the cursor arithmetic or inject escapes. */
// eslint-disable-next-line no-control-regex
const plain = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');

const segmenter = new Intl.Segmenter();
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦\u{1f300}-\u{1faff}\u{20000}-\u{3fffd}]/u;

/** Terminal columns one user-perceived character occupies: 2 for East Asian wide characters and emoji, else 1. */
function graphemeWidth(grapheme: string): number {
  return WIDE.test(grapheme) || /\p{Emoji_Presentation}/u.test(grapheme) ? 2 : 1;
}

/** `text` cut to at most `columns` terminal columns, ending in an ellipsis when it was cut. */
export function clipToColumns(text: string, columns: number): string {
  let used = 0;
  let out = '';
  const graphemes = [...segmenter.segment(text)].map((part) => part.segment);
  const total = graphemes.reduce((sum, grapheme) => sum + graphemeWidth(grapheme), 0);
  if (total <= columns) return text;
  for (const grapheme of graphemes) {
    const width = graphemeWidth(grapheme);
    if (used + width > columns - 1) break;
    out += grapheme;
    used += width;
  }
  return `${out}…`;
}

/**
 * A menu drawn in place on `output` and driven by keypresses on `input`: arrows, Ctrl-N/P or j/k move, PageUp/PageDown
 * page, digits jump to that entry, space toggles (or picks, in a single-choice menu), `a` toggles all, Enter confirms,
 * and q, Esc, Ctrl-C or Ctrl-D cancel. Nothing is preselected and a multi-choice menu cannot be confirmed empty, so
 * Enter alone never picks a target.
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
  let typed = '';
  let typedAt = 0;
  const hint = multiple ? 'space select, a all, enter done, q cancel' : 'enter select, q cancel';
  const width = () => Math.max(20, (output.columns ?? 80) - 1);
  const clip = (text: string) => clipToColumns(text, width());
  // Title, hint, scroll footer and note must all fit above the prompt line, or the cursor arithmetic breaks.
  const pageSize = () => Math.max(1, Math.min(entries.length, (output.rows ?? 24) - 5));

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
    const restoreTerminal = () => {
      output.write(SHOW_CURSOR);
      input.setRawMode?.(false);
    };
    const onExit = () => restoreTerminal();
    // A signal that ends the process must not leave the cursor hidden or the terminal raw: restore, then die of it.
    const signals = ['SIGTERM', 'SIGHUP'] as const;
    const onSignal = (signal: NodeJS.Signals) => {
      restoreTerminal();
      for (const name of signals) process.off(name, onSignal);
      process.kill(process.pid, signal);
    };
    const finish = (error: Error | undefined, indexes: number[] = []) => {
      if (settled) return;
      settled = true;
      input.off('keypress', onKey);
      input.off('end', onEnd);
      input.off('error', onError);
      output.off('resize', render);
      process.off('exit', onExit);
      for (const name of signals) process.off(name, onSignal);
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
    const move = (to: number) => {
      cursor = Math.min(Math.max(to, 0), entries.length - 1);
    };
    const onKey = (text: string | undefined, key: readline.Key | undefined) => {
      const name = key?.name;
      if (
        (key?.ctrl && (name === 'c' || name === 'd')) ||
        name === 'escape' ||
        (!key?.ctrl && text === 'q')
      )
        return finish(new Error(CANCELLED));
      note = '';
      if (name === 'up' || (key?.ctrl && name === 'p') || text === 'k')
        cursor = (cursor + entries.length - 1) % entries.length;
      else if (name === 'down' || (key?.ctrl && name === 'n') || text === 'j')
        cursor = (cursor + 1) % entries.length;
      else if (name === 'home') cursor = 0;
      else if (name === 'end') cursor = entries.length - 1;
      else if (name === 'pageup') move(cursor - pageSize());
      else if (name === 'pagedown') move(cursor + pageSize());
      else if (text && /^[0-9]$/.test(text)) {
        const now = Date.now();
        const joined = now - typedAt > NUMBER_TYPING_MS ? text : typed + text;
        typedAt = now;
        // A number that overshoots starts over from this digit, so a slow or mistaken sequence recovers.
        typed = Number(joined) >= 1 && Number(joined) <= entries.length ? joined : text;
        if (Number(typed) >= 1 && Number(typed) <= entries.length) cursor = Number(typed) - 1;
        else return;
      } else if (name === 'return' || name === 'enter') return confirm();
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
    output.on('resize', render);
    process.once('exit', onExit);
    for (const name of signals) process.once(name, onSignal);
    output.write(HIDE_CURSOR);
    render();
    input.resume();
  });
}

/** The pickers for a terminal that can redraw: keys from `input`, the menu on `output`. */
export function createPicker(io: PickIO): Picker {
  return {
    async one(question, labels, initial) {
      return (await pick(io, question, labels, false, initial ?? 0))[0];
    },
    many: (question, labels) => pick(io, question, labels, true, 0),
  };
}

/** Numbered menus for terminals that cannot redraw (`TERM=dumb`, screen readers, Emacs shells): type `2`, or `1,3` for several. */
export function createNumberedPicker(
  prompt: (question: string) => Promise<string>,
  write: (line: string) => void,
): Picker {
  const show = (question: string, labels: readonly string[]) => {
    write(question);
    labels.forEach((label, index) => write(`  ${index + 1}) ${plain(label)}`));
  };
  const answer = async (suffix: string, multiple: boolean, count: number) => {
    for (;;) {
      const text = (await prompt(suffix)).trim();
      if (/^(q|quit|cancel)$/i.test(text)) throw new Error(CANCELLED);
      if (text === '') return undefined;
      const parts = text.split(',').map((part) => part.trim());
      if (!multiple && parts.length !== 1) continue;
      const indexes = parts.map((part) => (/^[1-9]\d*$/.test(part) ? Number(part) - 1 : -1));
      if (indexes.every((index) => index >= 0 && index < count))
        return [...new Set(indexes)].sort((a, b) => a - b);
    }
  };
  return {
    async one(question, labels, initial) {
      show(question, labels);
      const hint = initial === undefined ? '' : ` [${initial + 1}]`;
      for (;;) {
        const picked = await answer(
          `Choose a number${hint} (or q to cancel): `,
          false,
          labels.length,
        );
        if (picked) return picked[0];
        // A blank answer only means something when the menu offered a default.
        if (initial !== undefined) return initial;
      }
    },
    async many(question, labels) {
      show(question, labels);
      for (;;) {
        const picked = await answer(
          'Choose numbers separated by commas (or q to cancel): ',
          true,
          labels.length,
        );
        if (picked) return picked;
      }
    },
  };
}

const terminalIO = (): PickIO => ({
  input: process.stdin as PickIO['input'],
  output: process.stderr,
});
const numbered = createNumberedPicker(ask, (line) => console.error(line));
/** A terminal that announces itself as dumb gets numbered menus; everything else gets the keyboard menu. */
const choosePicker = (): Picker =>
  process.env.TERM === 'dumb' ? numbered : createPicker(terminalIO());

/** Resolved on use so importing this module never touches stdin. */
export const terminalPicker: Picker = {
  one: (question, labels, initial) => choosePicker().one(question, labels, initial),
  many: (question, labels) => choosePicker().many(question, labels),
};
