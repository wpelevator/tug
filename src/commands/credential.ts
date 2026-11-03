import { selectMany } from '../cli-selection.ts';
import { selectResource } from './selection.ts';
import type { Command } from 'commander';
import { Option } from 'commander';
import { ROLES } from '../credentials.ts';
import { print, request } from './context.ts';

export function registerCredential(program: Command): void {
  const credential = program
    .command('credential')
    .description('create, list and revoke operator credentials');
  credential
    .command('create <name>')
    .description(
      'create a named operator credential for CI or a teammate; it is printed once, control keeps no copy of its private key, and it expires after one year at most',
    )
    .addOption(
      new Option(
        '--role <role>',
        'read: status and listings; deploy: read plus deploy, rollback, cancel, restart, logs; admin: everything',
      )
        .choices(ROLES)
        .makeOptionMandatory(),
    )
    .addOption(
      new Option(
        '--project <name>',
        'limit a read or deploy credential to this project; repeat for several',
      )
        .default([] as string[], 'all projects')
        .argParser((value: string, previous: string[]) => [...previous, value]),
    )
    .option('--select-projects', 'choose existing projects for the credential scope')
    .option(
      '--expires-in-days <n>',
      'expire the credential after this many days (default and maximum: 365)',
    )
    .action(
      async (
        name: string,
        o: { role: string; project: string[]; expiresInDays?: string; selectProjects?: boolean },
      ) => {
        if (o.selectProjects) {
          if (o.role === 'admin' || o.project.length)
            throw new Error('--select-projects requires read/deploy role and no --project');
          o.project = await selectMany(
            'Select projects (choose all projects alone for unrestricted access)',
            async () => {
              const { projects } = await request<{ projects: { name: string }[] }>(
                'GET',
                '/api/v1/projects',
              );
              return [
                { value: '*', label: 'All projects, including future projects' },
                ...projects.map((project) => ({ value: project.name, label: project.name })),
              ];
            },
          );
          if (o.project.includes('*')) {
            if (o.project.length !== 1) throw new Error('all projects must be selected alone');
            o.project = [];
          }
        }
        const created = await request('POST', '/api/v1/credentials', {
          name,
          role: o.role,
          projects: o.project.length ? o.project : undefined,
          expiresInSeconds: o.expiresInDays ? Number(o.expiresInDays) * 86400 : undefined,
        });
        console.error(
          'Store this credential now (for example as the TUG_CREDENTIAL secret in CI); it is not shown again. Replace one by creating a new name, verifying it, then revoking the old name.',
        );
        print(created);
      },
    );
  credential
    .command('list')
    .description(
      'list operator credentials with role, projects, expiry and last use; secrets are never shown',
    )
    .action(async () => print(await request('GET', '/api/v1/credentials')));
  credential
    .command('revoke [name]')
    .description(
      'revoke an operator credential immediately; its name stays reserved for the audit trail',
    )
    .action(async (name: string) =>
      print(
        await request(
          'DELETE',
          `/api/v1/credentials/${encodeURIComponent(await selectResource(name, 'credentials'))}`,
        ),
      ),
    );
}
