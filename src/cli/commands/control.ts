import fsp from 'node:fs/promises';
import path from 'node:path';
import { withProgress } from '../progress.ts';
import { formatBytes } from './backup.ts';
import { runProcess, runStep, STAGE_MARKER } from '../process.ts';
import type { Command } from 'commander';
import { canPrompt, confirm } from '../prompt.ts';
import { CONTROL_CONTAINER, defaultControlUrl, shellQuote as sh } from '../install.ts';
import { assertImagePublished, resolveImage } from '../../images/image.ts';
import { decodeCredential, fingerprintPem, writeFileDurable } from '../../pki.ts';
import { loadTemplate } from '../load-template.ts';
import { errMessage } from '../../errors.ts';
import {
  collectList,
  download,
  loadCfg,
  print,
  readEnvValues,
  request,
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
        const runImage = o.buildLocalImage
          ? await transferTugImage(sshTarget, image, progress)
          : image;
        // Before anything is written: a control host that still keeps its data in the old directory must migrate first,
        // or a fresh control would create a second CA on an empty volume (--recover-root included).
        progress.stage(`Checking control data on ${sshTarget}`);
        await runStep('ssh', ['--', sshTarget, controlGuardScript(runImage)], { progress });
        const remote = await loadTemplate(templatesDir, 'control-install.sh', {
          IMAGE_SH: sh(runImage),
          CONTROL_URL_SH: sh(new URL(controlUrl).origin),
          EXTRA_SANS_SH: sh(o.extraSan.join(',')),
          PORT: String(Number(o.port)),
          MARKER: STAGE_MARKER,
          CONTAINER_SH: sh(CONTROL_CONTAINER),
        });
        progress.stage(`Installing control on ${sshTarget}`);
        await runStep('ssh', ['--', sshTarget, remote], { progress });
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
      'create a control-plane backup (state, PKI, master key and retained image archives; not workload volumes). It is also the parent of `list`',
    )
    .option('--no-images', 'leave the retained build archives out (deploy again to rebuild them)')
    .option(
      '--offsite',
      'store the backup in the backup destination now (without images, as the nightly one is) and print where it went and its snapshot id, instead of keeping a local archive; use it to test the setup or before moving control',
    )
    .option(
      '--download',
      'also save the archive on this machine; it holds the master key and the CA key, so store it encrypted. The copy on control stays in its backup directory',
    )
    .option(
      '-o, --output <file>',
      'where --download saves the archive, default ./tug-control-backup-<id>.tar.gz in the working directory; an existing file is never overwritten. Implies --download',
    )
    .action(
      async (o: { images: boolean; offsite?: boolean; download?: boolean; output?: string }) => {
        if (o.offsite && (o.download || o.output))
          throw new Error(
            '--offsite stores the backup in the destination; --download saves a local archive instead',
          );
        if (o.offsite)
          return withProgress('Storing control-plane backup in the backup destination', async () =>
            print(await request('POST', '/api/v1/control/backups/run', { offsite: true })),
          );
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
      'restore a control-plane backup, from an archive path on the control-plane host or with --from-destination from the shared backup destination; requires a control restart',
    )
    .option(
      '--from-destination <url>',
      'restore the newest control backup stored in this backup destination, such as s3:https://s3.example.com/bucket/tug-backups; the credential variables come from --env and the control password (from `tug backup password --control` on the old control) from TUG_CONTROL_BACKUP_PASSWORD, else the stdin line after the credential values',
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
      '--verify',
      'fetch and check the backup (archive, database integrity, CA, secrets) and print what it holds, without changing control and without --confirm',
    )
    .option('--confirm')
    .action(
      async (
        artifactRef: string | undefined,
        o: {
          confirm?: boolean;
          fromDestination?: string;
          env: string[];
          snapshot?: string;
          verify?: boolean;
          fromFile?: string;
        },
      ) => {
        if (!o.confirm && !o.verify)
          throw new Error(
            'control restore requires --confirm (or --verify to only check the backup)',
          );
        if (o.fromFile) {
          if (artifactRef || o.fromDestination || o.snapshot || o.env.length)
            throw new Error(
              '--from-file takes no archive path, --from-destination, --snapshot or --env',
            );
          if (!(await fsp.stat(o.fromFile).catch(() => null)))
            throw new Error(`${o.fromFile} does not exist`);
          return withProgress(
            o.verify ? 'Verifying control-plane backup' : 'Restoring control-plane backup',
            async () =>
              print(
                await upload(
                  `/api/v1/control/restore?${o.verify ? 'verify=1' : 'confirm=1'}`,
                  o.fromFile!,
                ),
              ),
          );
        }
        if (o.snapshot && !o.fromDestination)
          throw new Error('--snapshot goes with --from-destination');
        if (Boolean(artifactRef) === Boolean(o.fromDestination))
          throw new Error('name an archive path, or use --from-file or --from-destination <url>');
        if (artifactRef && o.env.length) throw new Error('--env goes with --from-destination');
        // The control password comes last: from the environment, else the stdin line after the credential values; never an argument.
        const values = o.fromDestination
          ? await readEnvValues([...o.env, CONTROL_PASSWORD_VARIABLE])
          : undefined;
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
          o.verify ? 'Verifying control-plane backup' : 'Restoring control-plane backup',
          async () =>
            print(
              await request('POST', '/api/v1/control/restore', {
                artifactRef,
                fromDestination,
                confirm: Boolean(o.confirm),
                verify: Boolean(o.verify),
              }),
            ),
        );
      },
    );
}
