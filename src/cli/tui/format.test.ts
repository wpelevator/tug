import test from 'node:test';
import assert from 'node:assert/strict';
import { ageOf, createStyle, fit, sanitize, wantsColor } from './format.ts';
import { columnWidth } from '../width.ts';

test('sanitize removes terminal escape sequences and control characters from untrusted text', () => {
  assert.equal(sanitize('ok\x1b[31mred\x1b[0m'), 'okred', 'colour codes are removed');
  assert.equal(
    sanitize('a\x1b]0;title\x07b'),
    'ab',
    'an OSC title sequence ending in BEL is removed',
  );
  assert.equal(
    sanitize('a\x1b]52;c;ZGF0YQ==\x1b\\b'),
    'ab',
    'an OSC clipboard sequence ending in ST is removed',
  );
  assert.equal(
    sanitize('a\x1b[2Jb\x1b[Hc'),
    'abc',
    'screen-clearing and cursor-moving sequences are removed',
  );
  assert.equal(
    sanitize('tab\there\r\nnext\x00nul\x07bell'),
    'tab here  next nul bell',
    'remaining control characters become spaces',
  );
  assert.equal(sanitize('日本語 ünïcode'), '日本語 ünïcode', 'printable text is untouched');
});

test('ageOf reports the largest whole unit and a dash for missing or invalid times', () => {
  const now = Date.parse('2026-11-09T12:00:00Z');
  const at = (seconds: number) => new Date(now - seconds * 1000).toISOString();
  assert.deepEqual(
    [at(3), at(59), at(60), at(3599), at(3600), at(86399), at(86400), at(3 * 86400)].map((iso) =>
      ageOf(iso, now),
    ),
    ['3s', '59s', '1m', '59m', '1h', '23h', '1d', '3d'],
    'ages step through seconds, minutes, hours and days',
  );
  assert.equal(ageOf(null, now), '-', 'a missing time is a dash');
  assert.equal(ageOf('not a date', now), '-', 'an invalid time is a dash');
  assert.equal(
    ageOf(new Date(now + 5000).toISOString(), now),
    '0s',
    'a time slightly in the future is not negative',
  );
});

test('fit pads and clips by terminal columns, so wide characters keep columns aligned', () => {
  assert.equal(columnWidth(fit('ab', 5)), 5, 'short text is padded');
  assert.equal(
    columnWidth(fit('日本語日本語', 7)),
    7,
    'wide text is clipped to the column count, with the ellipsis',
  );
  assert.equal(fit('anything', 0), '', 'a zero-width column is empty');
});

test('colour is off for a non-terminal, NO_COLOR and a dumb terminal, and the plain style adds nothing', () => {
  assert.equal(wantsColor(true, {}), true, 'a terminal gets colour');
  assert.equal(wantsColor(false, {}), false, 'a pipe does not');
  assert.equal(wantsColor(true, { NO_COLOR: '1' }), false, 'NO_COLOR turns it off');
  assert.equal(wantsColor(true, { TERM: 'dumb' }), false, 'a dumb terminal gets none');
  assert.equal(createStyle(false).tone('error', 'x'), 'x', 'the plain style leaves text alone');
});
