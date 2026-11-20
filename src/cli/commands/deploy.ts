import { selectDeployment, selectService } from './selection.ts';
import { openAsBlob } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Command } from 'commander';
import {
  createLocalBuildSnapshot,
  createSourceArchive,
  localBuildDependencies,
  prepareLocalImages,
} from '../build.ts';
import { deploymentsSharingLabel } from '../status.ts';
import { createProgress, withProgress } from '../progress.ts';
import { canPrompt } from '../prompt.ts';
import { composeNameSync, defaultComposeFileName, resolveProject } from '../project.ts';
import {
  describeValues,
  findMissingValues,
  ignoredSourceNotes,
  missingValuesMessage,
  parseVarFlags,
  promptForValues,
} from '../values.ts';
import { formatValuesTable, summarizeValues } from '../../values.ts';
import { bindMountWarnings, composeHash, selectBuilds } from '../../compose/compose.ts';
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
import type { CommonOpts, ControlGet, DeployResponse, WaitOpts } from './context.ts';
import { out, err, resolvePath } from '../runtime.ts';
import type { CliRuntime } from '../runtime.ts';

/**
 * The project's secrets and variable values, read one request after the other. Two requests in flight from one CLI
 * process made control reset the second TLS connection (`ECONNRESET`), so these are sequential on purpose.
 */
