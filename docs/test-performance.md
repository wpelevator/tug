# Test suite performance

Status: Record. The first proposal is built; measured on 17 November 2026 on a 4-core Linux container with Node.js 22.23.4.

`npm test` took 2 minutes 49 seconds there and about 8.5 minutes of CPU before the change described under [Result](#result), and takes about 77 seconds after it (70 seconds with `--test-concurrency` set to the core count). This page records where the time went and what changed. The numbers are from runs on that machine, so treat them as ratios, not as promises for other hardware. I did not measure earlier releases, so this page cannot say which change made the suite slow.

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
| CLI selections mutate only chosen resources | 36.9 | `src/cli/cli.selection.process.test.ts` |
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

1. The CLI reaches its process only through a `CliRuntime` (env, cwd, streams, signals, exit code and per-run state; see [the CLI runtime](architecture.md#the-cli-runtime)), and `runCli(argv, rt)` in `src/cli/program.ts` builds the command tree for one run and returns the exit code. `src/cli.ts` is a three-line entry. ESLint rejects `process`, `console` and `os.homedir` in `src/cli/` outside `runtime.ts`.
2. The program loads only the module of the command named on the command line (`REGISTRARS`), and everything for `--help`, `--version` and unknown names; the root options that decide where the command name is come from the program itself. `tug credential list` starts in about 0.34 s instead of 0.45 s. `src/cli/program.test.ts` checks that the table matches `tug --help`.
3. `tests/cli-inprocess.ts` provides `execCli`, which builds a `testRuntime` (`tests/cli-runtime.ts`) for each call, so nothing global is patched and calls overlap safely, and 17 test files moved from `exec(process.execPath, [entry, …])` to it. The matrix tests (`credentials`, `json-option`, `config`, `var`, the argument cases of `cli.selection`) now take about a second each, down from 18 to 46 seconds.
4. CI sets `NODE_COMPILE_CACHE` on the test step, so the processes that remain compile the module graph once. Locally, export it to get the same (for example `NODE_COMPILE_CACHE="$TMPDIR/tug-compile-cache" npm test`).
5. Test files that start real tug processes are named `*.process.test.ts`, import their entry points from `tests/cli-process.ts`, and are guarded by `src/test-layout.test.ts` (see [fast and process test files](testing.md#fast-and-process-test-files)).

| Measure | Before | After |
| --- | --- | --- |
| Wall time, `npm test` | 2 min 49 s | about 77 s (70 s with `--test-concurrency=4`) |
| CPU time (user) | 8 min 35 s | 3 min 22 s |
| CLI processes started | 467 | 106 |
| Test cases | 1,175 | 1,192 (new ones for `runCli`, the runtime, `execCli`, the ESLint boundary and the layout guard) |

The 106 that remain need a real process: the interactive selection and prompt tests (a fake terminal and keystrokes), whole-document stdin and `secret set` (exit while stdin stays open), the 100 MB streaming tests, and the `dist` and templates smoke tests. `wait-progress` is not among them: it runs in-process and takes about 14 s because it waits on real timers.

A `pretest` build step and an `npm test` / `npm run test:cli` split were not built. After the move, the processes that remain are mostly terminal and stream tests that run against `src`, so a built entry would save about 0.15 s on about a hundred starts, and the suite is already under the 90 second target. Revisit when it grows past that.

## Fast and process files

`node:test` has no tags. It can run files in parallel (`--test-concurrency`), split a run across machines (`--test-shard`) and filter by test name (`--test-name-pattern`, `--test-skip-pattern`), and it runs the tests inside one file one after another. Parallelism is therefore per file, and the wall time is bounded by the larger of the longest file and the total CPU time divided by the cores.

Measured serially and uncontended on the 4-core container, the 153 test files that existed then add up to 224 s, so 4 cores cannot go below about 56 s. The longest file alone is 21.5 s (`src/control/live-flow.test.ts`), then `cli.selection` (18.3 s), `templates` (14.7 s) and `wait-progress` (13.6 s, in-process but waiting on real timers).

| Kind | Files | Serial time | How it is selected |
| --- | --- | --- | --- |
| Fast: unit and in-process service tests | 144 (145 now) | 167 s | `*.test.ts` |
| Process: starts real tug processes | 9 | 57 s | `*.process.test.ts`, `npm run test:process` |

`npm test` runs both. With plain `node --test` the process files alone take 28 s wall, and node cannot exclude a glob, so there is no fast-only script: the kind is a file name that tools and a reader can use (`ls src/**/*.process.test.ts`).

Concurrency, whole suite, compile cache warm:

| `--test-concurrency` | Wall time |
| --- | --- |
| 2 | 109 s |
| 3 (node's default here: cores minus one) | 87 s |
| 4 (the core count) | 70 s |
| 8 | 68 s |

Matching the concurrency to the core count is worth about 20 % on this machine, and more than that gains nothing. Node's default leaves a core idle, and the setting is machine-specific, so it is not hard-coded in `npm test`: pass `--test-concurrency=$(nproc)` locally when it matters. Running the longest files first and sharding across CI jobs were considered and left out: the first needs a cache of timings that goes stale, and the second adds jobs to save about 20 s.

## Keeping it fast

The cause of the slow suite was a habit, not a defect: the cheapest way to write a CLI test was to copy a neighbour and spawn the process. Three things keep it from coming back:

- The cheap way is the default. `execCli` (`tests/cli-inprocess.ts`) is what a test reaches for, and `startMtlsControl` gives it a real control in the same process. The runtime boundary is what makes that safe: the CLI cannot read a global, so a test never has to patch one.
- The expensive way is named and fenced. A test that needs a terminal, piped stdin, signals or the built entry goes in a `*.process.test.ts` file and imports `cliEntry` or `mainEntry` from `tests/cli-process.ts`. `src/test-layout.test.ts` fails when a fast file imports that helper or names the entry path, and when a process file starts no process.
- The numbers are in the log. A reader can compare against the table above: the suite at 1,192 test cases takes about 77 s on 4 cores, with 106 CLI starts in the whole run.

## Next candidates

Each of the slowest files is dominated by a few real-process, large-transfer or real-timer cases. Cutting further means shrinking the 100 MB transfers, injecting a clock into the long-wait tests, or sharing one control between cases.
