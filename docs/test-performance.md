# Test suite performance

Status: Record. The first proposal is built; measured on 17 November 2026 on a 4-core Linux container with Node.js 22.23.4.

`npm test` took 2 minutes 49 seconds there and about 8.5 minutes of CPU before the change described under [Result](#result), and takes 1 minute 17 seconds after it. This page records where the time went and what changed. The numbers are from runs on that machine, so treat them as ratios, not as promises for other hardware. I did not measure earlier releases, so this page cannot say which change made the suite slow.

## What the run is made of

| Measure | Value | How it was taken |
| --- | --- | --- |
| Wall time, `npm test` | 2 min 49 s | `time node --test 'src/**/*.test.ts' tools/scripts/check-reachability.test.mjs` |
| CPU time (user) | 8 min 35 s | Same run |
| Test files | 152 | `find src tools/scripts -name '*.test.*'` |
| Test cases | 1,175 | JUnit reporter |
| Sum of case durations | 454 s | JUnit reporter |
| CLI processes started | 467 | A `--import` preload that logs every process whose entry is `cli.ts` or `cli.js` |
| Cost of one `node src/cli.ts --version` | about 0.45 to 0.5 s wall, 0.8 s CPU | `time`, repeated |
| Cost of bare `node -e 0` | 0.03 s | `time` |

The suite is not slow because of many tests or slow logic. It is slow because tests start the CLI as a child process 467 times, and each start costs about 15 times a bare Node.js start.

At 0.8 s of CPU each, those starts account for up to about 370 s of the 515 s of CPU, which is most of it. The slowest cases are matrix tests that run the CLI once per argument set:

| Case | Seconds | File |
| --- | --- | --- |
| CLI selections mutate only chosen resources | 36.9 | `src/cli/cli.selection.test.ts` |
| Token commands reject malformed invocations | 28.9 | `src/cli/credentials.test.ts` |
| Credential create, list and revoke | 25.5 | `src/cli/credentials.test.ts` |
| Deploy refuses a `--var` that is a secret | 23.9 | `src/cli/commands/var.test.ts` |
| Every config key applies to every command that has its option | 22.2 | `src/cli/config.test.ts` |
| Every command that produces a result accepts `--json` | 20.1 | `src/cli/json-option.test.ts` |

Those durations were taken with the 4 cores busy, so they are inflated. `src/cli/credentials.test.ts` alone, with nothing else running, takes 18 s for 4 test cases.

The eleven slowest files are all CLI tests: `credentials`, `cli.selection`, `templates`, `ssh-hostkey`, `config`, `var`, `json-option`, `wait-progress`, `cli`, `upgrade` and `stdin`. `src/control/live-flow.test.ts` is the only non-CLI file near the top, and it also drives the CLI.

## Why one CLI start is slow

`src/cli.ts` imports every command module at the top (`registerBackup`, `registerDeploy`, `registerNode` and about twenty more), so `tug --help` loads the control client, mTLS, YAML, tar and the rest.

A CPU profile of `node src/cli.ts --version` shows the time in module loading and in Node.js stripping TypeScript types on every start, not in tug code: the amaro transform, WebAssembly compilation and the ESM loader.

| Entry point | Start time |
| --- | --- |
| `node src/cli.ts --version` | 0.45 to 0.5 s |
| `node dist/cli.js --version` (built) | 0.33 to 0.4 s |
| `node dist/cli.js` with `NODE_COMPILE_CACHE` warm | 0.25 to 0.27 s |
| `node src/cli.ts` with `NODE_COMPILE_CACHE` warm | 0.39 to 0.41 s |

The build takes 5.7 s. Building and caching alone roughly halves the start cost but still leaves about 0.25 s per spawn, so it is not enough by itself.

`src/cli.ts` calls `program.parseAsync()` at the top level, so there is no function a test can call without starting a process.

## Result

Built, in this order:

1. `src/cli/program.ts` exports `runCli(argv)`, which builds the program per call and returns the exit code. `src/cli.ts` is a three-line entry. Commander throws instead of calling `process.exit`, and `resetUsage` plus `setVerbose` reset the module state between runs.
2. The program loads only the module of the command named on the command line (`COMMAND_MODULES`), and everything for `--help`, `--version` and unknown names. `tug credential list` starts in about 0.34 s instead of 0.45 s. `src/cli/program.test.ts` checks that the table matches `tug --help`.
3. `tests/cli-inprocess.ts` provides `execCli`, and 17 test files moved from `exec(process.execPath, [entry, …])` to it. The matrix tests (`credentials`, `json-option`, `config`, `var`, the argument cases of `cli.selection`) now take about a second each, down from 18 to 46 seconds.
4. `npm test` runs through `tools/scripts/test.mjs`, which sets `NODE_COMPILE_CACHE` for the processes that remain.

| Measure | Before | After |
| --- | --- | --- |
| Wall time, `npm test` | 2 min 49 s | 1 min 17 s |
| CPU time (user) | 8 min 35 s | 3 min 22 s |
| CLI processes started | 467 | 106 |
| Test cases | 1,175 | 1,180 (four new, for `runCli` and `execCli`) |

The 106 that remain need a real process: the interactive selection and prompt tests (a fake terminal and keystrokes), whole-document stdin and `secret set` (exit while stdin stays open), the 100 MB streaming tests, `wait-progress`, and the `dist` and templates smoke tests.

I did not build the `pretest` build step or the `npm test` / `npm run test:cli` split. After the move, the processes that remain are mostly terminal and stream tests that run against `src`, so a built entry would save about 0.15 s on about a hundred starts, and the suite is already under the 90 second target. Revisit when it grows past that.

## Next candidates

The slowest files now are `src/control/live-flow.test.ts`, `src/cli/cli.selection.test.ts`, `src/cli/templates.test.ts` and `src/cli/wait-progress.test.ts`. Each is dominated by a few real-process or large-transfer cases. Cutting further means shrinking the 100 MB transfers or sharing one control between cases, not removing spawns.
