import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { createServer } from 'node:https';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { WebSocketServer } from 'ws';
import { Pki, identityUri, serverNames } from './pki.ts';
import { packageVersion } from './image.ts';
import { serverTlsOptions } from './tls-server.ts';

const exec = promisify(execFile);
test('live command selection sends exact services, eligible nodes and remote arguments without contaminating stdout', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-selection-live-'));
  const pki = await Pki.load(dir, true);
  const issued = await pki.issueServer(serverNames('https://localhost:8443'));
  const credential = (
    await pki.issueClient(identityUri('operator', 'test'), 86400000, 'https://localhost:8443')
  ).credential;
  const credentialFile = path.join(dir, 'operator.credential.json');
  await fs.writeFile(credentialFile, JSON.stringify(credential));
  const requests: string[] = [];
  const https = createServer(
    serverTlsOptions({ cert: issued.cert, key: issued.key, ca: pki.caPem }),
    (req, res) => {
      requests.push(req.url!);
      res.setHeader('content-type', 'application/json');
      // The CLI's skew check rides the stamped response; read commands no longer make a dedicated version request.
      res.setHeader('x-tug-version', packageVersion());
      if (req.url === '/api/v1/version') {
        res.end(JSON.stringify({ v: packageVersion() }));
        return;
      }
      res.end(
        JSON.stringify({
          services: [
            {
              name: 'web',
              nodes: [
                { name: 'app1', status: 'online' },
                { name: 'app2', status: 'online' },
              ],
            },
            { name: 'worker', nodes: [{ name: 'worker-only', status: 'online' }] },
          ],
        }),
      );
    },
  );
  const wss = new WebSocketServer({ server: https });
  const opened: Record<string, any>[] = [];
  wss.on('connection', (socket) =>
    socket.once('message', (data) => {
      const { request } = JSON.parse(data.toString());
      opened.push(request);
      const frame = (value: object) =>
        socket.send(JSON.stringify({ v: 1, sessionId: 's', ...value }));
      frame({ type: 'live.started', node: request.node, sessionId: 's' });
      if (request.operation === 'inspect' || request.operation === 'ps')
        frame({ type: 'live.result', value: { selected: request.node } });
      else
        frame({
          type: 'live.output',
          stream: 'stdout',
          data: Buffer.from('remote-output\n').toString('base64'),
        });
      frame({ type: 'live.exit', code: 0 });
    }),
  );
  https.listen(0, '127.0.0.1');
  await once(https, 'listening');
  const url = `https://127.0.0.1:${(https.address() as { port: number }).port}`;
  const fakeTerminal = `data:text/javascript,${encodeURIComponent('process.stdin.isTTY=true; process.stdout.isTTY=true;')}`;
  const run = (args: string[], answers: string[] = [], env: Record<string, string> = {}) => {
    const running = exec(
      process.execPath,
      ['--import', fakeTerminal, path.resolve('src/cli.ts'), ...args],
      {
        cwd: dir,
        env: {
          ...process.env,
          TUG_CONFIG: '',
          TUG_PROJECT: 'site',
          TUG_CREDENTIAL: '',
          TUG_CREDENTIAL_FILE: credentialFile,
          TUG_CONTROL_URL: url,
          CI: '',
          ...env,
        },
        timeout: 10000,
      },
    );
    let text = '';
    let answered = 0;
    running.child.stderr!.on('data', (data) => {
      text += String(data);
      const count = (text.match(/\(or q to cancel\): /g) || []).length;
      while (answered < count && answered < answers.length)
        running.child.stdin!.write(answers[answered++] + '\n');
    });
    return running;
  };
  try {
    for (const [args, operation, command] of [
      [
        ['exec', '--select', '--', 'printf', '%s', 'hello world'],
        'exec',
        ['printf', '%s', 'hello world'],
      ],
      [['run', '--select', '--', 'echo', '-n', 'hello'], 'exec', ['echo', '-n', 'hello']],
      [['logs', '--follow'], 'logs', undefined],
      [['inspect'], 'inspect', undefined],
    ] as [string[], string, string[] | undefined][]) {
      const result = await run(args, ['1', '2']);
      const sent = opened.at(-1)!;
      assert.equal(sent.service, 'web', `${args[0]} should use the selected service name`);
      assert.equal(sent.node, 'app2', `${args[0]} should use the selected eligible node`);
      assert.equal(sent.operation, operation, `${args[0]} should preserve its live operation`);
      if (command)
        assert.deepEqual(
          sent.command,
          command,
          `${args[0]} --select should preserve every remote command argument`,
        );
      assert.ok(!result.stdout.includes('Choose'), 'menus must not mix with remote output');
      assert.ok(
        !result.stderr.includes('3) worker-only'),
        'node choices must exclude nodes outside the selected service placement',
      );
      if (operation === 'inspect')
        assert.equal(
          JSON.parse(result.stdout).selected,
          'app2',
          'inspect JSON should remain parseable after selecting twice',
        );
      if (args[0] === 'run')
        assert.equal(sent.oneOff, true, 'run selection must preserve one-off container semantics');
    }
    await run(['ps'], ['3']);
    assert.equal(
      opened.at(-1)!.node,
      'worker-only',
      'ps should allow nodes placed for any project service',
    );
    const before = requests.length;
    await run(['exec', 'web', '--node', 'app1', '--', 'true']);
    assert.equal(
      requests.length,
      before + 1,
      'explicit service and node must bypass discovery entirely; only the per-process version preflight is added',
    );
    await assert.rejects(
      run(['exec'], [], { CI: '1' }),
      /selection requires a terminal outside CI/,
      'CI must never prompt even when stdin and stdout appear to be terminals',
    );
    assert.equal(
      requests.length,
      before + 1,
      'CI missing targets must fail before any contact: the explicit run added its one preflight request, the CI run adds none',
    );
  } finally {
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    https.closeAllConnections();
    await new Promise<void>((resolve) => https.close(() => resolve()));
    await fs.rm(dir, { recursive: true, force: true });
  }
});
