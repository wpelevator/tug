import { Command, CommanderError } from 'commander';
import {
  applyConfigDefaults,
  commandPath,
  integerOption,
  nodeSettings,
  resolveCliConfig,
} from './config.ts';
import { CliLiveError } from './live.ts';
import { err, processRuntime } from './runtime.ts';
import type { CliRuntime } from './runtime.ts';
import { addJsonOption } from './json-option.ts';
import { CREDENTIAL_NAME_PATTERN, PROJECT_NAME_PATTERN } from '../roles.ts';
import { packageVersion } from '../images/image.ts';
import { errMessage } from '../errors.ts';
import { CONFIG_HELP } from './commands/context.ts';

const VERBOSE_HELP =
  'show the output of quiet steps, such as Docker pulls and installers on a remote host (also TUG_VERBOSE=1)';

type Register = (rt: CliRuntime, program: Command) => void;

/**
 * The modules that register the top-level commands, in the order `tug --help` lists them. Each lists every top-level
 * name it adds, so `tug credential list` loads one module, not all of them; `--help`, `--version` and a name that no
 * module lists load every module. src/cli/program.test.ts compares the names with the real help.
 */
const REGISTRARS: { names: string[]; load: () => Promise<Register> }[] = [
  { names: ['init'], load: async () => (await import('./commands/init.ts')).registerInit },
  {
    names: ['control', 'setup'],
    load: async () => (await import('./commands/control.ts')).registerControl,
  },
  { names: ['upgrade'], load: async () => (await import('./commands/upgrade.ts')).registerUpgrade },
  { names: ['node'], load: async () => (await import('./commands/node.ts')).registerNode },
  {
    names: ['deploy', 'rollback', 'scale', 'restart'],
    load: async () => (await import('./commands/deploy.ts')).registerDeploy,
  },
  {
    names: ['status', 'events', 'doctor'],
    load: async () => (await import('./commands/observe.ts')).registerObserve,
  },
  { names: ['tui'], load: async () => (await import('./commands/tui.ts')).registerTui },
  {
    names: ['exec', 'run', 'ps', 'inspect', 'logs'],
    load: async () => (await import('./commands/service.ts')).registerService,
  },
  { names: ['hold'], load: async () => (await import('./commands/hold.ts')).registerHold },
  { names: ['image'], load: async () => (await import('./commands/image.ts')).registerImage },
  { names: ['lint'], load: async () => (await import('./commands/lint.ts')).registerLint },
  {
    names: ['registry'],
    load: async () => (await import('./commands/registry.ts')).registerRegistry,
  },
  { names: ['secret'], load: async () => (await import('./commands/secret.ts')).registerSecret },
  { names: ['var'], load: async () => (await import('./commands/var.ts')).registerVar },
  { names: ['domain'], load: async () => (await import('./commands/domain.ts')).registerDomain },
  { names: ['ingress'], load: async () => (await import('./commands/ingress.ts')).registerIngress },
  { names: ['backup'], load: async () => (await import('./commands/backup.ts')).registerBackup },
  { names: ['restore'], load: async () => (await import('./commands/restore.ts')).registerRestore },
  {
    names: ['credential'],
    load: async () => (await import('./commands/credential.ts')).registerCredential,
  },
  { names: ['volume'], load: async () => (await import('./commands/volume.ts')).registerVolume },
];

/** The top-level command names that load on their own; the test compares them with `tug --help`. */
export const LAZY_COMMANDS = REGISTRARS.flatMap((registrar) => registrar.names);

/**
 * The command the arguments name, or undefined when they ask for help, the version or something unknown. The root
 * options come from the program itself, so an option added there cannot be mistaken for the command.
 */
function namedCommand(program: Command, argv: readonly string[]): string | undefined {
  const flags = (option: { long?: string; short?: string }) =>
    [option.long, option.short].filter((flag): flag is string => !!flag);
  const takesValue = new Set(
    program.options.filter((o) => o.required || o.optional).flatMap(flags),
  );
  const known = new Set(program.options.flatMap(flags));
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const flag = arg.startsWith('--') ? arg.split('=')[0] : arg;
    if (known.has(flag)) {
      if (takesValue.has(flag) && !arg.includes('=')) i++;
      continue;
    }
    return LAZY_COMMANDS.includes(arg) ? arg : undefined;
  }
  return undefined;
}

async function createProgram(rt: CliRuntime, argv: readonly string[]): Promise<Command> {
  const program = new Command();
  // Set before any command is added: commands copy these settings when they are created.
  program.exitOverride().configureOutput({
    writeOut: (text) => void rt.stdout.write(text),
    writeErr: (text) => void rt.stderr.write(text),
    getOutHelpWidth: () => rt.stdout.columns ?? 80,
    getErrHelpWidth: () => rt.stderr.columns ?? 80,
    getOutHasColors: () => !!rt.stdout.isTTY && !rt.env.NO_COLOR,
    getErrHasColors: () => !!rt.stderr.isTTY && !rt.env.NO_COLOR,
  });
  program
    .name('tug')
    .description('Deploy Docker Compose applications to your own servers')
    .version(rt.version)
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

  const only = namedCommand(program, argv);
  for (const registrar of REGISTRARS)
    if (!only || registrar.names.includes(only)) (await registrar.load())(rt, program);

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
    if (connection.verbose) rt.state.verbose = true;
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
      rt.env,
      rt.cwd,
      CREATES_CONFIG.includes(path),
    );
    rt.state.config = resolved;
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
  function forbidExtraArguments(command: Command): void {
    command.allowExcessArguments(false);
    for (const child of command.commands) forbidExtraArguments(child);
  }
  for (const command of program.commands) addJsonOption(command);
  for (const command of program.commands) addConnectionOptions(command);
  forbidExtraArguments(program);
  program.showHelpAfterError();

  return program;
}

/**
 * Runs the CLI with the given arguments (without node and the script) and returns the exit code. Everything it reads
 * from or writes to the process goes through `rt`, so a test passes a runtime of its own and runs it in-process.
 */
export async function runCli(
  argv: readonly string[],
  rt: CliRuntime = processRuntime(packageVersion()),
): Promise<number> {
  try {
    const program = await createProgram(rt, argv);
    await program.parseAsync([...argv], { from: 'user' });
    return rt.exitCode ?? 0;
  } catch (e) {
    // Commander has already printed its own usage errors, help and version.
    if (e instanceof CommanderError) return e.exitCode;
    const message = errMessage(e);
    // An error before any work began is a mistake in the arguments; one after that, or a cancellation, is not.
    const usage = !rt.state.workStarted && !/^cancelled/.test(message);
    err(rt, usage ? `${message}\nRun tug <command> --help for usage.` : message);
    return e instanceof CliLiveError ? e.exitCode : 1;
  }
}
