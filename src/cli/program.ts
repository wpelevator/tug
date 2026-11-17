import { Command } from 'commander';
import {
  applyConfigDefaults,
  commandPath,
  integerOption,
  nodeSettings,
  resolveCliConfig,
} from './config.ts';
import { CliLiveError } from './live.ts';
import { setVerbose } from './process.ts';
import { isUsageError, resetUsage } from './usage.ts';
import { addJsonOption } from './json-option.ts';
import { CREDENTIAL_NAME_PATTERN, PROJECT_NAME_PATTERN } from '../roles.ts';
import { packageVersion } from '../images/image.ts';
import { errMessage } from '../errors.ts';
import { CONFIG_HELP, setResolvedConfig } from './commands/context.ts';

import { CommanderError } from 'commander';

const VERBOSE_HELP =
  'show the output of quiet steps, such as Docker pulls and installers on a remote host (also TUG_VERBOSE=1)';

/** Top-level command name to the module that registers it, so `tug credential list` loads one command, not all of them. */
const COMMAND_MODULES: Record<string, () => Promise<(program: Command) => void>> = {
  init: async () => (await import('./commands/init.ts')).registerInit,
  control: async () => (await import('./commands/control.ts')).registerControl,
  setup: async () => (await import('./commands/control.ts')).registerControl,
  upgrade: async () => (await import('./commands/upgrade.ts')).registerUpgrade,
  node: async () => (await import('./commands/node.ts')).registerNode,
  deploy: async () => (await import('./commands/deploy.ts')).registerDeploy,
  rollback: async () => (await import('./commands/deploy.ts')).registerDeploy,
  scale: async () => (await import('./commands/deploy.ts')).registerDeploy,
  restart: async () => (await import('./commands/deploy.ts')).registerDeploy,
  status: async () => (await import('./commands/observe.ts')).registerObserve,
  events: async () => (await import('./commands/observe.ts')).registerObserve,
  doctor: async () => (await import('./commands/observe.ts')).registerObserve,
  tui: async () => (await import('./commands/tui.ts')).registerTui,
  exec: async () => (await import('./commands/service.ts')).registerService,
  run: async () => (await import('./commands/service.ts')).registerService,
  ps: async () => (await import('./commands/service.ts')).registerService,
  inspect: async () => (await import('./commands/service.ts')).registerService,
  logs: async () => (await import('./commands/service.ts')).registerService,
  hold: async () => (await import('./commands/hold.ts')).registerHold,
  image: async () => (await import('./commands/image.ts')).registerImage,
  lint: async () => (await import('./commands/lint.ts')).registerLint,
  secret: async () => (await import('./commands/secret.ts')).registerSecret,
  var: async () => (await import('./commands/var.ts')).registerVar,
  domain: async () => (await import('./commands/domain.ts')).registerDomain,
  ingress: async () => (await import('./commands/ingress.ts')).registerIngress,
  backup: async () => (await import('./commands/backup.ts')).registerBackup,
  restore: async () => (await import('./commands/restore.ts')).registerRestore,
  credential: async () => (await import('./commands/credential.ts')).registerCredential,
  volume: async () => (await import('./commands/volume.ts')).registerVolume,
};

/** Registration order is the order `tug --help` lists the commands in. */
const ALL_REGISTRARS = [
  'init',
  'control',
  'upgrade',
  'node',
  'deploy',
  'status',
  'tui',
  'exec',
  'hold',
  'image',
  'lint',
  'secret',
  'var',
  'domain',
  'ingress',
  'backup',
  'restore',
  'credential',
  'volume',
];

/** The top-level command names that load on their own; the test compares them with `tug --help`. */
export const LAZY_COMMANDS = Object.keys(COMMAND_MODULES);

const ROOT_OPTIONS_WITH_VALUE = ['--config', '--control-url', '--credential', '--project'];

