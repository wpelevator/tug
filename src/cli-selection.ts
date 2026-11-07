import { canPrompt } from './cli-prompt.ts';
import { terminalPicker } from './cli-pick.ts';
import type { Picker } from './cli-pick.ts';

export interface Choice {
  value: string;
  label: string;
}
export interface SelectionIO extends Picker {
  interactive: boolean;
}
const terminal = (): SelectionIO => ({
  interactive: canPrompt(),
  one: (...args) => terminalPicker.one(...args),
  many: (...args) => terminalPicker.many(...args),
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
  const labels = options.map((option) => option.label);
  const indexes = multiple ? await io.many(question, labels) : [await io.one(question, labels)];
  return indexes.map((index) => options[index].value);
}
