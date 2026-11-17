import type { Command } from 'commander';
import { loadCfg } from './context.ts';
import { runControlUpgrade } from './control.ts';
import { runNodeUpgrade } from './node.ts';
import type { CliRuntime } from '../runtime.ts';

interface UpgradeAllOpts {
  to?: string;
  buildLocalImage?: boolean;
  force?: boolean;
  yes?: boolean;
}

/**
 * `tug upgrade`: control first, then every configured node, because control refuses agents that run ahead of it. It stops
 * when control fails, so no agent is touched against a control that did not upgrade.
 */
export function registerUpgrade(rt: CliRuntime, program: Command): void {
  program
    .command('upgrade')
    .description(
      "upgrade the control plane (controlSsh in the config file) and then every node with an ssh target (nodes.<name>.ssh) to this CLI's version or --to, in that order; per-node images from the config are ignored, use `control upgrade` and `node upgrade` to pin one",
    )
    .option('--to <version>', "upgrade to this published version instead of the CLI's own")
    .option(
      '--build-local-image',
      'build the image from the current checkout and copy it to each host over SSH; for development',
    )
    .option(
      '--force',
      'recreate the control container and every agent even when already on the target image',
    )
    .option('-y, --yes', 'do not ask for confirmation in a terminal')
    .action(async (o: UpgradeAllOpts, command: Command) => {
      const cfg = loadCfg(rt);
      if (!cfg.controlSsh)
        throw new Error(
          `upgrade needs controlSsh in ${cfg.file}: the SSH target of the control host`,
        );
      if (!(await runControlUpgrade(rt, undefined, o))) {
        rt.exitCode = 1;
        return;
      }
      const ok = await runNodeUpgrade(
        rt,
        {},
        { all: true, wait: true, to: o.to, buildLocalImage: o.buildLocalImage, force: o.force },
        command,
      );
      if (!ok) rt.exitCode = 1;
    });
}
