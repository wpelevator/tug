import fsp from 'node:fs/promises';
import path from 'node:path';
import { withProgress } from '../progress.ts';
import { formatBytes } from './backup.ts';
import { runProcess, runStep, STAGE_MARKER } from '../process.ts';
import type { Command } from 'commander';
import { canPrompt, confirm } from '../prompt.ts';
import { CONTROL_CONTAINER, defaultControlUrl, shellQuote as sh } from '../install.ts';
import type { StepProgress } from '../process.ts';
import {
  ROLLBACK_TAG,
  alreadyRunning,
  controlPortMapping,
  imageIdScript,
  inspectControlScript,
  parseControlInspect,
  parseImageId,
  readControlCaScript,
  rollbackImageScript,
  rollbackTagNeeded,
  rollbackTagScript,
} from '../upgrade.ts';
import type { ControlInstall } from '../upgrade.ts';
import { assertImagePublished, defaultImage, resolveImage } from '../../images/image.ts';
import { decodeCredential, fingerprintPem, writeFileDurable } from '../../pki.ts';
import { loadTemplate } from '../load-template.ts';
import { errMessage } from '../../errors.ts';
import {
  collectList,
  download,
  loadCfg,
  print,
  readEnvValues,
  readStdin,
  request,
  runCapture,
  templatesDir,
  upload,
} from './context.ts';
import type { InstallOpts } from './context.ts';
import { bootstrapDocker, hostHasDocker, preflightRemote, transferTugImage } from './host.ts';
import { importCredential } from './init.ts';
import {
  CONTROL_LEFTOVERS,
  CONTROL_VOLUME,
  LEGACY_CONTROL_DIR,
  controlGuardScript,
  controlMigrateScript,
} from '../migrate.ts';

const PREVIEW_NOTE =
  'This only checked the backup and changed nothing; add --confirm to restore it.';
/** Where `control restore --from-destination` reads the control password: this variable, else the stdin line after the credential values. */
const CONTROL_PASSWORD_VARIABLE = 'TUG_CONTROL_BACKUP_PASSWORD';

interface ControlBackupListing {
  destinationConfigured: boolean;
  repository: string | null;
  local: {
    id: string;
    createdAt: string;
    path: string | null;
    onDisk: boolean;
    sizeBytes: number | null;
    images: boolean | null;
  }[];
  remote: {
    state: 'ok' | 'missing' | 'error';
    snapshots: { shortId: string; time: string; tags: string[]; sizeBytes?: number }[];
    error?: string;
  } | null;
}

interface SetupOpts extends InstallOpts {
  extraSan: string[];
  port: string;
  credentialOut?: string;
  import: boolean;
  recoverRoot?: boolean;
  yes?: boolean;
}

/** Replaces the control container with one running `image` on the same volume; the data is never touched. */
async function installControlContainer(
  sshTarget: string,
  plan: Omit<ControlInstall, 'imageId'>,
  progress: StepProgress,
): Promise<void> {
  const remote = await loadTemplate(templatesDir, 'control-install.sh', {
    IMAGE_SH: sh(plan.image),
    CONTROL_URL_SH: sh(new URL(plan.controlUrl).origin),
    EXTRA_SANS_SH: sh(plan.extraSans.join(',')),
    PORT_FLAGS: plan.bindings
      .map(
        (binding) =>
          `-p ${binding.hostIp ? sh(controlPortMapping(binding)) : controlPortMapping(binding)}`,
      )
      .join(' '),
    MARKER: STAGE_MARKER,
    CONTAINER_SH: sh(CONTROL_CONTAINER),
  });
  await runStep('ssh', ['--', sshTarget, remote], { progress });
}

