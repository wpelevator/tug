import { ask, canPrompt } from './cli-prompt.ts';
import type { Prompter } from './cli-prompt.ts';

export interface Choice {
  value: string;
  label: string;
}
export interface SelectionIO {
  interactive: boolean;
  prompt: Prompter;
  write: (message: string) => void;
}
const terminal = (): SelectionIO => ({
  interactive: canPrompt(),
  prompt: ask,
  write: console.error,
});

/** Resolve lazily so explicit arguments never need a discovery request. */
export async function selectOne(
  value: string | undefined,
  question: string,
  load: () => Promise<Choice[]>,
  io = terminal(),
): Promise<string> {
  if (value) return value;
  const selected = await selectChoices(question, load, false, io);
  return selected[0];
}
export async function selectMany(
  question: string,
  load: () => Promise<Choice[]>,
  io = terminal(),
): Promise<string[]> {
  return selectChoices(question, load, true, io);
}
async function selectChoices(
  question: string,
  load: () => Promise<Choice[]>,
  multiple: boolean,
  io: SelectionIO,
): Promise<string[]> {
  if (!io.interactive)
    throw new Error(
      `${question}: pass an explicit target; selection requires a terminal outside CI`,
    );
  const options = await load();
  if (!options.length) throw new Error(`${question}: no eligible options`);
  io.write(question);
  options.forEach((option, index) => io.write(`  ${index + 1}) ${option.label}`));
  for (;;) {
    const answer = (
      await io.prompt(
        multiple
          ? 'Choose numbers separated by commas (or q to cancel): '
          : 'Choose a number (or q to cancel): ',
      )
    ).trim();
    if (/^(q|quit|cancel)$/i.test(answer)) throw new Error('cancelled; nothing was changed');
    const parts = answer.split(',').map((part) => part.trim());
    if ((!multiple && parts.length !== 1) || parts.some((part) => !/^[1-9]\d*$/.test(part)))
      continue;
    const indexes = parts.map((part) => Number(part) - 1);
    if (indexes.some((index) => index >= options.length)) continue;
    return [...new Set(indexes)].map((index) => options[index].value);
  }
}
