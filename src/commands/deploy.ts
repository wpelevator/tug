import { openAsBlob } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Command } from 'commander';
import { createLocalBuildSnapshot, createSourceArchive, prepareLocalImages } from '../cli-build.ts';
import { canPrompt } from '../cli-prompt.ts';
import { findMissingSecrets, promptForSecrets } from '../cli-secrets.ts';
import { composeHash } from '../compose.ts';
import { normalizeCompose } from '../normalize.ts';
import {
  loadCfg,
  print,
  projectOf,
  request,
  waitForCommand,
  waitForDeployment,
} from './context.ts';
import type { CommonOpts, DeployResponse, WaitOpts } from './context.ts';

async function makeContext(): Promise<string> {
  const cfg = await loadCfg();
  const tmp = path.join(os.tmpdir(), `tug-${Date.now()}.tgz`);
  try {
    await createSourceArchive(process.cwd(), tmp, [
      cfg.file,
      cfg.localFile,
      ...(cfg.credentialFile ? [cfg.credentialFile] : []),
    ]);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw error;
  }
  return tmp;
}

export function registerDeploy(program: Command): void {
  const deploy = program
    .command('deploy')
    .description('deploy the Compose project, or cancel a deployment with `deploy cancel <id>`')
    .option('-f, --file <file>', 'compose file', 'docker-compose.yml')
    .option('--version <version>', 'display version (default: git-<Compose hash>)')
    .option('--build-local', 'build application images locally and upload them without source')
    .option('--no-wait', 'return after desired state is created')
    .option('--timeout <seconds>', 'wait timeout in seconds', '300')
    .action(
      async (
        o: CommonOpts & WaitOpts & { file: string; version?: string; buildLocal?: boolean },
      ) => {
        const cfg = await loadCfg();
        const project = o.project || cfg.project || 'site';
        // Control secrets are interpolated as sentinels; the agent substitutes the node's released values.
        const { secrets } = await request<{ secrets: { name: string }[] }>(
          'GET',
          `/api/v1/secrets?project=${encodeURIComponent(project)}`,
        );
        const secretNames = secrets.map((secret) => secret.name);
        const missing = await findMissingSecrets(o.file, secretNames);
        if (missing.length) {
          if (!canPrompt())
            throw new Error(
              `${o.file} needs values that are not set: ${missing.join(', ')}; create each with tug secret set <name> (or run tug deploy in a terminal to be prompted)`,
            );
          console.error(`Missing secrets for project ${project}: ${missing.join(', ')}`);
          // Only names that do not exist yet are stored, so an existing secret is never overwritten.
          for (const [name, value] of Object.entries(await promptForSecrets(missing))) {
            await request('POST', '/api/v1/secrets', { project, name, value });
            secretNames.push(name);
          }
        }
        const compose = await normalizeCompose(o.file, secretNames, { project });
        const version = o.version || `git-${composeHash(compose)}`;
        let response: DeployResponse;
        if (o.buildLocal) {
          const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-local-build-'));
          try {
            const form = new FormData();
            const source = Object.values(compose.services).some((service) => service.build)
              ? await createLocalBuildSnapshot(process.cwd(), directory, [
                  cfg.file,
                  cfg.localFile,
                  ...(cfg.credentialFile ? [cfg.credentialFile] : []),
                ])
              : process.cwd();
            const localImages = await prepareLocalImages(compose, source, directory);
            for (const { field } of localImages)
              form.append(
                field,
                await openAsBlob(path.join(directory, `${field}.tar.gz`)),
                `${field}.tar.gz`,
              );
            form.append('payload', JSON.stringify({ project, version, compose, localImages }));
            response = await request<DeployResponse>('POST', '/api/v1/deployments', form, true);
          } finally {
            await fs.rm(directory, { recursive: true, force: true });
          }
        } else if (Object.values(compose.services).some((service) => service.build)) {
          const tarball = await makeContext();
          try {
            const form = new FormData();
            form.append('payload', JSON.stringify({ project, version, compose }));
            form.append('context', await openAsBlob(tarball), 'context.tgz');
            response = await request<DeployResponse>('POST', '/api/v1/deployments', form, true);
          } finally {
            await fs.rm(tarball, { force: true });
          }
        } else
          response = await request<DeployResponse>('POST', '/api/v1/deployments', {
            project,
            version,
            compose,
          });
        if (o.wait)
          response.deployment = await waitForDeployment(response.deployment.id, Number(o.timeout));
        print(response);
      },
    );
  deploy
    .command('cancel <id>')
    .description('cancel a deployment that has not finished')
    .action(async (id: string) =>
      print(await request('POST', `/api/v1/deployments/${encodeURIComponent(id)}/cancel`, {})),
    );

  program
    .command('rollback')
    .description('activate the previous successful deployment')
    .option('--force')
    .option('--no-wait', 'return immediately after activating rollback')
    .option('--timeout <seconds>', 'wait timeout', '300')
    .action(async (o: CommonOpts & WaitOpts & { force?: boolean }) => {
      const response = await request<DeployResponse>('POST', '/api/v1/rollback', {
        project: await projectOf(o),
        force: Boolean(o.force),
      });
      if (o.wait)
        response.deployment = await waitForDeployment(response.deployment.id, Number(o.timeout));
      print(response);
    });

  program
    .command('scale <service> <replicas>')
    .description('scale a service to N replicas across matching nodes')
    .action(async (service: string, replicas: string, o: CommonOpts) => {
      const project = await projectOf(o);
      if (!/^[1-9]\d*$/.test(replicas)) throw new Error('replicas must be a positive integer');
      print(
        await request('POST', '/api/v1/scale', { project, service, replicas: Number(replicas) }),
      );
    });

  program
    .command('restart <service>')
    .description('restart a service on every node that runs it')
    .option('--timeout <seconds>', 'wait timeout', '60')
    .action(async (svc: string, o: CommonOpts & { timeout: string }) => {
      const project = await projectOf(o);
      const created = await request('POST', '/api/v1/restart', { project, service: svc });
      const cmd = await waitForCommand(created.commandId, Number(o.timeout));
      if (cmd.state === 'failed')
        throw new Error(JSON.parse(cmd.result_json || '{}').error || 'restart failed');
      print(cmd);
    });
}
