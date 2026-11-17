import path from 'node:path';

// Entry points for the tests that must start a real tug process: a terminal, piped stdin, signals, a command that
// has to exit while its input stays open, the built `dist` output. Everything else runs the CLI in-process with
// `execCli` (tests/cli-inprocess.ts), which costs milliseconds instead of the half second a node start takes.
//
// Only files named `*.process.test.ts` may import this module (src/test-layout.test.ts enforces it), so the slow
// tier stays a list of files, not a habit that spreads by copying the neighbouring test.

/** The operator CLI: `src/cli.ts`, or the built output with `CLI_ENTRY=dist/cli.js` (npm run test:smoke:dist). */
export const cliEntry = path.resolve(process.env.CLI_ENTRY || 'src/cli.ts');
/** The runtime (control and agent) entry. */
export const mainEntry = path.resolve('src/main.ts');
