import type { ProviderId } from '../../../core/providers/types';
import { RuntimeSupervisor } from './RuntimeSupervisor';
import type { TabLifecycleState } from './types';

export interface TabSessionState {
  conversationId: string | null;
  draftModel: string | null;
  id: string;
  lifecycleState: TabLifecycleState;
  providerId: ProviderId;
}

export class TabSession {
  /** Per-tab reasoning overrides survive activation/cooling, but reset on disposal. */
  readonly reasoningSelections = new Map<string, string>();
  readonly runtimeSupervisor = new RuntimeSupervisor();
  private currentActiveTurn: Promise<void> | null = null;
  private backgroundWork: Promise<void> = Promise.resolve();
  private backgroundWorkPauseDepth = 0;
  private pendingBackgroundWorkCount = 0;
  private readonly workStateListeners = new Set<() => void>();

  constructor(private readonly state: TabSessionState) {}

  get id(): string { return this.state.id; }
  set id(value: string) { this.state.id = value; }
  get lifecycleState(): TabLifecycleState { return this.state.lifecycleState; }
  set lifecycleState(value: TabLifecycleState) { this.state.lifecycleState = value; }
  get providerId(): ProviderId { return this.state.providerId; }
  set providerId(value: ProviderId) { this.state.providerId = value; }
  get conversationId(): string | null { return this.state.conversationId; }
  set conversationId(value: string | null) { this.state.conversationId = value; }
  get draftModel(): string | null { return this.state.draftModel; }
  set draftModel(value: string | null) { this.state.draftModel = value; }

  get activeTurn(): Promise<void> | null { return this.currentActiveTurn; }
  set activeTurn(value: Promise<void> | null) {
    if (this.currentActiveTurn === value) return;
    this.currentActiveTurn = value;
    this.notifyWorkStateChanged();
  }

  get hasPendingBackgroundWork(): boolean {
    return this.pendingBackgroundWorkCount > 0;
  }

  subscribeToWorkState(listener: () => void): () => void {
    this.workStateListeners.add(listener);
    return () => this.workStateListeners.delete(listener);
  }

  notifyWorkStateChanged(): void {
    for (const listener of this.workStateListeners) listener();
  }

  enqueueBackgroundWork(work: () => Promise<void>): Promise<void> | null {
    if (this.backgroundWorkPauseDepth > 0) return null;

    this.pendingBackgroundWorkCount++;
    this.notifyWorkStateChanged();
    const pending = this.backgroundWork
      .catch(() => undefined)
      .then(work);
    this.backgroundWork = pending;
    void pending.then(
      () => this.finishBackgroundWork(),
      () => this.finishBackgroundWork(),
    );
    return pending;
  }

  async awaitBackgroundWork(): Promise<void> {
    await this.backgroundWork.catch(() => undefined);
  }

  pauseBackgroundWork(): void {
    this.backgroundWorkPauseDepth++;
  }

  resumeBackgroundWork(): void {
    this.backgroundWorkPauseDepth = Math.max(0, this.backgroundWorkPauseDepth - 1);
  }

  private finishBackgroundWork(): void {
    this.pendingBackgroundWorkCount = Math.max(0, this.pendingBackgroundWorkCount - 1);
    this.notifyWorkStateChanged();
  }
}
