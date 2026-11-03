import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as tar from 'tar';
import { transferTugImage } from './host.ts';

test('runtime image transfer reports build, export, copy and load in order and cleans temporary archives', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-transfer-progress-'));
  const previousPath = process.env.PATH;
  const stages: string[] = [];
  const commandsFile = path.join(dir, 'commands.jsonl');
  try {
    const config = JSON.stringify({ os: 'linux', architecture: 'amd64', config: {} });
    const digest = createHash('sha256').update(config).digest('hex');
    await fs.writeFile(path.join(dir, `${digest}.json`), config);
    await fs.writeFile(
      path.join(dir, 'manifest.json'),
      JSON.stringify([{ Config: `${digest}.json`, RepoTags: ['tug:local'], Layers: [] }]),
    );
    const archive = path.join(dir, 'image.tar');
    await tar.c({ cwd: dir, file: archive }, ['manifest.json', `${digest}.json`]);
    const stub =
      '#!' +
      process.execPath +
      '\n' +
      `
const fs = require('node:fs');
const path = require('node:path');
const cmd = path.basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(commandsFile)}, JSON.stringify([cmd, ...args]) + '\\n');
if (args.at(-1) === 'uname -m') process.stdout.write('x86_64');
if (cmd === 'docker' && args[0] === 'save') process.stdout.write(fs.readFileSync(${JSON.stringify(archive)}));
`;
    for (const cmd of ['ssh', 'docker', 'scp'])
      await fs.writeFile(path.join(dir, cmd), stub, { mode: 0o755 });
    process.env.PATH = dir + path.delimiter + previousPath;
    await transferTugImage('root@host', 'tug:local', (label) => stages.push(label));
    assert.deepEqual(
      stages,
      [
        'Checking architecture on root@host',
        'Building Tug image tug:local',
        'Exporting Tug image tug:local',
        'Transferring Tug image to root@host',
        'Loading Tug image on root@host',
      ],
      "transfers must report the active operation in execution order through the caller's progress helper",
    );
    const commands: string[][] = (await fs.readFile(commandsFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      commands[1],
      ['docker', 'build', '--platform', 'linux/amd64', '-t', 'tug:local', '.'],
      'async builds must still target the host architecture',
    );
    const copiedArchive = commands.find(([cmd]) => cmd === 'scp')![2];
    await assert.rejects(
      fs.access(copiedArchive),
      { code: 'ENOENT' },
      'successful transfers must remove temporary local archives',
    );
    await fs.writeFile(path.join(dir, 'docker'), '#!' + process.execPath + '\nprocess.exit(9);\n', {
      mode: 0o755,
    });
    stages.length = 0;
    await assert.rejects(
      transferTugImage('root@host', 'tug:local', (label) => stages.push(label)),
      /exit 9/,
      'failed builds must preserve the child exit error',
    );
    assert.deepEqual(
      stages,
      ['Checking architecture on root@host', 'Building Tug image tug:local'],
      'failed builds must not claim to export or transfer an image',
    );
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
