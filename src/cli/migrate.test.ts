import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  LAYOUT_VERSION,
  LEGACY_STATE_EXIT,
  MIGRATED_MARKER,
  agentGuardScript,
  agentMigrateScript,
  controlGuardScript,
  controlMigrateScript,
} from './migrate.ts';

/**
 * A fake `docker` that keeps volumes as directories and containers as JSON files, and runs the shell passed to
 * `docker run ... sh -c` against those directories, so the real migration scripts execute end to end.
 */
const FAKE_DOCKER = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = process.env.FAKE_DOCKER_ROOT;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(root, 'calls.log'), args.join(' ') + '\\n');
const volume = (name) => path.join(root, 'volumes', name);
const containerFile = (name) => path.join(root, 'containers', name + '.json');
const readContainer = (name) => (fs.existsSync(containerFile(name)) ? JSON.parse(fs.readFileSync(containerFile(name), 'utf8')) : null);
const writeContainer = (name, value) => fs.writeFileSync(containerFile(name), JSON.stringify(value));
const [cmd, sub] = args;
if (cmd === 'volume' && sub === 'inspect') process.exit(fs.existsSync(volume(args[2])) ? 0 : 1);
if (cmd === 'volume' && sub === 'create') { fs.mkdirSync(volume(args[2]), { recursive: true }); process.exit(0); }
if (cmd === 'image' || cmd === 'pull') process.exit(0);
if (cmd === 'inspect') {
  const container = readContainer(args[args.length - 1]);
  if (!container) process.exit(1);
  const format = args[args.indexOf('--format') + 1];
  process.stdout.write(format.includes('Config.Image') ? container.image : String(container.running));
  process.exit(0);
}
if (cmd === 'stop' || cmd === 'start') {
  if (cmd === 'start' && process.env.FAKE_DOCKER_FAIL_START) process.exit(1);
  const container = readContainer(args[1]);
  if (container) writeContainer(args[1], { ...container, running: cmd === 'start' });
  process.exit(0);
}
if (cmd === 'rm') { fs.appendFileSync(path.join(root, 'removed.log'), args.join(' ') + '\\n'); process.exit(0); }
if (cmd === 'compose') {
  const file = args[args.indexOf('-f') + 1];
  const text = fs.readFileSync(file, 'utf8');
  writeContainer('tug-control-control-1', { image: /image: "?([^"\\n]+)"?/.exec(text)[1], running: true, composeFile: text });
  process.exit(0);
}
if (cmd === 'exec') process.exit(0);
if (cmd === 'run') {
  const map = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '-v') continue;
    const [source, target] = args[i + 1].split(':');
    map[target] = path.isAbsolute(source) ? source : volume(source);
    if (!path.isAbsolute(source)) fs.mkdirSync(volume(source), { recursive: true });
  }
  let script = args[args.lastIndexOf('-c') + 1];
  if (process.env.FAKE_DOCKER_FAIL_COPY && script.includes('cp -a')) process.exit(1);
  for (const [target, dir] of Object.entries(map)) script = script.replace(new RegExp('(?<![\\\\w.-])' + target + '(?=[/ \\'"]|$)', 'g'), dir);
  process.exit(spawnSync('sh', ['-c', script], { stdio: 'inherit' }).status ?? 1);
}
process.exit(0);
`;

interface Fake {
  root: string;
  legacy: string;
  volume: (name: string) => string;
  env: NodeJS.ProcessEnv;
  calls: () => Promise<string>;
  setContainer: (name: string, container: { image: string; running: boolean }) => Promise<void>;
  container: (name: string) => Promise<{ image: string; running: boolean; composeFile?: string }>;
  run: (
    script: string,
    extra?: NodeJS.ProcessEnv,
  ) => { status: number; stdout: string; stderr: string };
}

async function fakeHost(): Promise<Fake> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-migrate-'));
  const bin = path.join(root, 'bin');
  await fs.mkdir(bin);
  for (const dir of ['volumes', 'containers', 'legacy']) await fs.mkdir(path.join(root, dir));
  await fs.writeFile(path.join(bin, 'docker'), FAKE_DOCKER, { mode: 0o755 });
  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    FAKE_DOCKER_ROOT: root,
  };
  const containerFile = (name: string) => path.join(root, 'containers', `${name}.json`);
  return {
    root,
    legacy: path.join(root, 'legacy'),
    volume: (name) => path.join(root, 'volumes', name),
    env,
    calls: () => fs.readFile(path.join(root, 'calls.log'), 'utf8').catch(() => ''),
    setContainer: (name, container) => fs.writeFile(containerFile(name), JSON.stringify(container)),
    container: async (name) => JSON.parse(await fs.readFile(containerFile(name), 'utf8')),
    run: (script, extra = {}) => {
      const result = spawnSync('sh', ['-c', script], {
        env: { ...env, ...extra },
        encoding: 'utf8',
      });
      return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
    },
  };
}

async function withHost(body: (host: Fake) => Promise<void>) {
  const host = await fakeHost();
  try {
    await body(host);
  } finally {
    await fs.rm(host.root, { recursive: true, force: true });
  }
}

const seedLegacyAgent = async (host: Fake) => {
  await fs.writeFile(path.join(host.legacy, 'agent.json'), '{"nodeName":"n1"}', { mode: 0o600 });
  await fs.writeFile(path.join(host.legacy, 'agent.db'), 'db');
  await fs.writeFile(path.join(host.legacy, 'agent.db-wal'), 'wal');
  await fs.writeFile(path.join(host.legacy, 'agent.db-shm'), 'shm');
};

test('the agent guard lets a host with no legacy state through without touching Docker', async () => {
  await withHost(async (host) => {
    const result = host.run(agentGuardScript('tug:1', 'n1', host.legacy));
    assert.equal(result.status, 0, 'a fresh host with no old state directory is not refused');
    assert.equal(
      await host.calls(),
      '',
      'the guard asks Docker nothing when there is no legacy state to protect',
    );
  });
});

test('the agent guard refuses a host that still keeps its identity in the old directory, naming the migrate command', async () => {
  await withHost(async (host) => {
    await seedLegacyAgent(host);
    const result = host.run(agentGuardScript('tug:1', 'n1', host.legacy));
    assert.equal(
      result.status,
      LEGACY_STATE_EXIT,
      'an unmigrated host is refused with the dedicated exit code',
    );
    assert.match(
      result.stderr,
      /tug node migrate n1/,
      'the refusal tells the operator which command to run',
    );
    await fs.rm(path.join(host.legacy, 'agent.json'));
    await fs.writeFile(path.join(host.legacy, 'agent-pending.json'), '{}');
    assert.equal(
      host.run(agentGuardScript('tug:1', 'n1', host.legacy)).status,
      LEGACY_STATE_EXIT,
      'an interrupted enrollment (only agent-pending.json) is protected as well',
    );
  });
});

test('the agent guard passes once the volume holds the identity or the migration marker', async () => {
  await withHost(async (host) => {
    await seedLegacyAgent(host);
    await fs.mkdir(host.volume('tug-agent'));
    assert.equal(
      host.run(agentGuardScript('tug:1', 'n1', host.legacy)).status,
      LEGACY_STATE_EXIT,
      'an empty volume does not count as migrated',
    );
    await fs.writeFile(path.join(host.volume('tug-agent'), MIGRATED_MARKER), `${LAYOUT_VERSION}\n`);
    assert.equal(
      host.run(agentGuardScript('tug:1', 'n1', host.legacy)).status,
      0,
      'the marker means the volume is seeded',
    );
    await fs.rm(path.join(host.volume('tug-agent'), MIGRATED_MARKER));
    await fs.writeFile(path.join(host.volume('tug-agent'), 'agent.json'), '{}');
    assert.equal(
      host.run(agentGuardScript('tug:1', 'n1', host.legacy)).status,
      0,
      'a volume that already holds an identity (for example from node enroll) is not refused',
    );
  });
});

test('agent migration stops the old agent, copies state with modes and SQLite side files, and marks the volume last', async () => {
  await withHost(async (host) => {
    await seedLegacyAgent(host);
    await host.setContainer('tug-agent', { image: 'tug:old', running: true });
    const result = host.run(agentMigrateScript('tug:new', host.legacy));
    assert.equal(result.status, 0, `migration succeeds: ${result.stderr}`);
    const volume = host.volume('tug-agent');
    for (const file of ['agent.json', 'agent.db', 'agent.db-wal', 'agent.db-shm'])
      assert.ok(
        await fs.stat(path.join(volume, file)).catch(() => null),
        `${file} is copied into the volume (the -wal and -shm files belong to agent.db)`,
      );
    assert.equal(
      (await fs.stat(path.join(volume, 'agent.json'))).mode & 0o777,
      0o600,
      'agent.json keeps its 0600 mode, since it holds the node key',
    );
    assert.equal(
      (await fs.readFile(path.join(volume, MIGRATED_MARKER), 'utf8')).trim(),
      String(LAYOUT_VERSION),
      'the marker records the layout version',
    );
    assert.ok(
      await fs.stat(path.join(host.legacy, 'agent.json')),
      'the old directory is left in place as a fallback',
    );
    assert.equal(
      (await host.container('tug-agent')).running,
      false,
      'the old agent is stopped so its database is copied consistently',
    );
    const calls = await host.calls();
    assert.match(calls, /stop tug-agent/, 'the agent is stopped before the copy');
    assert.doesNotMatch(
      calls,
      /^rm /m,
      'the old agent container is stopped, never removed, so a failure can start it again',
    );
    assert.match(calls, /tug:old/, 'the copy runs from the image the old agent runs');
    assert.equal(
      host.run(agentGuardScript('tug:new', 'n1', host.legacy)).status,
      0,
      'after migration the install guard lets the install through',
    );
  });
});

test('agent migration run twice leaves a seeded volume untouched', async () => {
  await withHost(async (host) => {
    await seedLegacyAgent(host);
    assert.equal(
      host.run(agentMigrateScript('tug:new', host.legacy)).status,
      0,
      'first migration succeeds',
    );
    await fs.writeFile(path.join(host.volume('tug-agent'), 'agent.db'), 'changed since');
    const again = host.run(agentMigrateScript('tug:new', host.legacy));
    assert.equal(again.status, 0, 'a rerun completes');
    assert.equal(
      await fs.readFile(path.join(host.volume('tug-agent'), 'agent.db'), 'utf8'),
      'changed since',
      'a rerun never overwrites a volume that carries the marker',
    );
  });
});

test('agent migration recopies a volume that has no marker and refuses one holding another identity', async () => {
  await withHost(async (host) => {
    await seedLegacyAgent(host);
    const volume = host.volume('tug-agent');
    await fs.mkdir(volume);
    await fs.writeFile(path.join(volume, 'agent.json'), '{"nodeName":"n1"}');
    await fs.writeFile(path.join(volume, 'stale.tmp'), 'leftover of an interrupted copy');
    assert.equal(
      host.run(agentMigrateScript('tug:new', host.legacy)).status,
      0,
      'a half-copied volume is completed',
    );
    assert.ok(
      !(await fs.stat(path.join(volume, 'stale.tmp')).catch(() => null)),
      'leftovers of an interrupted copy are cleared',
    );
    assert.ok(
      await fs.stat(path.join(volume, MIGRATED_MARKER)),
      'the marker is written once the copy is whole',
    );

    await fs.rm(path.join(volume, MIGRATED_MARKER));
    await fs.writeFile(path.join(volume, 'agent.json'), '{"nodeName":"another"}');
    await host.setContainer('tug-agent', { image: 'tug:old', running: true });
    const refused = host.run(agentMigrateScript('tug:new', host.legacy));
    assert.notEqual(refused.status, 0, 'a volume with a different identity is never overwritten');
    assert.equal(
      await fs.readFile(path.join(volume, 'agent.json'), 'utf8'),
      '{"nodeName":"another"}',
      'the foreign identity is left exactly as it was',
    );
    assert.equal(
      (await host.container('tug-agent')).running,
      true,
      'the old agent is started again after a refused copy',
    );
  });
});

test('agent migration starts the old agent again when the copy fails', async () => {
  await withHost(async (host) => {
    await seedLegacyAgent(host);
    await host.setContainer('tug-agent', { image: 'tug:old', running: true });
    const result = host.run(agentMigrateScript('tug:new', host.legacy), {
      FAKE_DOCKER_FAIL_COPY: '1',
    });
    assert.notEqual(result.status, 0, 'a failed copy fails the migration');
    assert.match(
      result.stderr,
      /old agent was started again/,
      'the operator is told the node is still running as before',
    );
    assert.equal(
      (await host.container('tug-agent')).running,
      true,
      'the node keeps running on its old state',
    );
  });
});

test('agent migration with nothing to migrate succeeds without touching the agent', async () => {
  await withHost(async (host) => {
    await host.setContainer('tug-agent', { image: 'tug:old', running: true });
    const result = host.run(agentMigrateScript('tug:new', host.legacy));
    assert.equal(result.status, 0, 'a host with no legacy state has nothing to do');
    assert.match(result.stdout, /nothing to migrate/, 'the output says so');
    assert.equal(
      (await host.container('tug-agent')).running,
      true,
      'the running agent is not stopped',
    );
  });
});

const COMPOSE = `services:
  control:
    image: "ghcr.io/wpelevator/tug:1.2.0"
    ports:
      - "9099:8443"
    volumes:
      - LEGACY:/data
      - /var/run/docker.sock:/var/run/docker.sock
`;

test('the control guard refuses a host whose control data is still in the old directory', async () => {
  await withHost(async (host) => {
    await fs.writeFile(path.join(host.legacy, 'tug.db'), 'db');
    const refused = host.run(controlGuardScript('tug:1', host.legacy));
    assert.equal(
      refused.status,
      LEGACY_STATE_EXIT,
      'control setup must not start a second CA on an empty volume',
    );
    assert.match(refused.stderr, /tug control migrate/, 'the refusal names the migrate command');
    await fs.mkdir(host.volume('tug-control'));
    await fs.writeFile(path.join(host.volume('tug-control'), MIGRATED_MARKER), '1\n');
    assert.equal(
      host.run(controlGuardScript('tug:1', host.legacy)).status,
      0,
      'a seeded volume passes the guard',
    );
  });
});

test('control migration copies data, points Compose at the volume, restarts control and is safe to rerun', async () => {
  await withHost(async (host) => {
    await fs.writeFile(path.join(host.legacy, 'tug.db'), 'db');
    await fs.mkdir(path.join(host.legacy, 'pki'));
    await fs.writeFile(path.join(host.legacy, 'pki', 'ca.crt'), 'ca');
    const file = path.join(host.root, 'docker-compose.yml');
    await fs.writeFile(file, COMPOSE.replace('LEGACY', host.legacy));
    await host.setContainer('tug-control-control-1', {
      image: 'ghcr.io/wpelevator/tug:1.2.0',
      running: true,
    });
    const script = controlMigrateScript('', { legacyDir: host.legacy, file });
    const result = host.run(script);
    assert.equal(result.status, 0, `migration succeeds: ${result.stderr}`);
    assert.equal(
      await fs.readFile(path.join(host.volume('tug-control'), 'pki', 'ca.crt'), 'utf8'),
      'ca',
      'the CA is copied into the volume',
    );
    const compose = await fs.readFile(file, 'utf8');
    assert.match(compose, /- tug-control:\/data/, 'the Compose file mounts the volume');
    assert.doesNotMatch(
      compose,
      new RegExp(host.legacy),
      'the old host directory is no longer mounted',
    );
    assert.match(
      compose,
      /image: "ghcr.io\/wpelevator\/tug:1.2.0"/,
      'control keeps the image it was installed with',
    );
    assert.match(compose, /9099:8443/, 'control keeps its published port');
    assert.match(
      compose,
      /volumes:\n {2}tug-control:\n {4}external: true/,
      'the volume is declared external so Compose does not rename it',
    );
    assert.equal(
      (await host.container('tug-control-control-1')).running,
      true,
      'control runs again on the volume',
    );
    const again = host.run(script);
    assert.equal(again.status, 0, 'a rerun of a finished migration succeeds');
    assert.match(
      again.stdout,
      /already runs on the volume/,
      'and reports there is nothing left to do',
    );
  });
});

test('control migration restarts the old control when the copy fails and leaves the Compose file alone', async () => {
  await withHost(async (host) => {
    await fs.writeFile(path.join(host.legacy, 'tug.db'), 'db');
    const file = path.join(host.root, 'docker-compose.yml');
    const original = COMPOSE.replace('LEGACY', host.legacy);
    await fs.writeFile(file, original);
    await host.setContainer('tug-control-control-1', { image: 'tug:1', running: true });
    const result = host.run(controlMigrateScript('', { legacyDir: host.legacy, file }), {
      FAKE_DOCKER_FAIL_COPY: '1',
    });
    assert.notEqual(result.status, 0, 'a failed copy fails the migration');
    assert.equal(
      await fs.readFile(file, 'utf8'),
      original,
      'the Compose file is edited only after the copy succeeded',
    );
    assert.equal(
      (await host.container('tug-control-control-1')).running,
      true,
      'control keeps running on its old data',
    );
  });
});