/** Running `control setup` over an existing control rebuilds it from this run's flags alone; say what that changes. */
async function warnWhenSetupChangesInstall(
  sshTarget: string,
  plan: { controlUrl: string; port: number; extraSans: string[] },
): Promise<void> {
  let existing: ControlInstall;
  try {
    existing = parseControlInspect(
      await runCapture('ssh', ['--', sshTarget, inspectControlScript]),
    );
  } catch {
    return; // nothing installed yet (or not by setup): there is nothing to compare
  }
  const oldBindings = existing.bindings.map(controlPortMapping).join(', ');
  const newBinding = controlPortMapping({ port: plan.port });
  const changes = [
    ...(oldBindings !== newBinding ? [`bindings ${oldBindings} -> ${newBinding}`] : []),
    ...(new URL(existing.controlUrl).origin !== new URL(plan.controlUrl).origin
      ? [`control URL ${existing.controlUrl} -> ${new URL(plan.controlUrl).origin}`]
      : []),
    ...(existing.extraSans.slice().sort().join(',') !== plan.extraSans.slice().sort().join(',')
      ? [`extra names [${existing.extraSans.join(', ')}] -> [${plan.extraSans.join(', ')}]`]
      : []),
  ];
  if (changes.length)
    console.error(
      `note: control is already installed on ${sshTarget} and this run changes its settings (${changes.join('; ')}); to move to a new release and keep them, use \`tug control upgrade\``,
    );
}

interface UpgradeOpts {
  to?: string;
  image?: string;
  buildLocalImage?: boolean;
  force?: boolean;
  rollback?: boolean;
  yes?: boolean;
}

