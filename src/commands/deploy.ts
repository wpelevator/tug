import { existsSync, openAsBlob } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Command } from 'commander';
import { createLocalBuildSnapshot, createSourceArchive, prepareLocalImages } from '../cli-build.ts';
import { createProgress, withProgress } from '../cli-progress.ts';
import { canPrompt } from '../cli-prompt.ts';
import { findMissingSecrets, promptForSecrets } from '../cli-secrets.ts';
import { composeHash } from '../compose.ts';
import { normalizeCompose } from '../normalize.ts';
import {
  loadCfg,
  collect,
  formatDeployment,
  print,
  printResult,
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

/** The first conventional Compose file name in the working directory; `docker-compose.yml` when none exists. */
export function defaultComposeFile(cwd = process.cwd()): string {
  const names = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];
  return names.find((name) => existsSync(path.join(cwd, name))) ?? 'docker-compose.yml';
}

/** The top-level `name:` of a Compose file, which Compose would use as the project name. */
export async function composeName(file: string): Promise<string | undefined> {
  const text = await fs.readFile(file, 'utf8').catch(() => '');
  return /^name:\s*["']?([A-Za-z0-9][\w.-]*)["']?\s*(?:#.*)?$/m.exec(text)?.[1];
}

export function registerDeploy(program: Command): void {
  const deploy = program
    .command('deploy')
    .description('deploy the Compose project, or cancel a deployment with `deploy cancel <id>`')
    .option('-f, --file <file>', 'compose file', defaultComposeFile())
    .option('--version <version>', 'display version (default: git-<Compose hash>)')
    .option('--build-local', 'build application images locally and upload them without source')
    .option('--no-wait', 'return after desired state is created')
    .option('--timeout <seconds>', 'wait timeout in seconds', '300')
    .option('--json', 'print the full result, including the desired state, as JSON')
    .option(
      '--move <service>',
      'acknowledge that a service placed on another node starts empty (its data does not move); the services that write to it are held until you restore it or run `tug hold release` (repeatable)',
      collect,
      [],
    )
    .action(
      async (
        o: CommonOpts &
          WaitOpts & {
            file: string;
            version?: string;
            buildLocal?: boolean;
            json?: boolean;
            move: string[];
          },
      ) => {
        const progress = createProgress();
        try {
          progress.stage('Preparing deployment');
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
          const movePayload = o.move.length ? { moves: o.move } : {};
          const declared = await composeName(o.file);
          if (declared && declared !== project)
            console.error(
              `warning: ${o.file} is named ${declared} but the Tug project is ${project}; secrets, backups and restores are scoped to the Tug project (set project: ${declared} in tug.yml, or pass --project)`,
            );
          const compose = await normalizeCompose(o.file, secretNames, { project });
          const version = o.version || `git-${composeHash(compose)}`;
          let response: DeployResponse;
          if (o.buildLocal) {
            const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-local-build-'));
            try {
              const form = new FormData();
              progress.stage('Preparing local build snapshot');
              const source = Object.values(compose.services).some((service) => service.build)
                ? await createLocalBuildSnapshot(process.cwd(), directory, [
                    cfg.file,
                    cfg.localFile,
                    ...(cfg.credentialFile ? [cfg.credentialFile] : []),
                  ])
                : process.cwd();
              const localImages = await prepareLocalImages(
                compose,
                source,
                directory,
                undefined,
                progress.stage,
              );
              for (const { field } of localImages)
                form.append(
                  field,
                  await openAsBlob(path.join(directory, `${field}.tar.gz`)),
                  `${field}.tar.gz`,
                );
              form.append(
                'payload',
                JSON.stringify({ project, version, compose, localImages, ...movePayload }),
              );
              progress.stage('Uploading images and preparing deployment on control');
              response = await request<DeployResponse>('POST', '/api/v1/deployments', form, true);
            } finally {
              await fs.rm(directory, { recursive: true, force: true });
            }
          } else if (Object.values(compose.services).some((service) => service.build)) {
            progress.stage('Archiving source for remote build');
            const tarball = await makeContext();
            try {
              const form = new FormData();
              form.append('payload', JSON.stringify({ project, version, compose, ...movePayload }));
              form.append('context', await openAsBlob(tarball), 'context.tgz');
              progress.stage('Uploading source and building images on control');
              response = await request<DeployResponse>('POST', '/api/v1/deployments', form, true);
            } finally {
              await fs.rm(tarball, { force: true });
            }
          } else {
            progress.stage('Resolving images and preparing deployment on control');
            response = await request<DeployResponse>('POST', '/api/v1/deployments', {
              project,
              version,
              compose,
              ...movePayload,
            });
          }
          if (o.wait) {
            progress.stage(`Deployment ${response.deployment.id}: ${response.deployment.state}`);
            response.deployment = await waitForDeployment(
              response.deployment.id,
              Number(o.timeout),
              (deployment) => progress.stage(`Deployment ${deployment.id}: ${deployment.state}`),
            );
          }
          printResult(o.json, response, formatDeployment);
        } finally {
          progress.stop();
        }
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
    .option('--json', 'print the full result, including the desired state, as JSON')
    .action(async (o: CommonOpts & WaitOpts & { force?: boolean; json?: boolean }) => {
      return withProgress('Preparing rollback on control', async (progress) => {
        const response = await request<DeployResponse>('POST', '/api/v1/rollback', {
          project: await projectOf(o),
          force: Boolean(o.force),
        });
        if (o.wait) {
          progress.stage(`Deployment ${response.deployment.id}: ${response.deployment.state}`);
          response.deployment = await waitForDeployment(
            response.deployment.id,
            Number(o.timeout),
            (deployment) => progress.stage(`Deployment ${deployment.id}: ${deployment.state}`),
          );
        }
        printResult(o.json, response, formatDeployment);
      });
    });

  program
    .command('scale <service> <replicas>')
    .description('scale a service to N replicas across matching nodes')
    .option('--json', 'print the full result as JSON')
    .action(async (service: string, replicas: string, o: CommonOpts & { json?: boolean }) => {
      const project = await projectOf(o);
      if (!/^[1-9]\d*$/.test(replicas)) throw new Error('replicas must be a positive integer');
      const result = await request<{ service: string; replicas: number; nodes: string[] }>(
        'POST',
        '/api/v1/scale',
        { project, service, replicas: Number(replicas) },
      );
      printResult(
        o.json,
        result,
        (r) =>
          `${r.service} scaled to ${r.replicas} replica${r.replicas === 1 ? '' : 's'} on ${r.nodes.join(', ')}`,
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
