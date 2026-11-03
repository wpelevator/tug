#!/usr/bin/env node
import { Command } from 'commander';
import {
  applyConfigDefaults,
  commandPath,
  integerOption,
  nodeSettings,
  resolveCliConfig,
} from './cli-config.ts';
import { CliLiveError } from './cli-live.ts';
import { CREDENTIAL_NAME_PATTERN, PROJECT_NAME_PATTERN } from './credentials.ts';
import { packageVersion } from './image.ts';
import { errMessage } from './util.ts';
import { CONFIG_HELP, setResolvedConfig } from './commands/context.ts';
import { registerBackup } from './commands/backup.ts';
import { registerControl } from './commands/control.ts';
import { registerCredential } from './commands/credential.ts';
import { registerDeploy } from './commands/deploy.ts';
import { registerInit } from './commands/init.ts';
import { registerNode } from './commands/node.ts';
import { registerObserve } from './commands/observe.ts';
import { registerRestore } from './commands/restore.ts';
import { registerHold } from './commands/hold.ts';
import { registerImage } from './commands/image.ts';
import { registerSecret } from './commands/secret.ts';
import { registerService } from './commands/service.ts';
import { registerVolume } from './commands/volume.ts';

const program = new Command();
program
  .name('tug')
  .description('Deploy Docker Compose applications to your own servers')
  .version(packageVersion())
  .enablePositionalOptions()
  .option('--config <file>', CONFIG_HELP)
  .option(
    '--control-url <url>',
    'connect target for the control API (the credential still verifies its own public URL)',
  )
  .option(
    '--credential <file>',
    'credential file (overrides TUG_CREDENTIAL, TUG_CREDENTIAL_FILE and config)',
  )
  .option('--project <name>', 'project (overrides TUG_PROJECT and config; default: site)');

registerInit(program);
registerControl(program);
registerNode(program);
registerDeploy(program);
registerObserve(program);
registerService(program);
registerHold(program);
registerImage(program);
registerSecret(program);
registerBackup(program);
registerRestore(program);
registerCredential(program);
registerVolume(program);

/** Commands that may create the config file, so a selected file need not exist yet. */
const CREATES_CONFIG = ['init', 'control setup'];
const NODE_NAME_FROM_ARGUMENT = ['node register', 'node replace', 'node repair'];
const NODE_NAME_FROM_OPTION = ['node add', 'node enroll'];

program.hook('preAction', async (_root, command) => {
  const path = commandPath(command);
  const options = command.opts();
  for (const [key, min, max] of [
    ['port', 1, 65535],
    ['timeout', 1, 86400],
    ['ttl', 1, 31536000],
    ['uses', 1, 1000000],
    ['expiresInDays', 1, 3650],
    ['limit', 1, 500],
    ['tail', 0, 1000000],
  ] as const) {
    if (options[key] !== undefined)
      integerOption(
        String(options[key]),
        '--' + key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()),
        min,
        max,
      );
  }
  if (path === 'control restore' && !options.confirm)
    throw new Error('control restore requires --confirm');
  const positional = path === 'exec' ? command.args.slice(0, 1) : command.args;
  for (const value of [...positional, ...Object.values(options), ...Object.values(program.opts())])
    if (typeof value === 'string' && /[\r\n\0]/.test(value))
      throw new Error('arguments and option values must not contain line breaks or NUL');
  if (path === 'exec' && command.args.slice(1).some((value) => value.includes('\0')))
    throw new Error('exec command arguments must not contain NUL');
  if (options.name && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(options.name))
    throw new Error('--name must contain only letters, numbers, dots, underscores or hyphens');
  const connection = command.optsWithGlobals();
  if (path === 'credential create') {
    // --project is repeatable here and scopes the new credential, so it must not also select the connection project.
    if (!CREDENTIAL_NAME_PATTERN.test(command.args[0]))
      throw new Error(
        'credential name must be 1-64 letters, numbers, dots, underscores or hyphens, starting with a letter or number',
      );
    for (const project of options.project as string[])
      if (!PROJECT_NAME_PATTERN.test(project))
        throw new Error(
          '--project must contain only letters, numbers, dots, underscores or hyphens',
        );
    if (options.role === 'admin' && options.project.length)
      throw new Error(
        'admin credentials cannot be limited to projects; use --role read or --role deploy with --project',
      );
    connection.project = undefined;
  }
  const resolved = await resolveCliConfig(
    connection,
    process.env,
    process.cwd(),
    CREATES_CONFIG.includes(path),
  );
  setResolvedConfig(resolved);
  // Config values are defaults for options not given on the command line; nodes are only read by the
  // commands that create or register one, never by commands that talk to an existing node.
  const nodeName = NODE_NAME_FROM_ARGUMENT.includes(path)
    ? command.args[0]
    : NODE_NAME_FROM_OPTION.includes(path)
      ? (options.name as string | undefined)
      : undefined;
  applyConfigDefaults(command, options, {
    ...resolved.commandDefaults,
    ...(path.startsWith('node ') || path === 'control setup'
      ? nodeSettings(resolved, nodeName)
      : {}),
  });
});

/** Every command that does work accepts the connection options, so they can follow the command. */
function addConnectionOptions(command: Command): void {
  if (command.commands.length) {
    for (const child of command.commands) addConnectionOptions(child);
    // `deploy` is both a command and the parent of `deploy cancel`.
    if (!command.options.length) return;
  }
  command
    .option('--config <file>', CONFIG_HELP)
    .option(
      '--control-url <url>',
      'connect target for the control API (the credential still verifies its own public URL)',
    )
    .option(
      '--credential <file>',
      'credential file (overrides TUG_CREDENTIAL, TUG_CREDENTIAL_FILE and config)',
    );
  if (!command.options.some((option) => option.long === '--project'))
    command.option('--project <name>', 'project (overrides TUG_PROJECT and config; default: site)');
}
function forbidExtraArguments(command: Command): void {
  command.allowExcessArguments(false);
  for (const child of command.commands) forbidExtraArguments(child);
}
for (const command of program.commands) addConnectionOptions(command);
forbidExtraArguments(program);
program.showHelpAfterError();
program.parseAsync().catch((e: unknown) => {
  console.error(`${errMessage(e)}\nRun tug <command> --help for usage.`);
  process.exitCode = e instanceof CliLiveError ? e.exitCode : 1;
});