export async function loadDeployValues(
  get: ControlGet,
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

async function makeContext(rt: CliRuntime): Promise<string> {
  const cfg = loadCfg(rt);
  const tmp = path.join(os.tmpdir(), `tug-${Date.now()}.tgz`);
  try {
    await createSourceArchive(rt.cwd, tmp, [
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
export function defaultComposeFile(rt: CliRuntime, cwd = rt.cwd): string {
  return defaultComposeFileName(cwd);
}

/**
 * The project this deploy targets. A project chosen by `--project`, `TUG_PROJECT` or `tug.yml` stands; one derived
 * from the Compose file is derived again from `-f`, so `tug deploy -f other/compose.yaml` follows that file.
 */
function deployProject(rt: CliRuntime, o: { project?: string; file: string }): string {
  const cfg = loadCfg(rt);
  if (o.project) return o.project;
  if (cfg.projectSource !== 'compose-name' && cfg.projectSource !== 'directory') return cfg.project;
  return resolveProject({ cwd: rt.cwd, file: o.file }).project;
}

/**
 * Ids of earlier deployments of the project that carry the same version label as this one, found from control's recent
 * deployments. A failed lookup is no hint: the summary still shows the deployment id.
 */
async function sharedLabel(rt: CliRuntime, response: DeployResponse): Promise<string[]> {
  try {
    const state = response.desiredState as { project?: string; version?: string } | undefined;
    const { deployments } = await request<{
      deployments: { id: string; version: string; project_id?: string }[];
    }>(rt, 'GET', '/api/v1/status');
    return deploymentsSharingLabel(
      deployments,
      response.deployment.id,
      state?.project,
      state?.version,
    );
  } catch {
    return [];
  }
}

export function registerDeploy(rt: CliRuntime, program: Command): void {
  const deploy = program
    .command('deploy')
    .description('deploy the Compose project, or cancel a deployment with `deploy cancel <id>`')
    .option('-f, --file <file>', 'compose file', defaultComposeFile(rt))
    .option('--version <version>', 'display version (default: git-<Compose hash>)')
    .option(
      '--build',
      'build services that name both build: and image: for this deploy (by default their image is deployed and nothing is built; x-tug.build: true builds one always)',
    )
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
            build?: boolean;
            buildLocal?: boolean;
            composeCli?: boolean;
            json?: boolean;
            move: string[];
            var?: string[];
            profile: string[];
            dryRun?: boolean;
          },
      ) => {
        const progress = createProgress(rt);
        try {
          progress.stage('Preparing deployment');
          const cfg = loadCfg(rt);
          const project = deployProject(rt, o);
          // Every ${NAME} comes from control (secrets as sentinels the agent fills in, variables as their values), from
          // --var, or from the default written in the file. The shell and .env of this machine are never read.
          const flags = parseVarFlags(o.var ?? []);
          const { secrets, vars } = await loadDeployValues(
            (method, route) => request(rt, method, route),
            project,
          );
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
            rt.cwd,
            o.file,
            new Set([...secretNames, ...variables.keys()]),
            rt.env,
          ))
            err(rt, note);
          const known = () => new Set([...secretNames, ...variables.keys(), ...Object.keys(flags)]);
          const missing = await findMissingValues(rt.cwd, o.file, known());
          if (missing.length) {
            if (o.dryRun || !canPrompt(rt))
              throw new Error(
                missingValuesMessage(
                  o.file,
                  await fs.readFile(resolvePath(rt, o.file), 'utf8').catch(() => ''),
                  missing,
                  Boolean(o.dryRun),
                ),
              );
            err(rt, `Values not set on control for project ${project}: ${missing.join(', ')}`);
            // Only names that do not exist yet are stored, so an existing value is never overwritten.
            for (const [name, entry] of Object.entries(await promptForValues(rt, missing))) {
              if (entry.kind === 'secret') {
                await request(rt, 'POST', '/api/v1/secrets', { project, name, value: entry.value });
                secretNames.push(name);
              } else {
                const stored = await request<{ version: number }>(rt, 'POST', '/api/v1/vars', {
                  project,
                  name,
                  value: entry.value,
                });
                variables.set(name, { version: stored.version, value: entry.value });
              }
            }
          }
          const values = await describeValues(rt.cwd, o.file, {
            secrets: new Set(secretNames),
            vars: variables,
            flags,
          });
          const referenced = new Set(values.map((value) => value.name));
          for (const name of Object.keys(flags))
            if (!referenced.has(name))
              err(rt, `warning: --var ${name} is not referenced in ${o.file}; it is ignored`);
          err(rt, `Values: ${summarizeValues(values)}`);
          const movePayload = o.move.length ? { moves: o.move } : {};
          const declared = composeNameSync(resolvePath(rt, o.file));
          if (declared && declared !== project)
            err(
              rt,
              `warning: ${o.file} is named ${declared} but the Tug project is ${project}; secrets, backups and restores are scoped to the Tug project (set project: ${declared} in tug.yml, or pass --project)`,
            );
          const normalized = await normalizeCompose(resolvePath(rt, o.file), secretNames, {
            project,
            composeCli: o.composeCli,
            hostEnv: rt.env,
            vars: { ...Object.fromEntries([...variables].map(([n, v]) => [n, v.value])), ...flags },
            profiles: o.profile,
          });
          // A service with both build: and image: deploys its image; only --build or x-tug.build: true builds it.
          const { compose, published } = selectBuilds(normalized, o.build);
          for (const name of published)
            err(
              rt,
              `note: ${name} has build: and image:, so Tug deploys ${compose.services[name].image} and does not build it (tug deploy --build, or x-tug.build: true on the service, builds it)`,
            );
          if (o.dryRun) {
            // Reading the file is part of the dry run: an env_file or an unsupported construct fails here too.
            out(rt, formatValuesTable(values));
            // The checks a deploy makes against other projects (a host port another project already publishes on a node).
            await request(rt, 'POST', '/api/v1/deployments/check', { project, compose });
            err(rt, 'No host-port clash with another project on any node.');
            return;
          }
          for (const warning of bindMountWarnings(compose)) err(rt, warning);
          const version = o.version || `git-${composeHash(compose)}`;
          let response: DeployResponse;
          if (o.buildLocal) {
            const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-local-build-'));
            try {
              const form = new FormData();
              progress.stage('Preparing local build snapshot');
              const source = Object.values(compose.services).some((service) => service.build)
                ? await createLocalBuildSnapshot(rt.cwd, directory, [
                    cfg.file,
                    cfg.localFile,
                    ...(cfg.credentialFile ? [cfg.credentialFile] : []),
                  ])
                : rt.cwd;
              const localImages = await prepareLocalImages(
                compose,
                source,
                directory,
                localBuildDependencies(rt, (message) => err(rt, message)),
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
              response = await request<DeployResponse>(
                rt,
                'POST',
                '/api/v1/deployments',
                form,
                true,
              );
            } finally {
              await fs.rm(directory, { recursive: true, force: true });
            }
          } else if (Object.values(compose.services).some((service) => service.build)) {
            progress.stage('Archiving source for remote build');
            const tarball = await makeContext(rt);
            try {
              const form = new FormData();
              form.append(
                'payload',
                JSON.stringify({ project, version, compose, values, ...movePayload }),
              );
              form.append('context', await openAsBlob(tarball), 'context.tgz');
              progress.stage('Uploading source and building images on control');
              response = await request<DeployResponse>(
                rt,
                'POST',
                '/api/v1/deployments',
                form,
                true,
              );
            } finally {
              await fs.rm(tarball, { force: true });
            }
          } else {
            progress.stage('Resolving images and preparing deployment on control');
            response = await request<DeployResponse>(rt, 'POST', '/api/v1/deployments', {
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
              rt,
              response.deployment.id,
              Number(o.timeout),
              (deployment) => progress.stage(`Deployment ${deployment.id}: ${deployment.state}`),
            );
          }
          const sharedWith = o.json ? [] : await sharedLabel(rt, response);
          printResult(rt, o.json, response, (value) => formatDeployment(value, sharedWith));
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
        rt,
        await request(
          rt,
          'POST',
          `/api/v1/deployments/${encodeURIComponent(await selectDeployment(rt, id))}/cancel`,
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
      return withProgress(rt, 'Preparing rollback on control', async (progress) => {
        const response = await request<DeployResponse>(rt, 'POST', '/api/v1/rollback', {
          project: projectOf(rt, o),
          force: Boolean(o.force),
        });
        if (o.wait) {
          progress.stage(`Deployment ${response.deployment.id}: ${response.deployment.state}`);
          response.deployment = await waitForDeployment(
            rt,
            response.deployment.id,
            Number(o.timeout),
            (deployment) => progress.stage(`Deployment ${deployment.id}: ${deployment.state}`),
          );
        }
        const sharedWith = o.json ? [] : await sharedLabel(rt, response);
        printResult(rt, o.json, response, (value) => formatDeployment(value, sharedWith));
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
        const project = projectOf(rt, o);
        if (!/^[1-9]\d*$/.test(replicas)) throw new Error('replicas must be a positive integer');
        service = await selectService(rt, service);
        const result = await request<{ service: string; replicas: number; nodes: string[] }>(
          rt,
          'POST',
          '/api/v1/scale',
          { project, service, replicas: Number(replicas) },
        );
        printResult(
          rt,
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
      const project = projectOf(rt, o);
      svc = await selectService(rt, svc);
      const created = await request(rt, 'POST', '/api/v1/restart', { project, service: svc });
      const cmd = await waitForCommand(rt, created.commandId, Number(o.timeout));
      if (cmd.state === 'failed')
        throw new Error(JSON.parse(cmd.result_json || '{}').error || 'restart failed');
      print(rt, cmd);
    });
}
