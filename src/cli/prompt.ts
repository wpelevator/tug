import readline from 'node:readline';
import { Writable } from 'node:stream';
import { suspendProgress } from './progress.ts';
import type { CliRuntime } from './runtime.ts';

/** True when both ends are a terminal and the run is not CI, so asking a question can be answered. */
export function canPrompt(rt: CliRuntime): boolean {
  return !!rt.stdin.isTTY && !!rt.stdout.isTTY && !rt.env.CI;
}

export type Prompter = (question: string, hidden?: boolean) => Promise<string>;

/** Asks a line of text on this run's terminal; with `hidden` the typed characters are not echoed. */
export const prompter =
  (rt: CliRuntime): Prompter =>
  async (question, hidden = false) => {
    // A keyboard menu leaves stdin unreferenced so a finished menu cannot hold the process open; a question needs it held.
    rt.stdin.ref?.();
    // The question owns the line it is typed on, so a live progress line must stay off the screen meanwhile.
    const resumeProgress = suspendProgress(rt);
    const muted = { on: false };
    const output = new Writable({
      write(chunk, _encoding, callback) {
        if (!muted.on) rt.stderr.write(chunk);
        callback();
      },
    });
    const rl = readline.createInterface({ input: rt.stdin, output, terminal: true });
    try {
      return await new Promise<string>((resolve, reject) => {
        const onClose = () => reject(new Error('input closed before an answer was given'));
        rl.once('close', onClose);
        rl.question(question, (answer) => {
          rl.off('close', onClose);
          if (hidden) rt.stderr.write('\n');
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
  rt: CliRuntime,
  question: string,
  fallback = true,
  prompt: Prompter = prompter(rt),
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
