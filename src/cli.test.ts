import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import yaml from 'js-yaml';
import * as tar from 'tar';
import { writeCredentialFile } from '../tests/helpers.ts';
import { resolveCliConfig, integerOption } from './cli-config.ts';
import { createSourceArchive, prepareLocalImages } from './cli-build.ts';
import {
  controlPortCheck,
  dockerPlatform,
  dockerRunSnippet,
  enrollmentCloudInit,
  localImageBuildArgs,
  shellQuote,
} from './cli-install.ts';

const exec = promisify(execFile);
const entry = path.resolve('src/cli.ts');

test('connection resolution consistently uses explicit options, then environment, then selected config', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-config-'));
  try {
    await fs.writeFile(
      path.join(dir, 'chosen.json'),
      JSON.stringify({ controlUrl: 'https://config.test', project: 'config-project' }),
    );
    await writeCredentialFile(path.join(dir, 'config-cred.json'));
    await writeCredentialFile(path.join(dir, 'env-cred.json'));
    await fs.writeFile(
      path.join(dir, 'chosen.local.json'),
      JSON.stringify({ credential: 'config-cred.json' }),
    );
    const env = {
      TUG_CONFIG: 'chosen.json',
      TUG_CONTROL_URL: 'https://env.test',
      TUG_CREDENTIAL_FILE: 'env-cred.json',
      TUG_PROJECT: 'env-project',
    };
    const explicit = await resolveCliConfig(
      { controlUrl: 'https://flag.test/', project: 'flag-project' },
      env,
      dir,
    );
    assert.equal(
      explicit.controlUrl,
      'https://flag.test',
      'explicit control URL should override environment and config and normalize trailing slash',
    );
    assert.equal(
      explicit.project,
      'flag-project',
      'explicit project should override environment and config',
    );
    assert.equal(
      path.basename(explicit.credentialFile!),
      'env-cred.json',
      'the environment credential should override the config credential',
    );
    const environment = await resolveCliConfig({}, env, dir);
    assert.equal(
      environment.controlUrl,
      'https://env.test',
      'environment control URL should override selected config',
    );
    assert.equal(
      environment.project,
      'env-project',
      'environment project should override selected config',
    );
    const config = await resolveCliConfig({ config: 'chosen.json' }, {}, dir);
    assert.equal(
      config.project,
      'config-project',
      'selected config should provide the project without explicit or environment values',
    );
    assert.equal(
      path.basename(config.credentialFile!),
      'config-cred.json',
      'the selected config overlay should provide the credential without an environment credential',
    );
    const fallback = await resolveCliConfig({}, {}, dir);
    assert.equal(
      fallback.controlUrl,
      'https://localhost:8443',
      'missing implicit config should use the documented local control URL',
    );
    assert.equal(
      fallback.project,
      'site',
      'missing implicit config should use the documented default project',
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('invalid and explicitly missing config produce errors instead of silently selecting another control plane', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-invalid-config-'));
  try {
    await assert.rejects(
      resolveCliConfig({ config: 'missing.json' }, {}, dir),
      /Cannot read config/,
      'explicit missing config should fail before network operations',
    );
    const created = await resolveCliConfig({ config: 'missing.json' }, {}, dir, true);
    assert.equal(
      created.project,
      'site',
      'init should be able to create an explicitly selected new config file',
    );
    await fs.writeFile(path.join(dir, '.tug.json'), '{broken');
    await assert.rejects(
      resolveCliConfig({}, {}, dir),
      /Cannot read config/,
      'malformed default config should report an error',
    );
    await fs.writeFile(path.join(dir, '.tug.json'), '{"project":123}');
    await assert.rejects(
      resolveCliConfig({}, {}, dir),
      /project must be a nonempty single-line string/,
      'known config keys should be validated',
    );
    await fs.writeFile(path.join(dir, '.tug.json'), '{}');
    await assert.rejects(
      resolveCliConfig({ controlUrl: 'https://user:secret@control.test' }, {}, dir, true),
      /without credentials/,
      'credentials must not be accepted in the control URL',
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('CLI exposes flat commands and rejects malformed invocations before side effects', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-args-'));
  const env = {
    ...process.env,
    TUG_CONFIG: path.join(dir, 'missing.json'),
    TUG_CONTROL_URL: 'https://unreachable.invalid',
  };
  try {
    const { stdout } = await exec(process.execPath, [entry, '--help'], { env, cwd: dir });
    for (const name of [
      'control-install',
      'node-enroll',
      'node-register',
      'secret-set',
      'volume-remove',
      'control-restore',
    ])
      assert.ok(stdout.includes(name), `help should list flat command ${name}`);
    assert.doesNotMatch(
      stdout,
      /node:|secret:|volume:|control:\s/,
      'help should not advertise colon commands',
    );
    for (const args of [
      ['status', 'typo'],
      ['node', 'install'],
      ['secret:set', 'KEY'],
      ['deploy', '--no-build-upload'],
      ['control-install', 'root@host', '--registry', 'registry.example'],
      ['control-install', 'root@host', '--registry-auth-path', '/auth'],
      ['control-install', 'root@host', '--registry-container', 'registry'],
      ['node-install', 'root@host', '--name', 'n1', '--registry', 'registry.example'],
      ['node-rotate-registry-token', 'n1'],
      ['node-revoke-registry-token', 'n1'],
      ['deploy', '--timeout', '0'],
      ['control-install', 'root@host', '--port', '65536'],
      ['node-enroll', '--uses', 'NaN'],
      ['events', '--limit', '501'],
      ['control-restore', '/backup.tgz'],
    ]) {
      await assert.rejects(
        exec(process.execPath, [entry, ...args], { env, cwd: dir }),
        (error) => {
          const stderr = (error as Error & { stderr: string }).stderr;
          assert.doesNotMatch(
            stderr,
            /Cannot read config|fetch failed|ENOENT.*(ssh|docker)/,
            `invalid ${args.join(' ')} should fail before config, API or host operations`,
          );
          return true;
        },
        `${args.join(' ')} should be rejected`,
      );
    }
    const help = await exec(process.execPath, [entry, 'deploy', '--help'], { env, cwd: dir });
    assert.match(
      help.stdout,
      /--config/,
      'command help should show shared connection and config options',
    );
    assert.match(
      help.stdout,
      /--build-local/,
      'deploy help should explain the application local-build flag',
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('init applies global options after the command without relying on Docker or a control server', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-init-'));
  try {
    const file = path.join(dir, 'new.json');
    const source = path.join(dir, 'source-cred.json');
    await writeCredentialFile(source);
    await exec(
      process.execPath,
      [
        entry,
        'init',
        '--config',
        file,
        '--control-url',
        'https://flag.test',
        '--project',
        'flag-project',
        source,
      ],
      {
        cwd: dir,
        env: {
          ...process.env,
          HOME: dir,
          TUG_CONFIG: path.join(dir, 'ignored.json'),
          TUG_CONTROL_URL: 'https://env.test',
          TUG_PROJECT: 'env-project',
        },
      },
    );
    assert.deepEqual(
      JSON.parse(await fs.readFile(file, 'utf8')),
      { controlUrl: 'https://flag.test', project: 'flag-project' },
      'init should persist the CLI/env/config precedence used by API operations, without the token',
    );
    const overlay = JSON.parse(await fs.readFile(path.join(dir, 'new.local.json'), 'utf8'));
    assert.match(
      overlay.credential,
      /\.config\/tug\/credentials\/.+\.json$/,
      'init should point the overlay at the imported credential',
    );
    assert.equal(
      (await fs.stat(overlay.credential)).mode & 0o777,
      0o600,
      'the imported credential file must be 0600',
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('local application builds skip published images and produce unique file-backed upload manifests', async () => {
  const builds: { service: string; imageRef: string; push?: boolean; contextDir: string }[] = [];
  const files: string[] = [];
  const removed: string[] = [];
  const result = await prepareLocalImages(
    {
      services: {
        web: { build: '.' },
        worker: { build: { context: 'worker' } },
        cache: { image: 'redis:7' },
      },
    },
    '/source',
    '/temp',
    {
      nonce: () => 'unique-build',
      build: async (options) => {
        builds.push(options);
      },
      save: async (_image, file) => {
        files.push(file);
        return {
          imageId: 'sha256:abc',
          platform: 'linux/amd64',
          sha256: 'a'.repeat(64),
          sizeBytes: 123,
        };
      },
      remove: async (imageRef) => {
        removed.push(imageRef);
      },
    },
  );
  assert.deepEqual(
    builds.map((build) => build.service),
    ['web', 'worker'],
    'local builds should process only services declaring build',
  );
  assert.ok(
    builds.every((build) => !('push' in build) && build.contextDir === '/source'),
    'local builds should use explicit source context and never push directly',
  );
  assert.equal(
    new Set(builds.map((build) => build.imageRef)).size,
    2,
    'every service should have its own immutable temporary image tag',
  );
  assert.deepEqual(
    files,
    ['/temp/image-0.tar.gz', '/temp/image-1.tar.gz'],
    'archives should be written to caller-owned temporary files',
  );
  assert.deepEqual(
    result.map((image) => [image.service, image.field, image.sizeBytes]),
    [
      ['web', 'image-0', 123],
      ['worker', 'image-1', 123],
    ],
    'manifest entries should map each service to its uploaded archive field and exact byte size',
  );
  assert.deepEqual(
    removed,
    result.map((image) => image.imageRef),
    'each generated temporary tag should be removed after its saved archive is complete',
  );
});

test('failed local build/save still removes only generated tags without masking the original failure', async () => {
  for (const failure of ['build', 'save'] as const) {
    const removed: string[] = [];
    const warnings: string[] = [];
    await assert.rejects(
      prepareLocalImages(
        {
          services: {
            app: { image: 'user/app:keep', build: '.' },
            published: { image: 'user/published:keep' },
          },
        },
        '/source',
        '/temp',
        {
          nonce: () => 'cleanup-build',
          build: async () => {
            if (failure === 'build') throw new Error('original build failure');
          },
          save: async () => {
            throw new Error('original save failure');
          },
          remove: async (imageRef) => {
            removed.push(imageRef);
            throw new Error('cleanup failure');
          },
          cleanupWarning: (message) => {
            warnings.push(message);
          },
        },
      ),
      new RegExp(`original ${failure} failure`),
      `failed ${failure} should retain its actionable original error`,
    );
    assert.deepEqual(
      removed,
      ['tug-build/cleanup-build/image-0:local'],
      `failed ${failure} should attempt cleanup of only the generated temporary image tag`,
    );
    assert.equal(
      warnings.length,
      1,
      `failed ${failure} should report a cleanup warning when Docker refuses removal`,
    );
  }
});

test('local image builds target the host architecture, not the build machine', () => {
  assert.equal(
    dockerPlatform('x86_64\n'),
    'linux/amd64',
    'an amd64 VPS needs an amd64 image even when built on arm64',
  );
  assert.equal(dockerPlatform('aarch64'), 'linux/arm64', 'an arm64 VPS needs an arm64 image');
  assert.throws(
    () => dockerPlatform('riscv64'),
    /unsupported host architecture 'riscv64'/,
    'unknown architectures fail before a build starts',
  );
  assert.deepEqual(
    localImageBuildArgs('tug:local', 'x86_64'),
    ['build', '--platform', 'linux/amd64', '-t', 'tug:local', '.'],
    'docker build receives the target platform',
  );
});

test('the control port check passes for a free port or the control container, and fails for another listener', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-portcheck-'));
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin);
  const stub = async (name: string, body: string) =>
    fs.writeFile(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  const run = async (listening: boolean, controlOwnsIt: boolean) => {
    await stub(
      'ss',
      listening
        ? 'echo "LISTEN 0 4096 0.0.0.0:8080 0.0.0.0:*"'
        : 'echo "State Recv-Q Send-Q Local"',
    );
    await stub('docker', controlOwnsIt ? 'echo abc123' : 'true');
    try {
      await exec('sh', ['-c', controlPortCheck(8080)], {
        env: { PATH: `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin` },
      });
      return 0;
    } catch (e) {
      return (e as { code: number }).code;
    }
  };
  assert.equal(await run(false, false), 0, 'a free port passes the preflight');
  assert.equal(
    await run(true, true),
    0,
    'the port held by the existing control container passes, so control-install can upgrade in place',
  );
  assert.notEqual(
    await run(true, false),
    0,
    'a port held by anything else still fails the preflight',
  );
  await fs.rm(dir, { recursive: true, force: true });
});

test('the agent docker run shares the host network without NET_ADMIN unless the mesh is on', () => {
  const plain = dockerRunSnippet('img:1', 'join-key');
  assert.match(
    plain,
    /--network host /,
    'health checks dial container IPs, which a bridge-networked agent cannot reach',
  );
  assert.doesNotMatch(plain, /NET_ADMIN|TUG_MESH/, 'only the mesh adds capabilities and TUG_MESH');
});

test('shell snippets quote user values and cloud-init stops enrollment after bootstrap failure', () => {
  const image = "registry.test/image:tag'; printf injected";
  const command = dockerRunSnippet(image, 'join-key', true);
  assert.ok(
    command.includes(shellQuote(image)),
    'image reference should remain a single shell argument',
  );
  assert.match(
    command,
    /--network host --cap-add NET_ADMIN/,
    'mesh snippets should enable host networking and NET_ADMIN',
  );
  const document = enrollmentCloudInit('set -eu\nexit 20\n', command);
  const parsed = yaml.load(document) as {
    write_files: { path: string; permissions: string; content: string }[];
    runcmd: string[][];
  };
  assert.ok(
    document.startsWith('#cloud-config\n'),
    'bare-host enrollment should emit valid cloud-init user-data directly',
  );
  assert.equal(
    parsed.write_files[0].permissions,
    '0700',
    'bootstrap script should be private and executable by root',
  );
  assert.equal(
    parsed.write_files[0].content,
    'set -eu\nexit 20\n',
    'cloud-init should preserve bootstrap script contents',
  );
  assert.equal(
    parsed.runcmd[0][3],
    `sh /opt/tug/install-docker.sh && ${command}`,
    'agent startup should be conditional on successful bootstrap',
  );
});

test('numeric arguments are strict bounded integers', () => {
  assert.equal(
    integerOption('443', '--port', 1, 65535),
    443,
    'valid TCP port should retain its integer value',
  );
  for (const value of ['0', '-1', '1.5', 'NaN', '1e3', '65536'])
    assert.throws(
      () => integerOption(value, '--port', 1, 65535),
      /--port must be an integer/,
      `port ${value} should be rejected as out of range or malformed`,
    );
});

test('source upload excludes Tug credentials even with a broad Dockerfile and ignore reinclusion', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-source-'));
  const archive = path.join(os.tmpdir(), `tug-source-${path.basename(dir)}.tar.gz`);
  try {
    await fs.mkdir(path.join(dir, 'settings'));
    await fs.mkdir(path.join(dir, 'nested'));
    await fs.writeFile(path.join(dir, '.tug.json'), '{"controlUrl":"https://c.test"}');
    for (const name of ['tug.local.yml', 'nested/tug.local.json', 'nested/.tug.local.json'])
      await fs.writeFile(path.join(dir, name), 'token: secret');
    await fs.writeFile(path.join(dir, 'tug.yml'), 'project: site');
    await fs.writeFile(path.join(dir, 'nested', 'tug.json'), '{"app":"own file"}');
    await fs.writeFile(
      path.join(dir, 'settings', 'production.json'),
      '{"operatorToken":"other-secret"}',
    );
    await fs.writeFile(path.join(dir, 'nested', '.tug.json'), '{"operatorToken":"nested-secret"}');
    await fs.writeFile(path.join(dir, '.dockerignore'), '!.tug.json\n!settings/production.json\n');
    await fs.writeFile(path.join(dir, 'Dockerfile'), 'FROM scratch\nCOPY . .\n');
    await fs.writeFile(path.join(dir, 'app.txt'), 'public application');
    await createSourceArchive(dir, archive, [path.join(dir, 'settings', 'production.json')]);
    const entries: string[] = [];
    await tar.t({
      file: archive,
      onReadEntry: (entry) => {
        entries.push(entry.path);
      },
    });
    assert.ok(
      entries.some((entry) => entry.endsWith('app.txt')),
      'source archive should retain application files',
    );
    assert.ok(
      entries.some((entry) => entry.endsWith('Dockerfile')),
      'source archive should retain the Dockerfile',
    );
    assert.ok(
      entries.every(
        (entry) => !entry.endsWith('.tug.json') && !entry.endsWith('settings/production.json'),
      ),
      'source archive must exclude default, nested and selected Tug credential files even when re-included',
    );
    assert.ok(
      entries.every((entry) => !/(^|\/)(tug\.local\.(yml|json)|\.tug\.local\.json)$/.test(entry)),
      'source archive must exclude the token overlays at any depth',
    );
    assert.ok(
      !entries.includes('tug.yml') && !entries.includes('./tug.yml'),
      'source archive must exclude the tracked config at the context root',
    );
    assert.ok(
      entries.some((entry) => entry.endsWith('nested/tug.json')),
      'source archive should keep an application file that happens to be named tug.json below the root',
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(archive, { force: true });
  }
});

test('Docker bootstrap selects the package family and Docker repository for each supported OS and rejects the rest', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-os-release-'));
  const script = path.resolve('src/templates/install-docker.sh');
  const detect = async (release: string) => {
    const file = path.join(dir, 'os-release');
    await fs.writeFile(file, release);
    return exec('/bin/sh', [script], {
      env: { ...process.env, PATH: dir, TUG_OS_RELEASE: file, TUG_BOOTSTRAP_DETECT: '1' },
    }).then(
      (result) => ({ code: 0, out: result.stdout.trim(), err: result.stderr }),
      (error: { code: number; stderr: string }) => ({
        code: error.code,
        out: '',
        err: error.stderr,
      }),
    );
  };
  try {
    const supported: [string, string, string][] = [
      ['ID=ubuntu\nVERSION_ID="24.04"\nVERSION_CODENAME=noble\n', 'apt', 'ubuntu'],
      ['ID=debian\nVERSION_ID="12"\nVERSION_CODENAME=bookworm\n', 'apt', 'debian'],
      ['ID=fedora\nVERSION_ID=43\n', 'dnf', 'fedora'],
      ['ID="rhel"\nVERSION_ID="9.4"\n', 'dnf', 'rhel'],
      ['ID="rocky"\nVERSION_ID="9.5"\n', 'dnf', 'centos'],
      ['ID="almalinux"\nVERSION_ID="10.0"\n', 'dnf', 'centos'],
      ['ID="centos"\nVERSION_ID="9"\n', 'dnf', 'centos'],
    ];
    for (const [release, family, repo] of supported) {
      const result = await detect(release);
      assert.deepEqual(
        [result.code, result.out],
        [0, `${family} ${repo}`],
        `${release.split('\n')[0]} should use the ${family} bootstrap with the ${repo} Docker repository`,
      );
    }
    for (const release of [
      'ID=alpine\nVERSION_ID=3.20\n',
      'ID=ubuntu\nVERSION_CODENAME=focal\n',
      'ID=fedora\nVERSION_ID=30\n',
      'ID=rocky\nVERSION_ID="8.10"\n',
    ]) {
      const result = await detect(release);
      assert.equal(result.code, 20, `${release.split('\n')[0]} should be refused with exit 20`);
      assert.match(
        result.err,
        /Unsupported Docker bootstrap .*install Docker Engine and Compose manually/,
        'refusal should tell the operator to install Docker manually',
      );
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('Docker bootstrap preserves a working installation without package-manager or privilege checks', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-existing-docker-'));
  try {
    await fs.writeFile(path.join(dir, 'docker'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const script = path.resolve('src/templates/install-docker.sh');
    const result = await exec('/bin/sh', [script], { env: { ...process.env, PATH: dir } });
    assert.match(
      result.stderr,
      /already available/,
      'working Docker Engine and Compose should skip all installation steps',
    );
    await exec('/bin/sh', ['-n', script]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
