import test from 'node:test';
import assert from 'node:assert/strict';
import { EXTERNAL_RETENTION_HINT, summarizeRetentionFailure } from './restic-output.ts';

/** What restic 0.19.1 printed for `forget` against `rest-server --append-only` (captured from a real run, ids shortened). */
const APPEND_ONLY_FORGET = [
  'Applying Policy: keep 1 latest snapshots',
  'keep 1 snapshots:',
  'ID        Time                 Host          Tags        Reasons        Paths  Size',
  '-----------------------------------------------------------------------------------',
  '42b8ac63  2026-11-22 08:19:02  8dfe65c55030              last snapshot  /b     2 B',
  '-----------------------------------------------------------------------------------',
  '1 snapshots',
  '',
  'remove 1 snapshots:',
  '[0:00] 0.00%  0 / 1 files deleted',
  'Remove(<snapshot/202d03c576>) failed: unexpected HTTP response (403): 403 Forbidden',
  'unable to remove snapshot/202d03c576395d6d5b3fa0b02d1a3442db78f4ae7ee6bf896da10906e940cfab from the repository',
  'failed to remove one or more snapshots',
  'main.init',
  '\t/restic/cmd/restic/cmd_forget.go:67',
  'runtime.doInit1',
  '\t/usr/local/go/src/runtime/proc.go:8103',
  'runtime.doInit',
  '\t/usr/local/go/src/runtime/proc.go:8070',
  'runtime.main',
  '\t/usr/local/go/src/runtime/proc.go:258',
  'runtime.goexit',
  '\t/usr/local/go/src/runtime/asm_arm64.s:1447',
].join('\n');

test("a retention failure keeps restic's 403 line and drops the Go stack that follows it", () => {
  const summary = summarizeRetentionFailure(APPEND_ONLY_FORGET);
  assert.match(
    summary,
    /unexpected HTTP response \(403\): 403 Forbidden/,
    'the line that explains the failure is kept (a tail of the output used to cut it off)',
  );
  assert.match(summary, /failed to remove one or more snapshots/, "restic's final error is kept");
  for (const frame of ['main.init', '/restic/cmd', 'runtime.', 'proc.go', 'asm_arm64'])
    assert.ok(!summary.includes(frame), `the stack frame "${frame}" is dropped`);
});

test('a refused delete says to set external retention, once', () => {
  const summary = summarizeRetentionFailure(APPEND_ONLY_FORGET);
  assert.ok(
    summary.includes('tug backup destination set --retention external'),
    'an append-only refusal names the command that fixes it',
  );
  assert.equal(
    summary.split(EXTERNAL_RETENTION_HINT).length - 1,
    1,
    'the hint is appended one time',
  );
});

test('other refusals (permission denied, append-only wording) get the hint and other failures do not', () => {
  for (const text of [
    'Fatal: unable to open repository: permission denied',
    'Remove(<index/ab>) failed: repository is append-only',
    'Remove(<data/ab>) failed: Access Denied',
  ])
    assert.ok(
      summarizeRetentionFailure(text).includes(EXTERNAL_RETENTION_HINT),
      `"${text}" is a refusal, so retention can never succeed there`,
    );
  const unrelated = summarizeRetentionFailure('Fatal: unable to create lock in backend: timeout');
  assert.ok(
    !unrelated.includes('--retention external'),
    'a failure that is not a refusal gets no hint about external retention',
  );
});

test('retry notices and progress tickers are not the failure, and the text stays short', () => {
  const noisy = [
    ...Array.from(
      { length: 40 },
      (_, i) => `Remove(<snapshot/ab>) returned error, retrying after ${i}s: connection reset`,
    ),
    '[0:05] 0.00%  0 / 1 files deleted',
    'Fatal: unable to remove snapshot',
  ].join('\n');
  assert.equal(
    summarizeRetentionFailure(noisy),
    'Fatal: unable to remove snapshot',
    'only the final message remains',
  );
  assert.ok(
    summarizeRetentionFailure('x'.repeat(5000)).length <= 400,
    'a single enormous line is cut to a stored size',
  );
});

test('text that is nothing but noise still yields a message instead of an empty one', () => {
  assert.ok(
    summarizeRetentionFailure('main.init\n\t/restic/x.go:1').length > 0,
    "an all-stack text falls back to restic's own words rather than an empty message",
  );
});
