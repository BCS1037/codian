import { createHash } from 'node:crypto';

import type { ProviderHost } from '../../../core/providers/ProviderHost';
import type {
  OpencodeHttpClientConnection,
  OpencodeHttpEvent,
  OpencodeHttpRequestOptions,
} from './OpencodeHttpClient';
import { OpencodeHttpClient } from './OpencodeHttpClient';

interface PoolEntry {
  readonly key: string;
  readonly client: OpencodeHttpClientConnection;
  readonly leases: Set<OpencodeHttpClientLease>;
  readonly subscribers: Set<OpencodeHttpClientLease>;
  globalFormOwner: OpencodeHttpClientLease | null;
}

export type OpencodeHttpClientFactory = (
  command: string,
  cwd: string,
  environment: NodeJS.ProcessEnv,
) => OpencodeHttpClientConnection;

/** Shares one native server among active sessions with identical launch inputs. */
export class OpencodeHttpClientPool {
  private readonly entries = new Map<string, PoolEntry>();

  constructor(
    private readonly createClient: OpencodeHttpClientFactory = (
      command,
      cwd,
      environment,
    ) => new OpencodeHttpClient(command, cwd, environment),
  ) {}

  acquire(
    command: string,
    cwd: string,
    environment: NodeJS.ProcessEnv,
    launchKey: string,
  ): OpencodeHttpClientLease {
    const key = getLaunchFingerprint(command, cwd, environment, launchKey);
    let entry = this.entries.get(key);
    if (entry?.client.isClosed) {
      this.entries.delete(key);
      void entry.client.dispose().catch(() => undefined);
      entry = undefined;
    }
    if (!entry) {
      entry = {
        key,
        client: this.createClient(command, cwd, environment),
        leases: new Set(),
        subscribers: new Set(),
        globalFormOwner: null,
      };
      this.entries.set(key, entry);
    }

    const lease = new OpencodeHttpClientLease(entry, this);
    entry.leases.add(lease);
    return lease;
  }

  async release(entry: PoolEntry, lease: OpencodeHttpClientLease): Promise<void> {
    entry.leases.delete(lease);
    this.removeSubscriber(entry, lease);
    if (entry.leases.size > 0 || this.entries.get(entry.key) !== entry) return;

    this.entries.delete(entry.key);
    await entry.client.dispose();
  }

  subscribe(
    entry: PoolEntry,
    lease: OpencodeHttpClientLease,
    onEvent: (event: OpencodeHttpEvent) => void,
    onError: (error: Error) => void,
    signal: AbortSignal,
  ): Promise<void> {
    entry.subscribers.add(lease);
    entry.globalFormOwner ??= lease;
    return entry.client.subscribe(
      (event) => {
        if (lease.isClosed) return;
        if (isGlobalFormEvent(event) && entry.globalFormOwner !== lease) return;
        onEvent(event);
      },
      (error) => {
        this.removeSubscriber(entry, lease);
        onError(error);
      },
      signal,
    ).catch((error: unknown) => {
      this.removeSubscriber(entry, lease);
      throw error;
    });
  }

  private removeSubscriber(entry: PoolEntry, lease: OpencodeHttpClientLease): void {
    entry.subscribers.delete(lease);
    if (entry.globalFormOwner !== lease) return;
    entry.globalFormOwner = [...entry.subscribers].find(candidate => !candidate.isClosed) ?? null;
  }
}

/** Per-runtime view of a pooled process; disposing it never closes peer leases. */
export class OpencodeHttpClientLease implements OpencodeHttpClientConnection {
  private readonly controller = new AbortController();
  private disposed = false;
  private disposal: Promise<void> | null = null;

  constructor(
    private readonly entry: PoolEntry,
    private readonly pool: OpencodeHttpClientPool,
  ) {}

  get isAlive(): boolean {
    return !this.disposed && !this.entry.client.isClosed && this.entry.client.isAlive;
  }

  get isClosed(): boolean {
    return this.disposed || this.entry.client.isClosed;
  }

  signal(signal?: AbortSignal): AbortSignal {
    const leaseSignal = signal
      ? AbortSignal.any([this.controller.signal, signal])
      : this.controller.signal;
    return this.entry.client.signal(leaseSignal);
  }

  request<T = unknown>(route: string, options: OpencodeHttpRequestOptions = {}): Promise<T> {
    return this.entry.client.request<T>(route, {
      ...options,
      signal: this.signal(options.signal),
    });
  }

  subscribe(
    onEvent: (event: OpencodeHttpEvent) => void,
    onError: (error: Error) => void,
  ): Promise<void> {
    return this.pool.subscribe(
      this.entry,
      this,
      onEvent,
      onError,
      this.controller.signal,
    );
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    this.controller.abort();
    this.disposal = this.pool.release(this.entry, this);
    return this.disposal;
  }
}

const providerPools = new WeakMap<ProviderHost, OpencodeHttpClientPool>();

/** Provider-local pool lifetime follows its host; runtime leases own process cleanup. */
export function getOpencodeHttpClientPool(plugin: ProviderHost): OpencodeHttpClientPool {
  let pool = providerPools.get(plugin);
  if (!pool) {
    pool = new OpencodeHttpClientPool();
    providerPools.set(plugin, pool);
  }
  return pool;
}

function getLaunchFingerprint(
  command: string,
  cwd: string,
  environment: NodeJS.ProcessEnv,
  launchKey: string,
): string {
  const normalizedEnvironment = Object.entries(environment)
    .sort(([left], [right]) => left.localeCompare(right));
  return createHash('sha256')
    .update(JSON.stringify([command, cwd, launchKey, normalizedEnvironment]))
    .digest('hex');
}

function isGlobalFormEvent(event: OpencodeHttpEvent): boolean {
  if (event.type !== 'form.created') return false;
  const form = isRecord(event.data.form) ? event.data.form : undefined;
  return (typeof form?.sessionID === 'string' ? form.sessionID : event.data.sessionID) === 'global';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
