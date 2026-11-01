import test from 'node:test';
import assert from 'node:assert/strict';
import { cronPeriodMs, nextCronRun, parseCron } from './cron.ts';

const at = (iso: string) => new Date(iso);
const next = (expr: string, after: string) => nextCronRun(expr, at(after))?.toISOString();

test('a daily schedule fires at the next matching minute, strictly after the reference time', () => {
  assert.equal(next('0 3 * * *', '2026-11-01T02:59:59Z'), '2026-11-01T03:00:00.000Z');
  assert.equal(next('0 3 * * *', '2026-11-01T03:00:00Z'), '2026-11-02T03:00:00.000Z');
});

test('lists, ranges and steps expand to the expected minutes', () => {
  assert.deepEqual([...parseCron('5,10 * * * *').minutes], [5, 10]);
  assert.deepEqual([...parseCron('10-13 * * * *').minutes], [10, 11, 12, 13]);
  assert.deepEqual([...parseCron('*/20 * * * *').minutes], [0, 20, 40]);
  assert.deepEqual([...parseCron('10-30/10 * * * *').minutes], [10, 20, 30]);
  assert.deepEqual(
    [...parseCron('50/5 * * * *').minutes],
    [50, 55],
    'a start with a step runs to the field maximum',
  );
});

test('aliases map to their five-field forms', () => {
  assert.equal(next('@hourly', '2026-11-01T10:30:00Z'), '2026-11-01T11:00:00.000Z');
  assert.equal(next('@daily', '2026-11-01T10:30:00Z'), '2026-11-02T00:00:00.000Z');
  assert.equal(
    next('@weekly', '2026-11-01T10:30:00Z'),
    '2026-11-08T00:00:00.000Z',
    'weekly runs on Sunday',
  );
  assert.equal(next('@monthly', '2026-11-01T10:30:00Z'), '2026-12-01T00:00:00.000Z');
  assert.equal(next('@yearly', '2026-11-01T10:30:00Z'), '2027-01-01T00:00:00.000Z');
});

test('weekday 7 is Sunday like 0', () => {
  assert.deepEqual([...parseCron('0 0 * * 7').weekdays], [0]);
  assert.equal(next('0 0 * * 7', '2026-11-02T00:00:00Z'), '2026-11-08T00:00:00.000Z');
});

test('restricting both day of month and weekday matches either, as cron does', () => {
  // 2026-11-01 is a Sunday. "the 15th or any Monday" next fires on Monday the 2nd.
  assert.equal(next('0 0 15 * 1', '2026-11-01T00:00:00Z'), '2026-11-02T00:00:00.000Z');
  assert.equal(next('0 0 15 * 1', '2026-11-09T00:00:00Z'), '2026-11-15T00:00:00.000Z');
});

test('a restricted day with a wildcard weekday requires the day to match', () => {
  assert.equal(
    next('0 0 31 * *', '2026-11-01T00:00:00Z'),
    '2026-12-31T00:00:00.000Z',
    'November has no 31st',
  );
});

test('a month boundary and the year rollover are handled', () => {
  assert.equal(next('30 23 31 12 *', '2026-12-31T23:30:00Z'), '2027-12-31T23:30:00.000Z');
  assert.equal(next('0 0 1 * *', '2026-12-31T23:59:00Z'), '2027-01-01T00:00:00.000Z');
});

test('February 29 waits for a leap year, including across the 2100 skipped leap year', () => {
  assert.equal(next('0 0 29 2 *', '2026-01-01T00:00:00Z'), '2028-02-29T00:00:00.000Z');
  assert.equal(next('0 0 29 2 *', '2096-03-01T00:00:00Z'), '2104-02-29T00:00:00.000Z');
});

test('a schedule that can never fire returns null instead of looping', () => {
  assert.equal(
    nextCronRun('0 0 31 2 *', at('2026-01-01T00:00:00Z')),
    null,
    'February 31 never exists',
  );
});

test('seconds in the reference time are dropped before searching', () => {
  assert.equal(next('* * * * *', '2026-11-01T10:30:45Z'), '2026-11-01T10:31:00.000Z');
});

test('invalid schedules are rejected with a message naming the problem', () => {
  const bad: [string, RegExp][] = [
    ['', /five fields/],
    ['* * * *', /five fields/],
    ['* * * * * *', /five fields/],
    ['60 * * * *', /minute 60 is outside 0-59/],
    ['* 24 * * *', /hour 24 is outside 0-23/],
    ['* * 0 * *', /day of month 0 is outside 1-31/],
    ['* * * 13 *', /month 13 is outside 1-12/],
    ['* * * * 8', /day of week 8 is outside 0-7/],
    ['5-1 * * * *', /runs backwards/],
    ['*/0 * * * *', /step/],
    ['1,,2 * * * *', /empty list item/],
    ['a * * * *', /not a number/],
    ['@sometimes', /five fields/],
  ];
  for (const [expression, message] of bad)
    assert.throws(() => parseCron(expression), message, `"${expression}" should be rejected`);
});

test('the period between runs is measured from the next two matches', () => {
  const from = at('2026-11-01T00:00:00Z');
  assert.equal(cronPeriodMs('0 3 * * *', from), 24 * 3_600_000, 'daily');
  assert.equal(cronPeriodMs('@hourly', from), 3_600_000, 'hourly');
  assert.equal(cronPeriodMs('0 0 31 2 *', from), null, 'a schedule that never fires has no period');
});
