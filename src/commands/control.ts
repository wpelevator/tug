import { withProgress } from '../cli-progress.ts';
import { runProcess } from '../cli-process.ts';
import type { Command } from 'commander';
import { canPrompt, confirm } from '../cli-prompt.ts';
import { CONTROL_CONTAINER, defaultControlUrl, shellQuote as sh } from '../cli-install.ts';
import { assertImagePublished, resolveImage } from '../image.ts';
import { decodeCredential, fingerprintPem, writeFileDurable } from '../pki.ts';
import { errMessage, loadTemplate } from '../util.ts';
import { collect, loadCfg, print, request, runLocal, templatesDir } from './context.ts';
import type { InstallOpts } from './context.ts';
import { bootstrapDocker, hostHasDocker, preflightRemote, transferTugImage } from './host.ts';
import { importCredential } from './init.ts';

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
      'additional DNS name or IP for the server certificate (repeatable)',
      collect,
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
      if (!o.installDocker && interactive && !hostHasDocker(sshTarget, true)) {
        missingDocker = true;
        o.installDocker = await confirm(
          `Docker with the Compose plugin is not installed on ${sshTarget}. Install it now (needs root)?`,
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
          `  docker:      ${o.installDocker ? 'install Engine and Compose' : missingDocker ? 'not installed (the preflight will fail)' : 'must already be installed'}`,
          `  credential:  ${[o.import ? 'imported into the local config' : '', o.credentialOut ? `written to ${o.credentialOut}` : ''].filter(Boolean).join(' and ')}`,
        ].join('\n'),
      );
      if (interactive && !o.yes && !(await confirm('Install the control plane?')))
        throw new Error('cancelled; nothing was changed');
      return withProgress(`Preparing control on ${sshTarget}`, async (progress) => {
        if (o.installDocker) {
          progress.stage(`Installing Docker on ${sshTarget}`);
          await bootstrapDocker(sshTarget, true);
        }
        progress.stage(`Checking control host ${sshTarget}`);
        await preflightRemote(sshTarget, {
          ports: [Number(o.port)],
          minDiskMb: 2048,
          compose: true,
        });
        if (o.buildLocalImage) await transferTugImage(sshTarget, image, progress.stage);
        const yamlValue = (value: string) => JSON.stringify(value);
        const compose = await loadTemplate(templatesDir, 'control-compose.yml', {
          IMAGE: yamlValue(image),
          CONTROL_URL: yamlValue(new URL(controlUrl).origin),
          EXTRA_SANS: yamlValue(o.extraSan.join(',')),
          PORT: o.port,
        });
        const remote = await loadTemplate(templatesDir, 'control-install.sh', {
          COMPOSE: compose,
          CONTAINER_SH: sh(CONTROL_CONTAINER),
        });
        progress.stage(`Installing control on ${sshTarget}`);
        await runLocal('ssh', ['--', sshTarget, remote]);
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
          try {
            const issued = fingerprintPem(decodeCredential(text).ca);
            const onDisk = fingerprintPem(String(persisted.stdout));
            if (issued !== onDisk)
              throw new Error(
                `the issued root credential is signed by CA ${issued}, but the control persisted CA ${onDisk}; refusing to write local state — inspect /data/pki on ${sshTarget}`,
              );
          } catch (e: unknown) {
            // The comparison runs only when both sides parse; an unreadable persisted CA (an older image, cat failure)
            // degrades to a warning, while a genuinely different persisted CA still refuses the import through the throw.
            if (persisted.status === 0 && /not signed by CA|control persisted/.test(String(errMessage(e)))) throw e;
            console.error(`note: skipped the CA-consistency check (${errMessage(e)})`);
          }
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
  addSetup(program, 'shortcut for `tug control setup`');
  control
    .command('backup')
    .description(
      'create a control-plane backup (state, PKI, master key and retained image archives; not workload volumes)',
    )
    .option('--no-images', 'leave the retained build archives out (deploy again to rebuild them)')
    .action(async (o: { images: boolean }) =>
      withProgress('Creating control-plane backup', async () =>
        print(await request('POST', '/api/v1/control/backups/run', { images: o.images })),
      ),
    );
  control
    .command('restore <artifactRef>')
    .description(
      'restore a control-plane backup on the control-plane host; requires a control restart',
    )
    .option('--confirm')
    .action(async (artifactRef: string, o: { confirm?: boolean }) =>
      withProgress('Restoring control-plane backup', async () =>
        print(
          await request('POST', '/api/v1/control/restore', {
            artifactRef,
            confirm: Boolean(o.confirm),
          }),
        ),
      ),
    );
}
