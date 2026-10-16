import type { TabAttention } from '../state/types';
import type { TabData } from './types';

type SessionDisposer = (tab: TabData) => Promise<void>;

interface DetachedSessionEntry {
  tab: TabData;
  unsubscribe: () => void;
  retireWhenSettled: boolean;
  disposal: Promise<void> | null;
}

/** Owns detached chat executions until work settles or the plugin shuts down. */
export class SessionRuntimePool {
  private readonly detached = new Map<string, DetachedSessionEntry>();
  private readonly pendingDisposals = new Map<string, Promise<void>>();
  private readonly retireOnDetach = new WeakSet<TabData>();
  private readonly conversationAttention = new Map<string, Exclude<TabAttention, null>>();
  private shuttingDown = false;

  constructor(private readonly disposeSession: SessionDisposer) {}

  get size(): number {
    return this.detached.size;
  }

  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  /** Returns runtime-only attention; undefined means this conversation has no pool record. */
  getConversationAttention(conversationId: string): TabAttention | undefined {
    return this.conversationAttention.get(conversationId);
  }

  /** Mirrors attention for conversations that have no attached tab yet. */
  setConversationAttention(conversationId: string, attention: TabAttention): void {
    if (attention === null) {
      this.conversationAttention.delete(conversationId);
      return;
    }

    const hadRecord = this.conversationAttention.has(conversationId);
    const previous = this.conversationAttention.get(conversationId);
    if (hadRecord && sameAttention(previous ?? null, attention)) return;

    this.conversationAttention.set(conversationId, attention);
  }

  detach(tab: TabData): boolean {
    if (this.shuttingDown || !hasActiveSessionWork(tab)) return false;
    if (this.retireOnDetach.has(tab)) {
      void this.retire(tab).catch(() => undefined);
      return true;
    }
    const sessionId = tab.session.id;
    const existing = this.detached.get(sessionId);
    if (existing) return existing.tab === tab && !existing.retireWhenSettled;

    const entry: DetachedSessionEntry = {
      tab,
      unsubscribe: () => {},
      retireWhenSettled: false,
      disposal: null,
    };
    entry.unsubscribe = tab.session.subscribeToWorkState(() => {
      this.collectIfSettled(entry);
    });
    this.detached.set(sessionId, entry);
    return true;
  }

  markForRetirementOnDetach(tab: TabData): void {
    this.retireOnDetach.add(tab);
  }

  clearRetirementMark(tab: TabData): void {
    this.retireOnDetach.delete(tab);
  }

  takeByConversation(conversationId: string): TabData | null {
    for (const entry of this.detached.values()) {
      if (entry.retireWhenSettled || entry.tab.conversationId !== conversationId) continue;
      this.removeEntry(entry);
      return entry.tab;
    }
    return null;
  }

  hasConversation(conversationId: string): boolean {
    return Array.from(this.detached.values()).some(entry => (
      !entry.retireWhenSettled && entry.tab.conversationId === conversationId
    ));
  }

  retireConversation(conversationId: string): void {
    this.conversationAttention.delete(conversationId);
    const entries = Array.from(this.detached.values()).filter(entry => (
      entry.tab.conversationId === conversationId
    ));
    for (const entry of entries) void this.retire(entry.tab).catch(() => undefined);
  }

  isConversationRunning(conversationId: string): boolean {
    return Array.from(this.detached.values()).some(entry => (
      !entry.retireWhenSettled
      && entry.tab.conversationId === conversationId
      && hasActiveSessionWork(entry.tab)
    ));
  }

  /** Retires a deleted session after current work returns, without blocking that work. */
  retire(tab: TabData): Promise<void> {
    const sessionId = tab.session.id;
    let entry = this.detached.get(sessionId);
    if (!entry) {
      entry = {
        tab,
        unsubscribe: () => {},
        retireWhenSettled: true,
        disposal: null,
      };
      entry.unsubscribe = tab.session.subscribeToWorkState(() => {
        this.collectIfSettled(entry!);
      });
      this.detached.set(sessionId, entry);
    } else {
      entry.retireWhenSettled = true;
    }

    this.collectIfSettled(entry);
    return this.whenDisposed(sessionId);
  }

  whenDisposed(sessionId: string): Promise<void> {
    const pending = this.pendingDisposals.get(sessionId);
    if (pending) return pending;
    const entry = this.detached.get(sessionId);
    if (!entry) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      const sessionWaiters = this.waiters.get(sessionId) ?? [];
      sessionWaiters.push({ resolve, reject });
      this.waiters.set(sessionId, sessionWaiters);
    });
  }

  beginShutdown(): void {
    this.shuttingDown = true;
  }

  async dispose(): Promise<void> {
    this.beginShutdown();
    const entries = Array.from(this.detached.values());
    const disposals = [
      ...entries.map(entry => this.disposeEntry(entry)),
      ...this.pendingDisposals.values(),
    ];
    await Promise.all(disposals);
    this.conversationAttention.clear();
  }

  private readonly waiters = new Map<string, Array<{
    resolve: () => void;
    reject: (error: unknown) => void;
  }>>();

  private collectIfSettled(entry: DetachedSessionEntry): void {
    if (hasActiveSessionWork(entry.tab)) return;
    void this.disposeEntry(entry).catch(() => undefined);
  }

  private disposeEntry(entry: DetachedSessionEntry): Promise<void> {
    if (entry.disposal) return entry.disposal;
    this.removeEntry(entry);
    const sessionId = entry.tab.session.id;
    const disposal = Promise.resolve().then(() => this.disposeSession(entry.tab));
    entry.disposal = disposal;
    this.pendingDisposals.set(sessionId, disposal);
    void disposal.then(
      () => this.finishDisposal(sessionId),
      error => this.finishDisposal(sessionId, error),
    );
    return disposal;
  }

  private removeEntry(entry: DetachedSessionEntry): void {
    entry.unsubscribe();
    if (this.detached.get(entry.tab.session.id) === entry) {
      this.detached.delete(entry.tab.session.id);
    }
  }

  private finishDisposal(sessionId: string, error?: unknown): void {
    this.pendingDisposals.delete(sessionId);
    const sessionWaiters = this.waiters.get(sessionId);
    if (!sessionWaiters) return;
    this.waiters.delete(sessionId);
    for (const waiter of sessionWaiters) {
      if (error === undefined) waiter.resolve();
      else waiter.reject(error);
    }
  }
}

function sameAttention(left: TabAttention, right: TabAttention): boolean {
  return left === right || (
    left !== null
    && right !== null
    && left.kind === right.kind
    && left.since === right.since
    && (left.kind !== 'review'
      || (right.kind === 'review' && left.outcome === right.outcome))
  );
}

export function hasActiveSessionWork(tab: TabData): boolean {
  return Boolean(
    tab.session?.activeTurn
    || tab.session?.hasPendingBackgroundWork
    || tab.state?.isStreaming
    || tab.state?.isRewinding
    || tab.state?.isCreatingConversation
    || tab.state?.isSwitchingConversation
    || tab.state?.queuedMessage
    || tab.state?.requiresAction
    || tab.services?.subagentManager?.hasActiveWork
  );
}
