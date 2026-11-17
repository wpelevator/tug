# Test suite performance

Status: Record with a proposal. Measured on 17 November 2026 on a 4-core Linux container with Node.js 22.23.4. The proposal is not built yet.

`npm test` takes about 2 minutes 49 seconds there, and about 8.5 minutes of CPU. This page records where that time goes and what to change. The numbers are from runs on that machine, so treat them as ratios, not as promises for other hardware. I did not measure earlier releases, so this page cannot say which change made the suite slow.

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

## Proposal

Ordered by effect. Do the first two together.

1. **Expose the CLI as a function and run argument-level tests in-process.** Move the program construction into `src/cli/main.ts` as `run(argv, { env, cwd, stdout, stderr })` returning an exit code, and keep `src/cli.ts` as the three-line entry that calls it. Move the matrix tests that only check parsing, help text, `--json` shape, config-key mapping and "rejected before contacting control" onto `run`. Keep about 10 real subprocess tests as smoke tests: exit codes, stdin and stdout streams, signals, and the `dist` entry. This removes most of the 467 spawns.
2. **Parse before loading.** Register commands lazily: `src/cli.ts` looks at the first argument and imports only that command's module. `tug credential list` then no longer loads the deploy and TUI graphs. This helps operators on every invocation, not just the suite, and cuts the remaining spawns.
3. **Run subprocess tests against the built CLI.** Add a `pretest` step that runs `npm run build` once (5.7 s) and set `NODE_COMPILE_CACHE` to a directory under `os.tmpdir()` for the remaining spawns. `npm run test:smoke:dist` already builds, so the build path is exercised.
4. **Split the scripts.** `npm test` runs the fast suite (in-process and unit tests). `npm run test:cli` runs the subprocess smoke tests. CI runs both, and a contributor runs `npm test` while iterating.

A projection, not a measurement: if 400 of the 467 spawns move in-process, the suite loses up to roughly 300 s of CPU and should finish in about 1 minute on this machine. Re-measure after step 1 before committing to steps 3 and 4.

## Acceptance

- `npm test` finishes in under 90 s on 4 cores, and the CLI spawn count is under 70 when measured with the preload described above.
- No test is deleted: every moved case asserts the same behavior, including its assertion message.
- The `--json` and config-key matrix tests still cover every registered command, so adding a command without covering it fails.
