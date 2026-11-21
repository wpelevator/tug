import type { BackupJobResult, CommandResultPayload } from '../protocol.ts';

/** One repository probed from control's host. `skipped` follows a failed `_control` on the same destination. */
export interface ControlRepositoryCheck {
  name: string;
  repository: string;
  state: 'ok' | 'initialized' | 'error' | 'skipped';
  error?: string;
}

/**
 * What a node that runs a project's backups reports about the destination. `missing` is not a failure: the first
 * backup creates the repository. `pending` appears only while the check is `running`.
 */
export type NodeCheckState = 'ok' | 'missing' | 'error' | 'offline' | 'timeout';
export interface NodeCheck {
  project: string;
  node: string;
  state: NodeCheckState | 'pending';
  error?: string;
}

/** What `check_result_json` holds and `GET /api/v1/backup/destination` serves as `checkResult`. */
export interface DestinationCheckResult {
  checkId: string;
  state: 'running' | 'done';
  startedAt: string;
  /** Present once the check is done. */
  ok?: boolean;
  checkedAt?: string;
  from: 'control';
  url: string;
  repositories: ControlRepositoryCheck[];
  nodes: NodeCheck[];
  /** Why the check stopped before every part answered, such as a control restart. */
  error?: string;
}

/** Overall verdict: a control-host repository or a node that failed, was offline or did not answer fails the check. */
export function checkPassed(
  repositories: readonly Pick<ControlRepositoryCheck, 'state'>[],
  nodes: readonly Pick<NodeCheck, 'state'>[],
): boolean {
  return (
    repositories.every((repository) => repository.state !== 'error') &&
    nodes.every((node) => !['error', 'offline', 'timeout', 'pending'].includes(node.state))
  );
}

/** Turns the result of a `backup.check` command into the node's entry; `redact` strips credential values from errors. */
export function nodeCheckFromResult(
  entry: Pick<NodeCheck, 'project' | 'node'>,
  state: string,
  result: CommandResultPayload,
  redact: (text: string) => string,
): NodeCheck {
  if (state === 'succeeded')
    return {
      ...entry,
      state: (result as BackupJobResult).repository === 'missing' ? 'missing' : 'ok',
    };
  const error = (result as { error?: string }).error ?? 'the check failed';
  return { ...entry, state: 'error', error: redact(error).slice(0, 2000) };
}

export interface CommandOutcome {
  state: string;
  result: CommandResultPayload;
}

/**
 * The `backup.check` commands of running checks, so a command result is routed to its check and never reaches the
 * backup-run bookkeeping. Memory only: after a control restart the check itself is marked interrupted.
 */
export class CheckCommands {
  private readonly waiting = new Map<
    string,
    { resolve: (outcome: CommandOutcome | 'timeout') => void; expire: () => void }
  >();

  /** Resolves with the node's outcome, or `timeout` after `timeoutMs`; `onTimeout` runs before it resolves. */
  wait(
    commandId: string,
    timeoutMs: number,
    onTimeout: () => void,
  ): Promise<CommandOutcome | 'timeout'> {
    return new Promise((resolve) => {
      const expire = () => {
        clearTimeout(timer);
        this.waiting.delete(commandId);
        try {
          onTimeout();
        } finally {
          resolve('timeout');
        }
      };
      const timer = setTimeout(expire, timeoutMs);
      timer.unref();
      this.waiting.set(commandId, {
        expire,
        resolve: (outcome) => {
          clearTimeout(timer);
          this.waiting.delete(commandId);
          resolve(outcome);
        },
      });
    });
  }

  /** True when the command belonged to a running check, which has now taken the result. */
  onResult(commandId: string, state: string, result: CommandResultPayload): boolean {
    const waiting = this.waiting.get(commandId);
    if (!waiting) return false;
    waiting.resolve({ state, result });
    return true;
  }

  /** Stops every waiting command now, as if each had timed out: their check was abandoned. */
  cancelAll(): void {
    for (const { expire } of [...this.waiting.values()]) expire();
  }
}