/** The command the arguments name, or undefined when they ask for help, the version or something unknown. */
function namedCommand(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--verbose' || ROOT_OPTIONS_WITH_VALUE.some((o) => arg.startsWith(o + '=')))
      continue;
    if (ROOT_OPTIONS_WITH_VALUE.includes(arg)) {
      i++;
      continue;
    }
    return arg in COMMAND_MODULES ? arg : undefined;
  }
  return undefined;
}

async function createProgram(argv: readonly string[]): Promise<Command> {
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
    .option('--project <name>', 'project (overrides TUG_PROJECT and config; default: site)')
    .option('--verbose', VERBOSE_HELP);

  const only = namedCommand(argv);
  for (const name of only ? [only] : ALL_REGISTRARS) (await COMMAND_MODULES[name]())(program);

  /** Commands that may create the config file, so a selected file need not exist yet. */
  const CREATES_CONFIG = ['init', 'control setup'];
  const NODE_NAME_FROM_ARGUMENT = ['node register', 'node replace', 'node repair', 'node upgrade'];
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
    if (path === 'control restore' && options.snapshot && !options.fromDestination)
      throw new Error('--snapshot goes with --from-destination');
    if (path === 'control restore' && options.passwordStdin && !options.fromDestination)
      throw new Error('--password-stdin goes with --from-destination');
    const positional = path === 'exec' ? command.args.slice(0, 1) : command.args;
    for (const value of [
      ...positional,
      ...Object.values(options),
      ...Object.values(program.opts()),
    ])
      if (typeof value === 'string' && /[\r\n\0]/.test(value))
        throw new Error('arguments and option values must not contain line breaks or NUL');
    if (path === 'exec' && command.args.slice(1).some((value) => value.includes('\0')))
      throw new Error('exec command arguments must not contain NUL');
    if (options.name && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(options.name))
      throw new Error('--name must contain only letters, numbers, dots, underscores or hyphens');
    const connection = command.optsWithGlobals();
    if (connection.verbose) setVerbose(true);
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
      ...(path.startsWith('node ') || path === 'control setup' || path === 'control upgrade'
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
    // exec and run forward everything after the service to a remote command, which may take its own --verbose.
    if (!['exec', 'run'].includes(command.name())) command.option('--verbose', VERBOSE_HELP);
    if (!command.options.some((option) => option.long === '--project'))
      command.option(
        '--project <name>',
        'project (overrides TUG_PROJECT and config; default: site)',
      );
  }
  /** Commander throws a CommanderError instead of calling process.exit, so runCli can return the code. */
  function exitByThrowing(command: Command): void {
    command.exitOverride();
    for (const child of command.commands) exitByThrowing(child);
  }
  function forbidExtraArguments(command: Command): void {
    command.allowExcessArguments(false);
    for (const child of command.commands) forbidExtraArguments(child);
  }
  for (const command of program.commands) addJsonOption(command);
  for (const command of program.commands) addConnectionOptions(command);
  forbidExtraArguments(program);
  exitByThrowing(program);
  program.showHelpAfterError();

  return program;
}

/**
 * Runs the CLI with the given arguments (without node and the script) and returns the exit code. It reads
 * process.env, process.cwd() and writes to process.stdout and process.stderr, so a test can swap those and run it
 * in-process instead of starting a node process for every invocation.
 */
export async function runCli(argv: readonly string[]): Promise<number> {
  process.exitCode = undefined;
  resetUsage();
  setVerbose(['1', 'true'].includes(process.env.TUG_VERBOSE ?? ''));
  try {
    const program = await createProgram(argv);
    await program.parseAsync([...argv], { from: 'user' });
    return Number(process.exitCode ?? 0);
  } catch (e) {
    // Commander has already printed its own usage errors, help and version.
    if (e instanceof CommanderError) return e.exitCode;
    console.error(
      isUsageError(errMessage(e))
        ? `${errMessage(e)}\nRun tug <command> --help for usage.`
        : errMessage(e),
    );
    return e instanceof CliLiveError ? e.exitCode : 1;
  }
}
