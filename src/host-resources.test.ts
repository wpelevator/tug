import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FakeDocker } from '../tests/fake-docker.ts';
import {
  collectResources,
  containerUsage,
  ownContainer,
  parseLoadavg,
  parseMeminfo,
} from './host-resources.ts';

test('parseLoadavg reads the three load averages and rejects garbage', () => {
  assert.deepEqual(
    parseLoadavg('0.52 0.40 0.31 1/312 9999\n', 4),
    { one: 0.52, five: 0.4, fifteen: 0.31, cpus: 4 },
    'the first three fields of /proc/loadavg are the 1, 5 and 15 minute averages',
  );
  assert.equal(parseLoadavg('nonsense', 4), undefined, 'unparseable text yields no load');
});

test('parseMeminfo reports MemAvailable, not MemFree, as available memory', () => {
  const text =
    'MemTotal:        2048000 kB\nMemFree:          100000 kB\nMemAvailable:    1024000 kB\n';
  assert.deepEqual(
    parseMeminfo(text),
    { totalBytes: 2048000 * 1024, availableBytes: 1024000 * 1024 },
    'reclaimable cache counts as available, so a busy page cache is not reported as low memory',
  );
  assert.equal(
    parseMeminfo('MemTotal: 5 kB\n'),
    undefined,
    'a kernel without MemAvailable yields no memory',
  );
});

test('containerUsage computes CPU like docker stats and leaves cache out of memory', () => {
  const usage = containerUsage('tug-agent', {
    cpu_stats: { cpu_usage: { total_usage: 300 }, system_cpu_usage: 2000, online_cpus: 2 },
    precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 1000 },
    memory_stats: { usage: 100 * 2 ** 20, stats: { inactive_file: 40 * 2 ** 20 } },
  });
  assert.equal(
    usage.cpuPercent,
    40,
    'cpu delta 200 of system delta 1000 on 2 CPUs is 40 percent of one core',
  );
  assert.equal(usage.memoryBytes, 60 * 2 ** 20, 'inactive file cache is subtracted from the usage');
  const first = containerUsage('x', { cpu_stats: { cpu_usage: { total_usage: 5 } } });
  assert.equal(first.cpuPercent, undefined, 'a sample without a previous one has no CPU figure');
});

test('collectResources reads proc files, disk and containers, and reports a missing container instead of failing', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-res-'));
  try {
    await fs.writeFile(path.join(dir, 'loadavg'), '1.00 2.00 3.00 1/2 3\n');
    await fs.writeFile(path.join(dir, 'meminfo'), 'MemTotal: 1000 kB\nMemAvailable: 500 kB\n');
    const docker = new FakeDocker();
    docker.info_ = { ...docker.info_, DockerRootDir: '/var/lib/docker' };
    docker.addImage('img');
    await docker.createContainer('tug-agent', { Image: 'img' } as never);
    docker.statsByName.set('tug-agent', {
      cpu_stats: { cpu_usage: { total_usage: 20 }, system_cpu_usage: 200, online_cpus: 1 },
      precpu_stats: { cpu_usage: { total_usage: 10 }, system_cpu_usage: 100 },
      memory_stats: { usage: 2048 },
    });
    const resources = await collectResources(docker, {
      diskPath: dir,
      proc: dir,
      containers: [
        { id: 'tug-agent', label: 'tug-agent' },
        { id: 'tug-caddy', label: 'tug-caddy' },
      ],
    });
    assert.equal(resources.load?.one, 1, 'load comes from the proc directory');
    assert.equal(
      resources.memory?.availableBytes,
      500 * 1024,
      'available memory comes from meminfo',
    );
    assert.ok(
      resources.disk && resources.disk.freeBytes > 0,
      'disk free is read from the filesystem of the path',
    );
    assert.equal(
      resources.disk?.dockerRoot,
      '/var/lib/docker',
      'the Docker data root is named from the daemon',
    );
    assert.equal(resources.containers[0].cpuPercent, 10, 'the agent container CPU is reported');
    assert.match(
      resources.containers[1].error ?? '',
      /No such container/,
      'a container that does not exist is reported with its error, not thrown',
    );
    const bare = await collectResources(docker, {
      diskPath: path.join(dir, 'missing'),
      proc: path.join(dir, 'missing'),
      containers: [],
    });
    assert.deepEqual(
      { load: bare.load, memory: bare.memory, disk: bare.disk },
      { load: undefined, memory: undefined, disk: undefined },
      'values that cannot be read are left out',
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('ownContainer falls back to the named container and is undefined when neither exists', async () => {
  const docker = new FakeDocker();
  assert.equal(
    await ownContainer(docker, 'tug-agent'),
    undefined,
    'no matching container gives no name',
  );
  docker.addImage('img');
  await docker.createContainer('tug-agent', { Image: 'img' } as never);
  assert.equal(
    await ownContainer(docker, 'tug-agent'),
    'tug-agent',
    'the fallback name is used outside a container',
  );
});
