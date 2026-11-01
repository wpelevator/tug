import test from 'node:test';
import assert from 'node:assert/strict';
import { SKEW_FAIL_MS, SKEW_WARN_MS, certificateExpiry, diagnoseNode } from './diagnostics.ts';
import type { NodeDiagnosticInput } from './diagnostics.ts';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-01T12:00:00.000Z');
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

test('certificateExpiry reports ok, expiring and expired against the warning window', () => {
  assert.equal(
    certificateExpiry(new Date(NOW + 60 * DAY), NOW, 30).state,
    'ok',
    'a certificate with more than the warning window left is ok',
  );
  const expiring = certificateExpiry(new Date(NOW + 10 * DAY + 1000), NOW, 30);
  assert.equal(expiring.state, 'expiring', 'a certificate inside the warning window is expiring');
  assert.equal(expiring.daysLeft, 10, 'the remaining time is reported in whole days');
  assert.equal(
    certificateExpiry(new Date(NOW - 1), NOW, 30).state,
    'expired',
    'a certificate past notAfter is expired',
  );
});

const node = (over: Partial<NodeDiagnosticInput> = {}): NodeDiagnosticInput => ({
  name: 'n1',
  disabled_at: null,
  last_seen_at: iso(-5000),
  cert_not_after: iso(60 * DAY),
  clock_skew_ms: 1200,
  clock_observed_at: iso(-5000),
  ...over,
});

test('an online node reports its observed clock skew and no problems', () => {
  const d = diagnoseNode(node(), NOW, 60);
  assert.equal(d.connectivity, 'online', 'a node seen within the stale window is online');
  assert.deepEqual(
    d.clockSkew,
    { state: 'observed', ms: 1200, observedAt: iso(-5000) },
    'an online node has an observed skew',
  );
  assert.deepEqual(
    [d.problems, d.warnings],
    [[], []],
    'a small skew and a fresh certificate are fine',
  );
});

test('an offline node has an unknown clock, not the last observed skew', () => {
  const stale = diagnoseNode(
    node({ last_seen_at: iso(-600_000), clock_observed_at: iso(-600_000), clock_skew_ms: 0 }),
    NOW,
    60,
  );
  assert.equal(stale.connectivity, 'stale', 'a node silent past the stale window is stale');
  assert.deepEqual(
    stale.clockSkew,
    { state: 'unknown', reason: 'offline' },
    'a stale node must not show an old observation as its current clock',
  );
  const never = diagnoseNode(
    node({ last_seen_at: null, clock_skew_ms: null, clock_observed_at: null }),
    NOW,
    60,
  );
  assert.equal(
    never.connectivity,
    'never-seen',
    'a registered node that never reported is never-seen',
  );
  assert.deepEqual(
    never.clockSkew,
    { state: 'unknown', reason: 'never reported' },
    'a node that never reported has an unknown clock',
  );
});

test('skew warns at the warning threshold and fails when certificates would look not yet valid', () => {
  const warn = diagnoseNode(node({ clock_skew_ms: SKEW_WARN_MS + 1000 }), NOW, 60);
  assert.equal(warn.problems.length, 0, 'a moderate skew does not fail the diagnostics');
  assert.match(warn.warnings[0], /clock differs/, 'a moderate skew is reported as a warning');
  const behind = diagnoseNode(node({ clock_skew_ms: -SKEW_FAIL_MS - 1000 }), NOW, 60);
  assert.match(
    behind.problems[0],
    /clock differs.*fix time sync on node n1/,
    'a skew beyond the certificate back-dating fails and names the remedy',
  );
});

test('node certificate expiry fails when expired, warns when renewal is overdue and spares disabled nodes', () => {
  const expired = diagnoseNode(node({ cert_not_after: iso(-DAY) }), NOW, 60);
  assert.match(
    expired.problems[0],
    /certificate expired.*node-replace-identity n1/,
    'an expired node certificate fails and points at node-replace-identity',
  );
  const expiring = diagnoseNode(node({ cert_not_after: iso(5 * DAY) }), NOW, 60);
  assert.equal(expiring.problems.length, 0, 'a soon-expiring certificate is not a failure yet');
  assert.match(
    expiring.warnings[0],
    /expires in 5 days and has not renewed/,
    'renewal overdue is a warning',
  );
  const disabled = diagnoseNode(
    node({ disabled_at: iso(-DAY), cert_not_after: iso(-DAY), last_seen_at: null }),
    NOW,
    60,
  );
  assert.equal(
    disabled.problems.length,
    0,
    'an expired certificate on a disabled node is not a failure',
  );
  assert.equal(disabled.warnings.length, 1, 'it is still reported as a warning');
  assert.deepEqual(
    disabled.clockSkew,
    { state: 'unknown', reason: 'disabled' },
    'a disabled node has no observable clock',
  );
});
