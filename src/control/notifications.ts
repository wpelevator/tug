import { createHmac } from 'node:crypto';
import type { RedactableEvent } from './event-redaction.ts';

export interface NotificationEvent extends RedactableEvent {
  id: string;
  level?: string | null;
  project_id?: string | null;
  deployment_id?: string | null;
  node_id?: string | null;
}

export interface WebhookOptions {
  url: string;
  secret: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxAttempts?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  maxQueue?: number;
  maxRememberedIds?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Permit HTTP loopback endpoints for tests that use a local receiver. */
  allowHttpLoopback?: boolean;
  /** Called after retries are exhausted; receives only the transition ID, never request/error details. */
  onError?: (eventId: string) => void;
}

export interface WebhookNotifier {
  /** Enqueues without waiting for the network. Returns false when disabled or full. */
  enqueue(event: NotificationEvent): boolean;
  /** Stops new work and waits for the current queue to drain. */
  close(): Promise<void>;
  /** Discards waiting work and aborts delivery during process shutdown. */
  stop(): void;
  readonly pending: number;
  readonly stats: Readonly<{ delivered: number; failed: number; dropped: number; pending: number }>;
}

interface WireEvent {
  id: string;
  type: string;
  message: string;
  project_id?: string | null;
  deployment_id?: string | null;
  node_id?: string | null;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const TRANSITION_MESSAGES: Record<string, string> = {
  'control.backup_failed':
    'Control backup failed. Check control backup status and the off-host destination.',
  'node.stale': 'Node stopped reporting. Check node connectivity and the tug agent service.',
  'node.recovered': 'Node is reporting again. Confirm its services and deployments are healthy.',
  'service.failed': 'A service failed. Check the service status and recent deployment.',
  'container.crashloop': 'A container keeps restarting. Check its health and recent logs.',
  'container.oom': 'A container ran out of memory. Check memory use and workload limits.',
  'container.unhealthy':
    'A container failed its health check. Check its status and health endpoint.',
  'deploy.failed':
    'A deployment failed. Inspect deployment status and retry after resolving the cause.',
  'deployment.failed':
    'A deployment failed. Inspect deployment status and retry after resolving the cause.',
  'deployment.build_failed': 'A deployment build failed. Check build inputs and retry the build.',
  'deploy.succeeded': 'A deployment completed. Confirm the application is healthy.',
  'deployment.succeeded': 'A deployment completed. Confirm the application is healthy.',
  'build.failed': 'An image build failed. Check build inputs and retry the build.',
  build_failed: 'An image build failed. Check build inputs and retry the build.',
  'rollback.auto': 'An automatic rollback ran. Confirm the previous deployment is healthy.',
  'deployment.auto_rollback':
    'An automatic rollback ran. Confirm the previous deployment is healthy.',
  'deployment.auto_rollback_skipped':
    'Automatic rollback was skipped. Review deployment health and rollback settings.',
  'backup.failed': 'A backup failed. Check the target and backup destination, then retry it.',
  'backup.missed': 'A scheduled backup was missed. Check the schedule and backup destination.',
  'backup.stale': 'A backup is taking longer than expected. Check the target node and backup job.',
  'backup.retention_failed':
    'Backup retention failed, so old snapshots are not being removed. Check the backup destination and its repository lock, or set it to external retention if it is append-only.',
  'backup.retention_recovered': 'Backup retention works again.',
  'backup.completed': 'A backup completed. Confirm the latest recovery point is available.',
  'backup.no_destination': 'A backup was skipped because no destination is configured.',
  'restore.failed':
    'A restore failed. Review the restore status before releasing any held writers.',
  'restore.interrupted':
    'A restore was interrupted. Review its status before releasing held writers.',
  'restore.succeeded': 'A restore completed. Confirm the restored service is healthy.',
  'restore.completed': 'A restore completed. Confirm the restored service is healthy.',
  'ingress.failed': 'Ingress health failed. Check the ingress node and its recent logs.',
};

/** Whitelist the node state transitions and build a safe, generic outbound message. */
export function sanitizeNotificationEvent(event: NotificationEvent): WireEvent | undefined {
  const message = TRANSITION_MESSAGES[event.type];
  if (!message) return undefined;
  return {
    id: event.id,
    type: event.type,
    message,
    ...(event.project_id !== undefined ? { project_id: event.project_id } : {}),
    ...(event.deployment_id !== undefined ? { deployment_id: event.deployment_id } : {}),
    ...(event.node_id !== undefined ? { node_id: event.node_id } : {}),
  };
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || host === '127.0.0.1' || host.startsWith('127.');
}

export function validateWebhookUrl(rawUrl: string, allowHttpLoopback = false): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Webhook URL must be an absolute HTTPS URL');
  }
  if (url.username || url.password) throw new Error('Webhook URL must not contain credentials');
  if (
    url.protocol !== 'https:' &&
    !(allowHttpLoopback && url.protocol === 'http:' && isLoopback(url.hostname))
  )
    throw new Error('Webhook destination must use HTTPS');
  return url;
}

