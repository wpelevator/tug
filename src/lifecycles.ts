import { defineLifecycle } from './lifecycle.ts';

// Every persisted lifecycle in one place. Read the tables as "from: [possible next states]".

export const deploymentLifecycle = defineLifecycle({
  name: 'deployment',
  table: 'deployments',
  column: 'state',
  // A rollback is published without a build, so it starts already rolling out.
  initial: ['building', 'rolling_out'],
  transitions: {
    building: ['rolling_out', 'build_failed', 'cancelled'],
    rolling_out: ['succeeded', 'failed', 'cancelled'],
    succeeded: [],
    failed: [],
    build_failed: [],
    cancelled: [],
  },
});
export type DeploymentState = keyof typeof deploymentLifecycle.transitions;

/** A node command. `expired` is a command nobody fetched before its deadline; it is never delivered late. */
export const commandLifecycle = defineLifecycle({
  name: 'command',
  table: 'commands',
  column: 'state',
  initial: ['pending'],
  transitions: {
    pending: ['running', 'expired', 'cancelled'],
    running: ['succeeded', 'failed'],
    succeeded: [],
    failed: [],
    expired: [],
    cancelled: [],
  },
});
export type CommandState = keyof typeof commandLifecycle.transitions;

/** One run of a backup. `missed` and `cancelled` runs never reached a node, so they are inserted already finished. */
export const backupRunLifecycle = defineLifecycle({
  name: 'backup run',
  table: 'backup_runs',
  column: 'state',
  initial: ['queued', 'missed', 'cancelled'],
  transitions: {
    // A result can arrive before the first heartbeat, so a queued run may finish directly.
    queued: ['running', 'succeeded', 'failed', 'missed'],
    running: ['succeeded', 'failed'],
    succeeded: [],
    failed: [],
    missed: [],
    cancelled: [],
  },
});
export type BackupRunState = keyof typeof backupRunLifecycle.transitions;

/**
 * An in-place restore holds, snapshots, restores and verifies; a scratch restore goes straight to `restoring`.
 * `interrupted` means the data may be partly restored, so the writers stay held until the operator resumes
 * (back to `restoring`) or releases it.
 */
export const restoreLifecycle = defineLifecycle({
  name: 'restore',
  table: 'restore_runs',
  column: 'state',
  initial: ['locking'],
  transitions: {
    locking: ['holding', 'restoring', 'failed'],
    holding: ['safety_backup', 'restoring', 'failed'],
    safety_backup: ['restoring', 'failed'],
    restoring: ['verifying', 'succeeded', 'failed', 'interrupted'],
    verifying: ['succeeded'],
    // Resuming can fail to queue again, which leaves it interrupted with a new error.
    interrupted: ['restoring', 'released', 'interrupted'],
    succeeded: [],
    failed: [],
    released: [],
  },
});
export type RestoreState = keyof typeof restoreLifecycle.transitions;

/** Restore states during which an in-place restore keeps the project locked. */
export const RESTORE_LOCKED_STATES: readonly RestoreState[] = [
  'locking',
  'holding',
  'safety_backup',
  'restoring',
  'interrupted',
];

/** An image build. `pruned` archives can no longer be deployed; `failed` builds never produced one. */
export const buildLifecycle = defineLifecycle({
  name: 'build',
  table: 'builds',
  column: 'state',
  initial: ['building'],
  transitions: {
    building: ['complete', 'failed'],
    complete: ['pruned'],
    failed: [],
    pruned: [],
  },
});
export type BuildState = keyof typeof buildLifecycle.transitions;
