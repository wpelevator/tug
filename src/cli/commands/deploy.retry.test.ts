import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startMtlsControl } from '../../../tests/helpers.ts';
import { execCli } from '../../../tests/cli-inprocess.ts';

async function withControl(
  run: (tug: (args: string[]) => Promise<{ stdout: string; stderr: string }>) => Promise<void>,
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-retry-cli-'));
  const control = await startMtlsControl(dir);
  try {
    await control.registerNode('n1');
    await fs.writeFile(path.join(dir, 'compose.yaml'), 'services:\n  web:\n    image: nginx:1\n');
    await run((args) =>
      execCli(args, {
        cwd: dir,
        env: { ...process.env, ...control.env, TUG_CREDENTIAL: '', CI: '1' },
      }),
    );
  } finally {
    await control.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('deploy --retry only retries a failed deployment, and says what the deployment is instead', async () => {
  await withControl(async (tug) => {
    const deployed = JSON.parse(
      (await tug(['deploy', '--no-wait', '--json', '--project', 'shop'])).stdout,
    );
    await assert.rejects(
      tug(['deploy', '--retry', '--no-wait', '--project', 'shop']),
      new RegExp(
        `deployment ${deployed.deployment.id} is rolling_out; only a failed deployment can be retried`,
      ),
      'a deployment that is still rolling out is not retried',
    );
    await assert.rejects(
      tug(['deploy', '--retry', '--project', 'nothing-here']),
      /project nothing-here has no desired state/,
      'a project that was never deployed is named in the error',
    );
  });
});

test('deploy --retry takes no option that would change what runs', async () => {
  await withControl(async (tug) => {
    await assert.rejects(
      tug(['deploy', '--retry', '--build', '--var', 'A=1', '--project', 'shop']),
      /--retry runs the failed deployment again as it is and cannot be combined with --build, --var/,
      'options that change the deployed state are refused with --retry',
    );
  });
});