/** The control's own version, retried while the container finishes starting; undefined without a credential or an answer. */
async function waitForControlVersion(): Promise<string | undefined> {
  if (!(await loadCfg()).credential) return undefined;
  for (let i = 0; i < 15; i++) {
    try {
      return (await request<{ v: string }>('GET', '/api/v1/version')).v;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return undefined;
}

/**
 * `control upgrade`: replaces the control container on the host with one running another image, keeping the port,
 * the advertised URL and the extra names it was installed with (read from the running container, so nothing has to be
 * passed again). The previous image is tagged `tug:rollback` first; the data volume and the CA are never touched, and
 * the CA is compared before and after.
 */
export async function runControlUpgrade(
  sshTargetArg: string | undefined,
  o: UpgradeOpts,
): Promise<boolean> {
  const cfg = await loadCfg();
  const sshTarget = sshTargetArg ?? cfg.controlSsh;
  if (!sshTarget)
    throw new Error(
      `control upgrade needs the control host: pass <ssh-target> or set controlSsh in ${cfg.file}`,
    );
  if (o.rollback && (o.to || o.image || o.buildLocalImage))
    throw new Error('--rollback cannot be combined with --to, --image or --build-local-image');
  if (o.to && (o.image || o.buildLocalImage))
    throw new Error(
      '--to names a published version; it cannot be combined with --image or --build-local-image',
    );
  const image = o.rollback
    ? ROLLBACK_TAG
    : resolveImage(o.image ?? (o.to ? defaultImage(o.to) : undefined), o.buildLocalImage);
  if (!o.rollback) assertImagePublished(image);
  return withProgress(`Upgrading control on ${sshTarget}`, async (progress) => {
    progress.stage(`Reading the control installation on ${sshTarget}`);
    const inspection = await runCapture('ssh', ['--', sshTarget, inspectControlScript]).catch(
      (e: unknown) => {
        throw new Error(
          `no control installation to upgrade on ${sshTarget} (${errMessage(e)}); \`tug control setup <ssh-target>\` installs one`,
          { cause: e },
        );
      },
    );
    const current = parseControlInspect(inspection);
    if (o.rollback) await runCapture('ssh', ['--', sshTarget, rollbackImageScript]);
    const targetId = parseImageId(await runCapture('ssh', ['--', sshTarget, imageIdScript(image)]));
    if (alreadyRunning(current.imageId, targetId, o.force) && !o.buildLocalImage) {
      console.error(
        `control on ${sshTarget} already runs ${image}; nothing to do (--force recreates it)`,
      );
      print({ ok: true, sshTarget, image, upgraded: false });
      return true;
    }
    console.error(
      [
        o.rollback ? 'Control rollback plan' : 'Control upgrade plan',
        `  host:        ${sshTarget}`,
        `  image:       ${current.image} -> ${image}`,
        `  mTLS ports:  ${current.bindings.map(controlPortMapping).join(', ')} (kept)`,
        `  control URL: ${current.controlUrl} (kept)`,
        ...(current.extraSans.length
          ? [`  extra names: ${current.extraSans.join(', ')} (kept)`]
          : []),
        ...(o.rollback
          ? [
              '  note:        a newer control may already have migrated the database; one that cannot read it',
              '               restarts in a loop until you restore the tug.db.pre-v<N>.bak copy or a control backup',
            ]
          : []),
      ].join('\n'),
    );
    if (
      canPrompt() &&
      !o.yes &&
      !(await confirm(`${o.rollback ? 'Roll back' : 'Upgrade'} control?`))
    )
      throw new Error('cancelled; nothing was changed');
    const before = fingerprintPem(
      await runCapture('ssh', ['--', sshTarget, readControlCaScript(current.image)]),
    );
    progress.stage(`Checking control host ${sshTarget}`);
    await preflightRemote(sshTarget, {
      ports: [...new Set(current.bindings.map(({ port }) => port))],
      minDiskMb: 2048,
      progress,
    });
    const runImage = o.buildLocalImage ? await transferTugImage(sshTarget, image, progress) : image;
    progress.stage(`Checking control data on ${sshTarget}`);
    await runStep('ssh', ['--', sshTarget, controlGuardScript(runImage)], { progress });
    const runImageId = parseImageId(
      await runCapture('ssh', ['--', sshTarget, imageIdScript(runImage)]),
    );
    if (!o.rollback && rollbackTagNeeded(current.imageId, runImageId)) {
      progress.stage(`Keeping ${current.image} as ${ROLLBACK_TAG}`);
      await runStep('ssh', ['--', sshTarget, rollbackTagScript(current.imageId)], { progress });
    }
    progress.stage(`Replacing control on ${sshTarget}`);
    await installControlContainer(sshTarget, { ...current, image: runImage }, progress);
    const after = fingerprintPem(
      await runCapture('ssh', ['--', sshTarget, readControlCaScript(runImage)]),
    );
    if (after !== before)
      throw new Error(
        `control's CA changed from ${before} to ${after} during the upgrade; inspect /data/pki on ${sshTarget} before using it`,
      );
    progress.stage('Waiting for control to answer');
    const version = await waitForControlVersion();
    if (!version)
      console.error(
        `control restarted but did not answer yet (or no credential is configured); check \`tug doctor\` and \`docker logs ${CONTROL_CONTAINER}\` on ${sshTarget}`,
      );
    console.error(
      `control now runs ${runImage}${version ? ` (version ${version})` : ''}; match the agents next with \`tug node upgrade --all\``,
    );
    print({
      ok: true,
      sshTarget,
      image: runImage,
      upgraded: true,
      ...(version ? { version } : {}),
    });
    return true;
  });
}

/** `control setup`, also registered as the top-level shortcut `setup`. */
function addSetup(parent: Command, description: string): void {
  parent
    .command('setup <sshTarget>')
    .description(description)
    .option(
      '--extra-san <name>',
      'additional DNS name or IP for the server certificate (repeat or comma-separate for several)',
      collectList,
      [],
    )
    .option(
      '--image <tag>',
      "Tug image to run (default: ghcr.io/wpelevator/tug:<this CLI's version>)",
    )
    .option(
      '--install-docker',
      'install missing Docker Engine and Compose on supported Debian, Ubuntu, Fedora and RHEL-compatible hosts (root required); in a terminal you are asked when they are missing',
    )
    .option(
      '--build-local-image',
      'build the image from the current checkout and copy it to the host over SSH (tags it tug:local unless --image is set); for development',
    )
    .option('--port <port>', 'published mTLS port', '8443')
    .option(
      '--credential-out <file>',
      'also write the root credential to this 0600 file (for example to hand it to CI)',
    )
    .option(
      '--no-import',
      'do not import the root credential into the local config (requires --credential-out)',
    )
    .option(
      '--recover-root',
      "replace root's key from the control host without the API (lost credential); other admins are unaffected",
    )
    .option('-y, --yes', 'do not ask for confirmation in a terminal')
    .action(async (sshTarget: string, o: SetupOpts, command: Command) => {
      const cfg = await loadCfg();
      if (!o.import && !o.credentialOut)
        throw new Error('--no-import needs --credential-out, or the root credential would be lost');
      // The control URL clients use: --control-url, TUG_CONTROL_URL or the config's controlUrl, else the SSH target's host
      // and the published port. Clients verify a name generated from the CA, so this is only an address.
      const controlUrl = cfg.requestedControlUrl ?? defaultControlUrl(sshTarget, o.port);
      console.error(
        `control URL: ${controlUrl} (${cfg.requestedControlUrl ? 'from --control-url, TUG_CONTROL_URL or the config file' : 'from the SSH target and --port'}); clients connect there by default`,
      );
      const interactive = canPrompt();
      let missingDocker = false;
      if (!o.installDocker && interactive && !hostHasDocker(sshTarget)) {
        missingDocker = true;
        o.installDocker = await confirm(
          `Docker is not installed on ${sshTarget}. Install it now (needs root)?`,
        );
      }
      const image = resolveImage(o.image, o.buildLocalImage);
      assertImagePublished(image);
      console.error(
        [
          'Control plan',
          `  host:        ${sshTarget}`,
          `  control URL: ${controlUrl}`,
          `  mTLS port:   ${o.port}`,
          `  image:       ${image}`,
          `  docker:      ${o.installDocker ? 'install Engine' : missingDocker ? 'not installed (the preflight will fail)' : 'must already be installed'}`,
          `  credential:  ${[o.import ? 'imported into the local config' : '', o.credentialOut ? `written to ${o.credentialOut}` : ''].filter(Boolean).join(' and ')}`,
        ].join('\n'),
      );
      if (interactive && !o.yes && !(await confirm('Install the control plane?')))
        throw new Error('cancelled; nothing was changed');
      return withProgress(`Preparing control on ${sshTarget}`, async (progress) => {
        if (o.installDocker) {
          progress.stage(`Installing Docker on ${sshTarget}`);
          await bootstrapDocker(sshTarget, progress);
        }
        progress.stage(`Checking control host ${sshTarget}`);
        await preflightRemote(sshTarget, {
          ports: [Number(o.port)],
          minDiskMb: 2048,
          progress,
        });
        await warnWhenSetupChangesInstall(sshTarget, {
          controlUrl,
          port: Number(o.port),
          extraSans: o.extraSan,
        });
        const runImage = o.buildLocalImage
          ? await transferTugImage(sshTarget, image, progress)
          : image;
        // Before anything is written: a control host that still keeps its data in the old directory must migrate first,
        // or a fresh control would create a second CA on an empty volume (--recover-root included).
        progress.stage(`Checking control data on ${sshTarget}`);
        await runStep('ssh', ['--', sshTarget, controlGuardScript(runImage)], { progress });
        progress.stage(`Installing control on ${sshTarget}`);
        await installControlContainer(
          sshTarget,
          {
            image: runImage,
            controlUrl,
            bindings: [{ port: Number(o.port) }],
            extraSans: o.extraSan,
          },
          progress,
        );
        // Upgrades never reissue root: fresh installs create it, `--recover-root` replaces its key. Output goes straight to files.
        const issue = `docker exec ${sh(CONTROL_CONTAINER)} node dist/main.js control issue-credential --name root --role admin${o.recoverRoot ? ' --replace' : ''}`;
        progress.stage(`Issuing root credential on ${sshTarget}`);
        const out = await runProcess('ssh', ['--', sshTarget, issue], { capture: true });
        if (out.status !== 0) {
          if (!o.recoverRoot && /already used/.test(String(out.stderr)))
            console.error(
              'control already has a root credential; upgrade complete (pass --recover-root to replace it)',
            );
          else throw new Error(`issuing the root credential failed: ${String(out.stderr).trim()}`);
        } else {
          const text = `${String(out.stdout).trim()}\n`;
          decodeCredential(text);
          // Fail closed before any local write: a credential for a CA the control did not persist is the
          // control-rewrote-credentials incident exactly, and importing it silently breaks every later CLI call.
          const persisted = await runProcess(
            'ssh',
            ['--', sshTarget, `docker exec ${sh(CONTROL_CONTAINER)} cat /data/pki/ca.crt`],
            { capture: true },
          );
          const issuedFp = (() => {
            try {
              return fingerprintPem(decodeCredential(text).ca);
            } catch (e: unknown) {
              throw new Error(
                `the issued root credential holds no PEM CA (${errMessage(e)}); refusing to write local state`,
                { cause: e },
              );
            }
          })();
          // An unreadable persisted CA (an older image, a failed cat) degrades to a warning: nothing to compare.
          // A readable-but-different CA must refuse the write outside any parse guard, so it stays fail-closed.
          let onDiskFp: string | undefined;
          let onDiskError = '';
          try {
            onDiskFp = fingerprintPem(String(persisted.stdout));
          } catch (e: unknown) {
            onDiskError = errMessage(e);
          }
          if (!onDiskFp)
            console.error(
              `note: skipped the CA-consistency check — could not read the control's persisted CA (${onDiskError})`,
            );
          else if (issuedFp !== onDiskFp)
            throw new Error(
              `the issued root credential is signed by CA ${issuedFp}, but the control persisted CA ${onDiskFp}; refusing to write local state — inspect /data/pki on ${sshTarget}`,
            );
          if (o.credentialOut) {
            await writeFileDurable(o.credentialOut, text, 0o600);
            console.error(`root credential written to ${o.credentialOut}`);
          }
          if (o.import) {
            const { controlUrl: connectUrl, project } = command.optsWithGlobals<{
              controlUrl?: string;
              project?: string;
            }>();
            await importCredential(cfg, text, { controlUrl: connectUrl, project });
          }
        }
        print({ ok: true, sshTarget, url: controlUrl });
      });
    });
}

export function registerControl(program: Command): void {
  const description =
    'install the control plane on a Docker-capable host over SSH and import the root credential into the local config; it listens for mTLS only, so front it with TCP passthrough rather than a terminating proxy';
  const control = program
    .command('control')
    .description('install, back up and restore the control plane');
  addSetup(control, description);
  control
    .command('upgrade [sshTarget]')
    .description(
      "replace the control container with another Tug image (default: this CLI's version) over SSH, keeping the port, URL and extra names it runs with and the data volume; the previous image stays as tug:rollback. The SSH target defaults to controlSsh in the config file",
    )
    .option('--to <version>', "upgrade to this published version instead of the CLI's own")
    .option(
      '--image <tag>',
      "Tug image to run (default: ghcr.io/wpelevator/tug:<this CLI's version>)",
    )
    .option(
      '--build-local-image',
      'build the image from the current checkout and copy it to the host over SSH (tags it tug:local unless --image is set); for development',
    )
    .option('--rollback', 'go back to the image kept as tug:rollback by the last upgrade')
    .option('--force', 'recreate the container even when it already runs the target image')
    .option('-y, --yes', 'do not ask for confirmation in a terminal')
    .action(async (sshTarget: string | undefined, o: UpgradeOpts) => {
      if (!(await runControlUpgrade(sshTarget, o))) process.exitCode = 1;
    });
  control
    .command('migrate <sshTarget>')
    .description(
      `move the control data of a control plane installed before it lived in a Docker volume from ${LEGACY_CONTROL_DIR} into the ${CONTROL_VOLUME} volume and restart control on it, keeping its image, URL and port. Run it before the next control setup on such a host, which refuses until then`,
    )
    .action(async (sshTarget: string) =>
      withProgress(`Migrating control data on ${sshTarget}`, async (progress) => {
        await runStep('ssh', ['--', sshTarget, controlMigrateScript(STAGE_MARKER)], { progress });
        console.error(
          `${LEGACY_CONTROL_DIR} is no longer used; remove it on ${sshTarget} once control is confirmed healthy (it holds a copy of the master key and the CA)`,
        );
        print({ ok: true, sshTarget, volume: CONTROL_VOLUME, leftover: CONTROL_LEFTOVERS });
      }),
    );
  addSetup(program, 'shortcut for `tug control setup`');
  const backup = control
    .command('backup')
    .description(
      'back the control plane up into the backup destination (state, PKI and master key; never build images or workload volumes) and print the snapshot id. --local or -o make an archive instead. It is also the parent of `list`',
    )
    .option(
      '--local',
      'make an archive on the control host (in its backup directory) instead of storing a backup in the destination: state, PKI, master key and the retained build archives, which --no-images leaves out',
    )
    .option(
      '--no-images',
      'with --local or -o, leave the retained build archives out (deploy again to rebuild them); an error without them, because only an archive has build images',
    )
    .option(
      '--download',
      'also save the archive on this machine; implies --local. It holds the master key and the CA key, so store it encrypted. The copy on control stays in its backup directory',
    )
    .option(
      '-o, --output <file>',
      'save the archive on this machine as <file>; implies --local and --download. An existing file is never overwritten; without -o, --download uses ./tug-control-backup-<id>.tar.gz',
    )
    .action(
      async (o: { images: boolean; local?: boolean; download?: boolean; output?: string }) => {
        const archive = Boolean(o.local || o.download || o.output);
        if (!archive) {
          // Only an archive has build images, so --no-images must not quietly turn this into one.
          if (!o.images) throw new Error('--no-images applies to an archive; add --local or -o');
          return withProgress('Storing control-plane backup in the backup destination', async () =>
            print(await request('POST', '/api/v1/control/backups/run', { toDestination: true })),
          );
        }
        return withProgress('Creating control-plane backup', async (progress) => {
          // Refuse before the backup exists on control when the chosen file is already there.
          if (o.output && (await fsp.stat(o.output).catch(() => null)))
            throw new Error(`${o.output} already exists; choose another file with -o`);
          const result = await request<{
            backupId: string;
            artifactRef: string;
            state: string;
            images: boolean;
          }>('POST', '/api/v1/control/backups/run', { images: o.images });
          if (!o.download && !o.output) return print(result);
          const file = path.resolve(o.output ?? `tug-control-backup-${result.backupId}.tar.gz`);
          progress.stage(`Downloading the archive to ${file}`);
          await download(
            `/api/v1/control/backups/${encodeURIComponent(result.backupId)}/download`,
            file,
          );
          console.error(
            `Saved ${file}: ${result.images ? 'with' : 'without'} build images, no workload volumes. It contains the master key and the CA private key, so store it encrypted. A copy also stays on control at ${result.artifactRef}; delete it there when you no longer need it.`,
          );
          print({ ...result, downloadedTo: file, serverCopy: result.artifactRef });
        });
      },
    );
  backup
    .command('list')
    .description(
      'show the control backups on the control host and the ones actually stored in the backup destination, with the snapshot ids that `control restore --snapshot` takes',
    )
    .option('--json', 'print the full result as JSON')
    .action(async (o: { json?: boolean }) => {
      const listing = await request<ControlBackupListing>('GET', '/api/v1/control/backups');
      if (o.json) return print(listing);
      console.log(
        `repository: ${listing.repository ?? 'none (no backup destination is configured)'}`,
      );
      console.log(listing.local.length ? 'on the control host:' : 'on the control host: none');
      for (const copy of listing.local)
        console.log(
          `  ${copy.id}\t${copy.createdAt}\t${copy.onDisk ? formatBytes(copy.sizeBytes) : 'gone from disk'}\t${copy.images === false ? 'no images' : copy.images ? 'with images' : '-'}\t${copy.path ?? '-'}`,
        );
      if (!listing.remote) return;
      if (listing.remote.state === 'error') {
        console.log(`in the destination: unreadable: ${listing.remote.error}`);
        process.exitCode = 1;
        return;
      }
      console.log(
        listing.remote.snapshots.length
          ? 'in the destination (newest first; each holds the database, CA and master key, never workload volumes):'
          : 'in the destination: none yet',
      );
      for (const snapshot of listing.remote.snapshots)
        console.log(
          `  ${snapshot.shortId}\t${snapshot.time}\t${formatBytes(snapshot.sizeBytes ?? null)}\t${snapshot.tags.includes('images:none') ? 'no images' : 'images not recorded'}\t${snapshot.tags.filter((tag) => tag !== 'control' && tag !== 'images:none').join(' ')}`,
        );
    });
  control
    .command('restore [artifactRef]')
    .description(
      'restore a control-plane backup, from an archive path on the control-plane host, an archive saved on this machine (--from-file) or the shared backup destination (--from-destination); requires a control restart. Without --confirm it only checks the backup (archive, database integrity, CA, secrets) and prints what it holds, changing nothing, like `tug restore run`',
    )
    .option(
      '--from-destination <url>',
      'restore the newest control backup stored in this backup destination, such as s3:https://s3.example.com/bucket/tug-backups; the credential variables come from --env and the control password (from `tug backup password --control` on the old control) from --password-stdin or TUG_CONTROL_BACKUP_PASSWORD',
    )
    .option(
      '--env <name>',
      'credential variable of the destination, such as AWS_ACCESS_KEY_ID (repeat or comma-separate for several); each value is read from the variable of that name in your environment, else from a line on stdin',
      collectList,
      [],
    )
    .option(
      '--from-file <file>',
      'restore an archive saved on this machine (for example by `control backup -o`): it is uploaded to the control host, so it does not have to be copied there first',
    )
    .option(
      '--snapshot <id>',
      'with --from-destination, restore this snapshot id from `tug control backup list` instead of the newest one',
    )
    .option(
      '--password-stdin',
      'read the control password from the first line of stdin, as `docker login --password-stdin` does; the destination credentials must then be in the environment (--env names them), so stdin has one meaning',
    )
    .option('--confirm', 'apply the restore; without it the backup is only checked')
    .action(
      async (
        artifactRef: string | undefined,
        o: {
          confirm?: boolean;
          fromDestination?: string;
          env: string[];
          snapshot?: string;
          passwordStdin?: boolean;
          fromFile?: string;
        },
      ) => {
        // Like `tug restore run`, a restore that is not confirmed is a preview: it checks and changes nothing.
        const verify = !o.confirm;
        if (o.fromFile) {
          if (artifactRef || o.fromDestination || o.snapshot || o.env.length)
            throw new Error(
              '--from-file takes no archive path, --from-destination, --snapshot or --env',
            );
          if (!(await fsp.stat(o.fromFile).catch(() => null)))
            throw new Error(`${o.fromFile} does not exist`);
          return withProgress(
            verify ? 'Verifying control-plane backup' : 'Restoring control-plane backup',
            async () => {
              const result = await upload(
                `/api/v1/control/restore?${verify ? 'verify=1' : 'confirm=1'}`,
                o.fromFile!,
              );
              if (verify) console.error(PREVIEW_NOTE);
              print(result);
            },
          );
        }
        if (o.snapshot && !o.fromDestination)
          throw new Error('--snapshot goes with --from-destination');
        if (Boolean(artifactRef) === Boolean(o.fromDestination))
          throw new Error('name an archive path, or use --from-file or --from-destination <url>');
        if (artifactRef && o.env.length) throw new Error('--env goes with --from-destination');
        if (o.passwordStdin && !o.fromDestination)
          throw new Error('--password-stdin goes with --from-destination');
        // The password is never an argument: stdin with --password-stdin, else the environment. Without the flag a
        // missing value is still read from stdin after the credential values, as `backup destination set` reads them.
        let values: Record<string, string> | undefined;
        if (o.fromDestination && o.passwordStdin) {
          const missing = o.env.filter((name) => process.env[name] === undefined);
          if (missing.length)
            throw new Error(
              `with --password-stdin, set ${missing.join(', ')} in the environment: stdin carries only the password`,
            );
          const password = (await readStdin()).split(/\r?\n/).find((line) => line.length > 0);
          if (!password) throw new Error('expected the control password on stdin');
          values = {
            ...Object.fromEntries(o.env.map((name) => [name, process.env[name]!])),
            [CONTROL_PASSWORD_VARIABLE]: password,
          };
        } else if (o.fromDestination) {
          values = await readEnvValues([...o.env, CONTROL_PASSWORD_VARIABLE]);
        }
        const fromDestination =
          o.fromDestination && values
            ? {
                url: o.fromDestination,
                env: Object.fromEntries(o.env.map((name) => [name, values[name]])),
                password: values[CONTROL_PASSWORD_VARIABLE],
                ...(o.snapshot ? { snapshot: o.snapshot } : {}),
              }
            : undefined;
        return withProgress(
          verify ? 'Verifying control-plane backup' : 'Restoring control-plane backup',
          async () => {
            const result = await request('POST', '/api/v1/control/restore', {
              artifactRef,
              fromDestination,
              confirm: Boolean(o.confirm),
              verify,
            });
            if (verify) console.error(PREVIEW_NOTE);
            print(result);
          },
        );
      },
    );
}
