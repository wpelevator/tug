import test from 'node:test';
import assert from 'node:assert/strict';
import { createWriterQueue, WRITER_OVERDUE_AFTER_MS } from './writer-queue.ts';

test('writer queue marks work overdue only after the deadline and clears it after recovery', async () => {
  let time = 1_000;
  const queue = createWriterQueue(() => time);
  let finish!: () => void;
  const operation = queue.run(() => new Promise<void>((resolve) => (finish = resolve)));

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(queue.activeForMs(), 0, 'active work starts with zero elapsed time');
  time += WRITER_OVERDUE_AFTER_MS;
  assert.equal(
    queue.activeForMs(),
    WRITER_OVERDUE_AFTER_MS,
    'work at the deadline remains within its grace period',
  );
  time += 1;
  assert.equal(
    queue.activeForMs(),
    WRITER_OVERDUE_AFTER_MS + 1,
    'overdue work remains observable without waiting for the queue',
  );

  finish();
  await operation;
  assert.equal(queue.activeForMs(), null, 'a completed writer clears the overdue signal');
});

test('a failed writer releases the queue and clears its active age', async () => {
  const queue = createWriterQueue(() => 1_000);
  await assert.rejects(
    queue.run(() => {
      throw new Error('writer failed');
    }),
    /writer failed/,
    'writer failures should reach their caller',
  );
  assert.equal(queue.activeForMs(), null, 'failed work must clear its active age');
  assert.equal(
    await queue.run(() => 'recovered'),
    'recovered',
    'later work should proceed after failure',
  );
});
