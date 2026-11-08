/** A small UTC cron parser for `x-tug.backup.schedule`: five fields, lists, ranges, steps and `@` aliases. */

export interface CronSchedule {
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  days: ReadonlySet<number>;
  months: ReadonlySet<number>;
  weekdays: ReadonlySet<number>;
  /** True when the field was `*`; cron matches day-of-month OR day-of-week when neither is. */
  anyDay: boolean;
  anyWeekday: boolean;
}

const ALIASES: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
};

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day of week', min: 0, max: 7 },
] as const;

function parseNumber(text: string, field: { name: string; min: number; max: number }): number {
  if (!/^\d+$/.test(text)) throw new Error(`${field.name} "${text}" is not a number`);
  const value = Number(text);
  if (value < field.min || value > field.max)
    throw new Error(`${field.name} ${value} is outside ${field.min}-${field.max}`);
  return value;
}

function parseField(text: string, field: (typeof FIELDS)[number]): Set<number> {
  const values = new Set<number>();
  for (const part of text.split(',')) {
    if (!part) throw new Error(`${field.name} has an empty list item`);
    const [range, stepText, extra] = part.split('/');
    if (extra !== undefined) throw new Error(`${field.name} "${part}" has more than one step`);
    let step = 1;
    if (stepText !== undefined) {
      step = parseNumber(stepText, { name: `${field.name} step`, min: 1, max: field.max });
    }
    let low: number;
    let high: number;
    if (range === '*') {
      low = field.min;
      high = field.name === 'day of week' ? 6 : field.max;
    } else if (range.includes('-')) {
      const [from, to, more] = range.split('-');
      if (more !== undefined) throw new Error(`${field.name} range "${range}" is malformed`);
      low = parseNumber(from, field);
      high = parseNumber(to, field);
      if (low > high) throw new Error(`${field.name} range "${range}" runs backwards`);
    } else {
      low = parseNumber(range, field);
      high = stepText === undefined ? low : field.max;
    }
    for (let value = low; value <= high; value += step) values.add(value);
  }
  return values;
}

/** Parse a five-field cron expression or an `@hourly`-style alias. Throws a readable `Error` on bad input. */
export function parseCron(expression: string): CronSchedule {
  if (typeof expression !== 'string') throw new Error('schedule must be a string');
  const text = ALIASES[expression.trim().toLowerCase()] ?? expression.trim();
  const parts = text.split(/\s+/);
  if (parts.length !== 5)
    throw new Error(
      `schedule "${expression}" must have five fields (minute hour day month weekday) or be one of ${Object.keys(ALIASES).join(', ')}`,
    );
  const [minutes, hours, days, months, weekdays] = parts.map((part, index) =>
    parseField(part, FIELDS[index]),
  );
  // Both 0 and 7 mean Sunday.
  if (weekdays.delete(7)) weekdays.add(0);
  return {
    minutes,
    hours,
    days,
    months,
    weekdays,
    anyDay: parts[2].startsWith('*'),
    anyWeekday: parts[4].startsWith('*'),
  };
}

function dayMatches(schedule: CronSchedule, date: Date): boolean {
  const dayOk = schedule.days.has(date.getUTCDate());
  const weekdayOk = schedule.weekdays.has(date.getUTCDay());
  if (!schedule.anyDay && !schedule.anyWeekday) return dayOk || weekdayOk;
  return dayOk && weekdayOk;
}

/** Longest gap between two matches is a Feb 29 across a skipped century leap year: eight years. */
const SEARCH_YEARS = 9;

/** The first matching minute strictly after `after` (UTC), or `null` when the schedule never fires (such as Feb 31). */
export function nextCronRun(schedule: CronSchedule | string, after: Date): Date | null {
  const parsed = typeof schedule === 'string' ? parseCron(schedule) : schedule;
  const next = new Date(Math.floor(after.getTime() / 60_000) * 60_000 + 60_000);
  const limit = next.getUTCFullYear() + SEARCH_YEARS;
  while (next.getUTCFullYear() <= limit) {
    if (!parsed.months.has(next.getUTCMonth() + 1)) {
      next.setUTCMonth(next.getUTCMonth() + 1, 1);
      next.setUTCHours(0, 0, 0, 0);
    } else if (!dayMatches(parsed, next)) {
      next.setUTCDate(next.getUTCDate() + 1);
      next.setUTCHours(0, 0, 0, 0);
    } else if (!parsed.hours.has(next.getUTCHours())) {
      next.setUTCHours(next.getUTCHours() + 1, 0, 0, 0);
    } else if (!parsed.minutes.has(next.getUTCMinutes())) {
      next.setUTCMinutes(next.getUTCMinutes() + 1, 0, 0);
    } else {
      return next;
    }
  }
  return null;
}

/** Approximate gap between runs in milliseconds, from the next two matches after `from`; used to size deadlines and staleness. */
export function cronPeriodMs(schedule: CronSchedule | string, from: Date): number | null {
  const first = nextCronRun(schedule, from);
  const second = first && nextCronRun(schedule, first);
  return first && second ? second.getTime() - first.getTime() : null;
}
