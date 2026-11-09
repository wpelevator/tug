import type { Command } from 'commander';
import { commandPath } from './config.ts';

/** Commands whose output is a container's own stream, not a result: exec, run and logs write it through unchanged. */
export const RAW_OUTPUT_COMMANDS = ['exec', 'run', 'logs'];

export const JSON_HELP =
  'print the result as JSON (a command that already prints JSON accepts this and prints the same)';

/**
 * Gives every command that produces a result a `--json` option, so scripts can ask for JSON from any of them. Commands
 * that print a human summary by default declare their own `--json` and are left alone; the rest already print JSON and
 * take the flag for consistency.
 */
export function addJsonOption(
  command: Command,
  raw: readonly string[] = RAW_OUTPUT_COMMANDS,
): void {
  if (command.commands.length) {
    for (const child of command.commands) addJsonOption(child, raw);
    // `deploy` is both a command and the parent of `deploy cancel`.
    if (!command.options.length) return;
  }
  if (raw.includes(commandPath(command))) return;
  if (command.options.some((option) => option.long === '--json')) return;
  command.option('--json', JSON_HELP);
}
