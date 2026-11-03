import readline from 'node:readline';
import { Writable } from 'node:stream';

/** True when both ends are a terminal and the run is not CI, so asking a question can be answered. */
export function canPrompt(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!process.stdin.isTTY && !!process.stdout.isTTY && !env.CI;
}

export type Prompter = (question: string, hidden?: boolean) => Promise<string>;

/** Ask a line of text on the terminal; with `hidden` the typed characters are not echoed. */
export const ask: Prompter = async (question, hidden = false) => {
  const muted = { on: false };
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted.on) process.stdout.write(chunk);
      callback();
    },
  });
  const rl = readline.createInterface({ input: process.stdin, output, terminal: true });
  try {
    return await new Promise<string>((resolve, reject) => {
      rl.once('close', () => reject(new Error('input closed before an answer was given')));
      rl.question(question, (answer) => {
        if (hidden) process.stdout.write('\n');
        resolve(answer);
      });
      muted.on = hidden;
    });
  } finally {
    rl.removeAllListeners('close');
    rl.close();
  }
};

/** A yes/no question; an empty answer takes `fallback`. */
export async function confirm(
  question: string,
  fallback = true,
  prompt: Prompter = ask,
): Promise<boolean> {
  for (;;) {
    const answer = (await prompt(`${question} ${fallback ? '(Y/n)' : '(y/N)'} `))
      .trim()
      .toLowerCase();
    if (answer === '') return fallback;
    if (answer === 'y' || answer === 'yes') return true;
    if (answer === 'n' || answer === 'no') return false;
  }
}

/** Pick one of `options` by number; an empty answer takes the option at `fallback`. */
export async function choose(
  question: string,
  options: readonly string[],
  fallback = 0,
  prompt: Prompter = ask,
): Promise<number> {
  console.error(question);
  options.forEach((option, index) => console.error(`  ${index + 1}) ${option}`));
  for (;;) {
    const answer = (await prompt(`Choose 1-${options.length} (${fallback + 1}): `)).trim();
    if (answer === '') return fallback;
    const index = Number(answer) - 1;
    if (Number.isInteger(index) && index >= 0 && index < options.length) return index;
  }
}