/** Build a best-effort webhook sender. Network work runs in a bounded background queue. */
export function createWebhookNotifier(options: WebhookOptions): WebhookNotifier {
  const url = validateWebhookUrl(options.url, options.allowHttpLoopback);
  if (!options.secret) throw new Error('Webhook signing secret must not be empty');
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const maxAttempts = options.maxAttempts ?? 3;
  const retryBaseMs = options.retryBaseMs ?? 250;
  const retryMaxMs = options.retryMaxMs ?? 2_000;
  const maxQueue = options.maxQueue ?? 100;
  const maxRememberedIds = options.maxRememberedIds ?? 2_000;
  const queue: WireEvent[] = [];
  const seen = new Set<string>();
  let running = false;
  let closed = false;
  let stopped = false;
  let activeController: AbortController | undefined;
  let idleWaiters: (() => void)[] = [];
  const counts = { delivered: 0, failed: 0, dropped: 0 };

  function remember(id: string) {
    seen.add(id);
    if (seen.size > maxRememberedIds) seen.delete(seen.values().next().value as string);
  }

  async function deliver(event: WireEvent) {
    const safeEvent = event;
    const timestamp = Math.floor(now() / 1000).toString();
    const body = JSON.stringify({ timestamp: Number(timestamp), event: safeEvent });
    const signature = createHmac('sha256', options.secret)
      .update(`${timestamp}.${body}`)
      .digest('hex');
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (stopped) return;
      const controller = new AbortController();
      activeController = controller;
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetcher(url, {
          method: 'POST',
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            'x-tug-webhook-id': event.id,
            'x-tug-webhook-timestamp': timestamp,
            'x-tug-webhook-signature': `sha256=${signature}`,
          },
          body,
        });
        await response.body?.cancel();
        if (response.ok) {
          counts.delivered++;
          return;
        }
        if (
          response.status >= 400 &&
          response.status < 500 &&
          ![408, 429].includes(response.status)
        )
          break;
      } catch {
        // Failure details may include destination URLs, so retain only the outcome counter.
      } finally {
        clearTimeout(timeout);
        activeController = undefined;
      }
      if (attempt + 1 < maxAttempts) {
        await sleep(Math.min(retryBaseMs * 2 ** attempt, retryMaxMs));
      }
    }
    counts.failed++;
    try {
      options.onError?.(event.id);
    } catch {
      // Metrics hooks must not stop delivery of later transitions.
    }
  }

  function notifyIdle() {
    if (!running && queue.length === 0) {
      for (const resolve of idleWaiters) resolve();
      idleWaiters = [];
    }
  }

  async function drain() {
    if (running) return;
    running = true;
    try {
      while (queue.length) {
        const event = queue.shift()!;
        await deliver(event);
      }
    } finally {
      running = false;
      notifyIdle();
    }
  }

  return {
    enqueue(event) {
      if (closed || seen.has(event.id)) return false;
      const safe = sanitizeNotificationEvent(event);
      if (!safe) return false;
      if (queue.length + (running ? 1 : 0) >= maxQueue) {
        counts.dropped++;
        return false;
      }
      remember(event.id);
      queue.push(safe);
      queueMicrotask(() => void drain());
      return true;
    },
    stop() {
      if (stopped) return;
      closed = true;
      stopped = true;
      counts.dropped += queue.length + (running ? 1 : 0);
      queue.length = 0;
      activeController?.abort();
      notifyIdle();
    },
    async close() {
      closed = true;
      if (!running && queue.length === 0) return;
      await new Promise<void>((resolve) => idleWaiters.push(resolve));
    },
    get pending() {
      return queue.length + (running ? 1 : 0);
    },
    get stats() {
      return { ...counts, pending: queue.length + (running ? 1 : 0) };
    },
  };
}

/** Read the minimal environment configuration; no webhook means notifications stay disabled. */
export function webhookOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Pick<WebhookOptions, 'url' | 'secret'> | undefined {
  const url = env.TUG_WEBHOOK_URL?.trim();
  const secret = env.TUG_WEBHOOK_SECRET;
  if (!url && !secret) return undefined;
  if (!url || !secret)
    throw new Error('Set both TUG_WEBHOOK_URL and TUG_WEBHOOK_SECRET to enable webhooks');
  validateWebhookUrl(url);
  return { url, secret };
}
