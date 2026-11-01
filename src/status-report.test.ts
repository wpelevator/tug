import test from 'node:test';
import assert from 'node:assert/strict';
import { StatusReportError, isPort, parseStatusReport } from './status-report.ts';

const project = (extra: Record<string, unknown> = {}) => ({
  project: 'site',
  observedVersion: 'v1',
  health: 'serving',
  ...extra,
});

test('ports are integers from 1 to 65535 and never strings or fractions', () => {
  for (const ok of [1, 80, 65535]) assert.equal(isPort(ok), true, `${ok} should be a valid port`);
  for (const bad of [0, 65536, -1, 80.5, '80', '80 {', NaN, null, undefined, {}])
    assert.equal(isPort(bad), false, `${JSON.stringify(bad)} should not be a valid port`);
});

test('a well-formed report is normalized and unknown fields are dropped', () => {
  const report = parseStatusReport({
    node: 'n1',
    projects: [
      project({
        injected: 'x',
        serviceStates: { web: { rolloutState: 'serving', port: 8080, extra: 1 } },
      }),
    ],
    commandResults: [{ commandId: 'c1', state: 'failed', result: { error: 'boom' } }],
    jobs: [{ commandId: 'c1', runId: 'r1', phase: 'dumping', startedAt: 't' }],
  });
  assert.deepEqual(
    report.projects[0],
    {
      project: 'site',
      observedVersion: 'v1',
      health: 'serving',
      serviceStates: { web: { rolloutState: 'serving', port: 8080 } },
    },
    'only protocol fields survive',
  );
  assert.equal(report.commandResults[0].state, 'failed');
});

test('malformed reports are refused with the offending path', () => {
  const cases: [unknown, RegExp][] = [
    [null, /must be an object/],
    [{ projects: 'x' }, /projects must be an array/],
    [{ projects: [project({ health: 'great' })] }, /health must be one of/],
    [{ projects: [project({ observedVersion: 1 })] }, /observedVersion must be a string/],
    [
      {
        projects: [project({ serviceStates: { web: { rolloutState: 'serving', port: '80\n' } } })],
      },
      /port must be an integer/,
    ],
    [
      { projects: [project({ serviceStates: { web: { rolloutState: 'nope' } } })] },
      /rolloutState must be one of/,
    ],
    [{ commandResults: [{ commandId: 'c', state: 'running' }] }, /succeeded or failed/],
    [
      { jobs: [{ commandId: 'c', runId: 'r', phase: 'x', startedAt: 't' }] },
      /phase must be one of/,
    ],
    [{ ingress: { state: 'serving', configHash: 'h', routes: -1 } }, /routes must be/],
  ];
  for (const [body, message] of cases)
    assert.throws(
      () => parseStatusReport(body),
      (error) => error instanceof StatusReportError && message.test(error.message),
      `${JSON.stringify(body)} should be refused with ${message}`,
    );
});
