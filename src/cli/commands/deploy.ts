import { selectDeployment, selectService } from './selection.ts';
import { existsSync, openAsBlob } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Command } from 'commander';
import { createLocalBuildSnapshot, createSourceArchive, prepareLocalImages } from '../build.ts';
import { createProgress, withProgress } from '../progress.ts';
import { canPrompt } from '../prompt.ts';
import {
  describeValues,
  findMissingValues,
  ignoredSourceNotes,
  parseVarFlags,
  promptForValues,
} from '../values.ts';
import { formatValuesTable, summarizeValues } from '../../values.ts';
import { bindMountWarnings, composeHash } from '../../compose/compose.ts';
import { normalizeCompose } from '../../compose/normalize.ts';
import {
  loadCfg,
  collectList,
  formatDeployment,
  print,
  printResult,
  projectOf,
  request,
  waitForCommand,
  waitForDeployment,
} from './context.ts';
import type { CommonOpts, DeployResponse, WaitOpts } from './context.ts';

/**
 * The project's secrets and variable values, read one request after the other. Two requests in flight from one CLI
 * process made control reset the second TLS connection (`ECONNRESET`), so these are sequential on purpose.
 */
export async function loadDeployValues(
  get: typeof request,
  project: string,
): Promise<{
  secrets: { name: string }[];
  vars: { name: string; version: number; value: string }[];
}> {
  const { secrets } = await get<{ secrets: { name: string }[] }>(
    'GET',
    `/api/v1/secrets?project=${encodeURIComponent(project)}`,
  );
  const { vars } = await get<{ vars: { name: string; version: number; value: string }[] }>(
    'GET',
    `/api/v1/vars/values?project=${encodeURIComponent(project)}`,
  );
  return { secrets, vars };
}

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
    .option(
      '--compose-cli',
      'read the Compose file with `docker compose config` (needs Docker Compose v2 on this machine) instead of Tug’s own reader, for a file that uses include, !reset or !override',
    )
    .option('--no-wait', 'return after desired state is created')
    .option('--timeout <seconds>', 'wait timeout in seconds', '300')
    .option('--json', 'print the full result, including the desired state, as JSON')
    .option(
      '--var <NAME=value>',
      'a value for this deploy only, such as TAG=$GITHUB_SHA; it wins over a stored variable, is recorded on the deployment with its value, and cannot replace a secret (repeatable)',
      // Not collectList: a value may contain commas, so each --var is one NAME=value.
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .option(
      '--profile <name>',
      'enable a Compose profile (repeat or comma-separate); COMPOSE_PROFILES in your shell is not read',
      collectList,
      [],
    )
    .option(
      '--dry-run',
      'resolve every value and print where each comes from (secrets as •••), then stop without deploying',
    )
    .option(
      '--move <service>',
      'acknowledge that a service placed on another node starts empty (its data does not move); the services that write to it are held until you restore it or run `tug hold release` (repeat or comma-separate for several)',
      collectList,
      [],
    )
    .action(
      async (
        o: CommonOpts &
          WaitOpts & {
            file: string;
            version?: string;
            buildLocal?: boolean;
            composeCli?: boolean;
            json?: boolean;
            move: string[];
            var?: string[];
            profile: string[];
            dryRun?: boolean;
          },
      ) => {
        const progress = createProgress();
        try {
          progress.stage('Preparing deployment');
          const cfg = await loadCfg();
          const project = o.project || cfg.project || 'site';
          // Every ${NAME} comes from control (secrets as sentinels the agent fills in, variables as their values), from
          // --var, or from the default written in the file. The shell and .env of this machine are never read.
          const flags = parseVarFlags(o.var ?? []);
          const { secrets, vars } = await loadDeployValues(request, project);
          const secretNames = secrets.map((secret) => secret.name);
          const variables = new Map(
            vars.map((row) => [row.name, { version: row.version, value: row.value }]),
          );
          for (const name of Object.keys(flags)) {
            if (secretNames.includes(name))
              throw new Error(
                `--var ${name} conflicts with the project secret ${name}: a secret is never overridden from the command line`,
              );
          }
          for (const note of await ignoredSourceNotes(
            o.file,
            new Set([...secretNames, ...variables.keys()]),
          ))
            console.error(note);
          const known = () => new Set([...secretNames, ...variables.keys(), ...Object.keys(flags)]);
          const missing = await findMissingValues(o.file, known());
          if (missing.length) {
            if (o.dryRun || !canPrompt())
              throw new Error(
                `${o.file} needs values that are not set on control: ${missing.join(', ')}. Tug does not read your shell environment or .env; set each with tug secret set <name> (private) or tug var set <name> (visible), pass --var NAME=value for this deploy only, or import a file with tug secret import .env${
                  o.dryRun ? '' : ' (or run tug deploy in a terminal to be prompted)'
                }`,
              );
            console.error(
              `Values not set on control for project ${project}: ${missing.join(', ')}`,
            );
            // Only names that do not exist yet are stored, so an existing value is never overwritten.
            for (const [name, entry] of Object.entries(await promptForValues(missing))) {
              if (entry.kind === 'secret') {
                await request('POST', '/api/v1/secrets', { project, name, value: entry.value });
                secretNames.push(name);
              } else {
                const stored = await request<{ version: number }>('POST', '/api/v1/vars', {
                  project,
                  name,
                  value: entry.value,
                });
                variables.set(name, { version: stored.version, value: entry.value });
              }
            }
          }
          const values = await describeValues(o.file, {
            secrets: new Set(secretNames),
            vars: variables,
            flags,
          });
          const referenced = new Set(values.map((value) => value.name));
          for (const name of Object.keys(flags))
            if (!referenced.has(name))
              console.error(`warning: --var ${name} is not referenced in ${o.file}; it is ignored`);
          console.error(`Values: ${summarizeValues(values)}`);
          const movePayload = o.move.length ? { moves: o.move } : {};
          const declared = await composeName(o.file);
          if (declared && declared !== project)
            console.error(
              `warning: ${o.file} is named ${declared} but the Tug project is ${project}; secrets, backups and restores are scoped to the Tug project (set project: ${declared} in tug.yml, or pass --project)`,
            );
          const compose = await normalizeCompose(o.file, secretNames, {
            project,
            composeCli: o.composeCli,
            vars: { ...Object.fromEntries([...variables].map(([n, v]) => [n, v.value])), ...flags },
            profiles: o.profile,
          });
          if (o.dryRun) {
            // Reading the file is part of the dry run: an env_file or an unsupported construct fails here too.
            console.log(formatValuesTable(values));
            return;
          }
          for (const warning of bindMountWarnings(compose)) console.error(warning);
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
                JSON.stringify({ project, version, compose, values, localImages, ...movePayload }),
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
              form.append(
                'payload',
                JSON.stringify({ project, version, compose, values, ...movePayload }),
              );
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
              values,
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
    .command('cancel [id]')
    .description('cancel a deployment that has not finished')
    .action(async (id: string) =>
      print(
        await request(
          'POST',
          `/api/v1/deployments/${encodeURIComponent(await selectDeployment(id))}/cancel`,
          {},
        ),
      ),
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
    .command('scale [service] [replicas]')
    .option('--replicas <n>', 'replica count when choosing a service interactively')
    .description('scale a service to N replicas across matching nodes')
    .option('--json', 'print the full result as JSON')
    .action(
      async (
        service: string,
        replicas: string,
        o: CommonOpts & { json?: boolean; replicas?: string },
      ) => {
        if (o.replicas && replicas)
          throw new Error('pass replicas positionally or with --replicas, not both');
        replicas = replicas || o.replicas || '';
        const project = await projectOf(o);
        if (!/^[1-9]\d*$/.test(replicas)) throw new Error('replicas must be a positive integer');
        service = await selectService(service);
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
      },
    );

  program
    .command('restart [service]')
    .description('restart a service on every node that runs it')
    .option('--timeout <seconds>', 'wait timeout', '60')
    .action(async (svc: string, o: CommonOpts & { timeout: string }) => {
      const project = await projectOf(o);
      svc = await selectService(svc);
      const created = await request('POST', '/api/v1/restart', { project, service: svc });
      const cmd = await waitForCommand(created.commandId, Number(o.timeout));
      if (cmd.state === 'failed')
        throw new Error(JSON.parse(cmd.result_json || '{}').error || 'restart failed');
      print(cmd);
    });
}
