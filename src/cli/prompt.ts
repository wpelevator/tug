import readline from 'node:readline';
import { Writable } from 'node:stream';
import { suspendProgress } from './progress.ts';

/** True when both ends are a terminal and the run is not CI, so asking a question can be answered. */
export function canPrompt(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!process.stdin.isTTY && !!process.stdout.isTTY && !env.CI;
}

export type Prompter = (question: string, hidden?: boolean) => Promise<string>;

/** Ask a line of text on the terminal; with `hidden` the typed characters are not echoed. */
export const ask: Prompter = async (question, hidden = false) => {
  // A keyboard menu leaves stdin unreferenced so a finished menu cannot hold the process open; a question needs it held.
  process.stdin.ref?.();
  // The question owns the line it is typed on, so a live progress line must stay off the screen meanwhile.
  const resumeProgress = suspendProgress();
  const muted = { on: false };
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted.on) process.stderr.write(chunk);
      callback();
    },
  });
  const rl = readline.createInterface({ input: process.stdin, output, terminal: true });
  try {
    return await new Promise<string>((resolve, reject) => {
      const onClose = () => reject(new Error('input closed before an answer was given'));
      rl.once('close', onClose);
      rl.question(question, (answer) => {
        rl.off('close', onClose);
        if (hidden) process.stderr.write('\n');
        resolve(answer);
      });
      muted.on = hidden;
    });
  } finally {
    rl.close();
    resumeProgress();
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
