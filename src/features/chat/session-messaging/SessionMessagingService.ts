import type { ProviderSessionToolPort } from '../../../core/execution';
import {
  findProviderModelOption,
  getProviderSettingsSnapshotWithModel,
  resolveConversationModel,
  resolveNewConversationModel,
} from '../../../core/providers/conversationModel';
import { ProviderRegistry } from '../../../core/providers/ProviderRegistry';
import type { ProviderId } from '../../../core/providers/types';
import type {
  SessionToolDestinations,
  SessionToolListDestinationsArgs,
  SessionToolProviderDestination,
  SessionToolReadSessionArgs,
  SessionToolReadSessionResult,
  SessionToolReasoningDestination,
  SessionToolSendMessageArgs,
  SessionToolSendMessageResult,
  SessionToolSessionStatus,
  SessionToolSessionSummary,
} from '../../../core/session-tools/sessionToolSpecs';
import type { Conversation, ConversationMeta } from '../../../core/types';
import { throwIfAborted } from '../../../utils/abort';
import type { FeatureHost } from '../../FeatureHost';
import { formatSessionSnapshot } from './formatSessionSnapshot';
import type { SessionMailbox } from './SessionMailbox';

interface NewSessionChoice {
  readonly providerId: ProviderId;
  readonly model: string;
  /** Explicit choice only; omitted reasoning keeps the new-tab default. */
  readonly reasoning?: string;
}

export interface SessionToolBinding {
  readonly port: ProviderSessionToolPort;
  dispose(): void;
}

export interface SessionMailboxHostRuntime {
  mailbox?: SessionMailbox;
  statusAttention?: { kind: string };
  isWorking?: boolean;
  isIdle?: boolean;
  conversationId?: string | null;
  peekModel?: {
    hydrationState?: string;
    state?: {
      messages: Conversation['messages'];
      isStreaming: boolean;
    };
  } | null;
  reasoningSelections?: Map<string, string>;
}

export interface SessionMailboxHost {
  get(id: string): SessionMailboxHostRuntime | undefined | null;
  ensure(identity: {
    conversationId: string;
    providerId: ProviderId;
    draftModel: string | null;
  }): SessionMailboxHostRuntime;
  awaitConversationCreations?(): Promise<void>;
  getAll?(): unknown[];
  getAttachment?(id: string): unknown;
}

export interface SessionMessagingServiceDeps {
  getHost(): FeatureHost;
  getActiveConversationId(): string | null;
  /** Re-renders open model controls after a session's selection is switched. */
  refreshModelControls(providerId: ProviderId): void;
  commitSelection(
    id: string,
    expectedModel: string | undefined,
    model: string | undefined,
    admission: { isCurrent(candidate: Readonly<Conversation>): boolean; commit(): void },
  ): Promise<boolean>;
  sessionRuntimes?: SessionMailboxHost;
  getMailbox?(conversationId: string): SessionMailbox | null;
}

/** Owns caller-bound tool operations; recipient execution belongs to its session runtime. */
export class SessionMessagingService {
  private readonly shutdown = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();

  constructor(private readonly deps: SessionMessagingServiceDeps) {}

  bindSessionTools(conversationId: string): SessionToolBinding {
    const binding = new AbortController();
    const invoke = <T>(
      signal: AbortSignal,
      operation: (signal: AbortSignal) => Promise<T>,
    ): Promise<T> => {
      const combined = AbortSignal.any([signal, binding.signal, this.shutdown.signal]);
      const pending = Promise.resolve().then(() => {
        throwIfAborted(combined, 'Session tool call was cancelled');
        return operation(combined);
      });
      this.pending.add(pending);
      void pending.finally(() => this.pending.delete(pending)).catch(() => undefined);
      return pending;
    };
    return {
      port: {
        list: (args, signal) =>
          invoke(signal, (current) => this.list(conversationId, args, current)),
        send: (args, signal) =>
          invoke(signal, (current) => this.send(conversationId, args, current)),
        read: (args, signal) => invoke(signal, (current) => this.read(args, current)),
      },
      dispose: () => binding.abort(new Error('The caller session binding was released')),
    };
  }

  beginShutdown(): void {
    this.shutdown.abort(new Error('Session messaging is shutting down'));
  }

  async dispose(): Promise<void> {
    this.beginShutdown();
    while (this.pending.size) {
      await Promise.allSettled([...this.pending]);
    }
  }

  private async resolve(id: string, signal: AbortSignal): Promise<ConversationMeta> {
    const host = this.deps.getHost();
    const ensureMetadata = (host as { ensureConversationMetadataLoaded?: (ids: string[]) => Promise<void> })
      .ensureConversationMetadataLoaded;
    if (typeof ensureMetadata === 'function') {
      await ensureMetadata([id]);
    }
    throwIfAborted(signal, 'Session tool call was cancelled');
    const record = host
      .getConversationList()
      .find((candidate) => candidate.id === id && !candidate.isArchived && !candidate.archived);
    if (!record) throw new Error('The session does not exist or is archived');
    return record;
  }

  private async list(
    callerId: string,
    args: SessionToolListDestinationsArgs,
    signal: AbortSignal,
  ): Promise<SessionToolDestinations> {
    await this.resolve(callerId, signal);
    const host = this.deps.getHost();
    const activeId = this.deps.getActiveConversationId();
    const records = host
      .getConversationList()
      .filter((record) => !record.isArchived && !record.archived)
      .sort((a, b) => (b.lastActivityAt ?? b.updatedAt) - (a.lastActivityAt ?? a.updatedAt));
    const limit = args.limit ?? 50;
    const sessions = records.slice(0, limit).map((record): SessionToolSessionSummary => {
      return {
        sessionId: record.id,
        title: record.title,
        provider: record.providerId,
        status: this.status(record.id),
        active: record.id === activeId,
        ...(record.id === callerId ? { self: true as const } : {}),
      };
    });
    return {
      sessions,
      ...(records.length > limit ? { truncated: true as const } : {}),
      ...(args.includeProviders
        ? { providers: listProviderDestinations(host.getCommittedSettings()) }
        : {}),
    };
  }

  /** Archived sessions and the caller itself are readable: reading changes nothing. */
  private async read(
    args: SessionToolReadSessionArgs,
    signal: AbortSignal,
  ): Promise<SessionToolReadSessionResult> {
    const host = this.deps.getHost();
    const ensureMetadata = (host as { ensureConversationMetadataLoaded?: (ids: string[]) => Promise<void> })
      .ensureConversationMetadataLoaded;
    if (typeof ensureMetadata === 'function') {
      await ensureMetadata([args.sessionId]);
    }
    throwIfAborted(signal, 'Session tool call was cancelled');
    const conversation = await host.getConversationById(args.sessionId);
    throwIfAborted(signal, 'Session tool call was cancelled');
    if (!conversation) throw new Error('The session does not exist');

    const sessionRuntimes = this.getSessionRuntimes();
    const runtime = sessionRuntimes?.get(conversation.id);
    const model = runtime?.conversationId === conversation.id ? runtime.peekModel : null;
    const live = model?.hydrationState === 'ready' ? model.state : null;
    const page = formatSessionSnapshot(
      conversation,
      live?.messages ?? conversation.messages,
      live?.isStreaming ?? false,
      args.beforeTurn !== undefined ? { beforeTurn: args.beforeTurn } : {},
    );
    return {
      sessionId: conversation.id,
      title: conversation.title,
      provider: conversation.providerId,
      status: this.status(conversation.id),
      ...page,
    };
  }

  private getSessionRuntimes(): SessionMailboxHost | undefined {
    return (
      this.deps.sessionRuntimes
      ?? (this.deps.getHost() as { sessionRuntimes?: SessionMailboxHost }).sessionRuntimes
    );
  }

  private status(id: string): SessionToolSessionStatus {
    const sessionRuntimes = this.getSessionRuntimes();
    if (sessionRuntimes) {
      const runtime = sessionRuntimes.get(id);
      return runtime?.statusAttention?.kind === 'action-required'
        ? 'awaiting-user'
        : runtime?.isWorking
          ? 'running'
          : 'idle';
    }

    const host = this.deps.getHost();
    const match = host.findConversationAcrossViews(id);
    if (match) {
      const tab = match.view.getTabManager()?.getTab(match.tabId);
      if (tab?.state.requiresAction) return 'awaiting-user';
      if (tab?.state.isStreaming || tab?.session.activeTurn || tab?.session.hasPendingBackgroundWork) {
        return 'running';
      }
    }
    const poolAttention = host.sessionRuntimePool?.getConversationAttention(id);
    if (poolAttention?.kind === 'review') return 'awaiting-user';
    if (host.sessionRuntimePool?.isConversationRunning(id)) return 'running';

    return 'idle';
  }

  private async send(
    callerId: string,
    args: SessionToolSendMessageArgs,
    signal: AbortSignal,
  ): Promise<SessionToolSendMessageResult> {
    const caller = await this.resolve(callerId, signal);
    const host = this.deps.getHost();
    if (args.sessionId === callerId) throw new Error('A session cannot send a message to itself');
    let target: ConversationMeta;
    let reasoning: string | undefined;

    if (args.sessionId) {
      target = await this.resolve(args.sessionId, signal);
    } else {
      const choice = resolveNewSessionChoice(args, host.getCommittedSettings());
      reasoning = choice.reasoning;
      throwIfAborted(signal, 'Session tool call was cancelled');
      const created = await host.createConversation({
        providerId: choice.providerId,
        selectedModel: choice.model,
      });
      throwIfAborted(signal, 'Session tool call was cancelled');
      target = await this.resolve(created.id, signal);
    }

    const sessionRuntimes = this.getSessionRuntimes();
    if (sessionRuntimes && !sessionRuntimes.get(target.id)) {
      if (sessionRuntimes.awaitConversationCreations) {
        await sessionRuntimes.awaitConversationCreations();
      }
      target = await this.resolve(target.id, signal);
    }

    let model: string | undefined;
    if (args.sessionId) {
      ({ model, reasoning } = resolveSessionSwitch(args, target, host));
    }
    throwIfAborted(signal, 'Session tool call was cancelled');

    const runtime = sessionRuntimes?.ensure({
      conversationId: target.id,
      providerId: target.providerId,
      draftModel: null,
    });
    const mailbox = runtime?.mailbox ?? this.deps.getMailbox?.(target.id);
    if (!mailbox) throw new Error('The target session cannot receive messages');

    const recipient = {
      sessionId: target.id,
      title: target.title,
      provider: target.providerId,
    };
    const message =
      args.text === undefined
        ? null
        : { from: caller.title, sessionId: caller.id, text: args.text };

    if (model === undefined && reasoning === undefined) {
      return { ...recipient, status: await mailbox.deliver({ message, mode: args.mode, signal }) };
    }

    const resultingModel =
      model
      ?? resolveConversationModel(host.getCommittedSettings(), target.providerId, target).model;
    const selection =
      reasoning === undefined
        ? null
        : prepareSessionReasoningSelection(
            runtime ?? { reasoningSelections: new Map<string, string>() },
            target.providerId,
            resultingModel,
            reasoning,
          );

    const status = await mailbox.deliver({
      message,
      mode: args.mode,
      signal,
      commitSwitch: async (admission) => {
        const committed = await this.deps.commitSelection(
          target.id,
          target.selectedModel,
          model,
          {
            isCurrent: (candidate) => {
              if (!admission.isCurrent || signal.aborted || (selection && !selection.isCurrent())) {
                return false;
              }
              const settings = host.getCommittedSettings();
              const actualModel = resolveConversationModel(
                settings,
                candidate.providerId,
                candidate,
              ).model;
              if (actualModel !== resultingModel) return false;
              if (
                model !== undefined
                && findProviderModelOption(candidate.providerId, model, settings) !== model
              ) {
                return false;
              }
              if (reasoning !== undefined) {
                validateReasoning(candidate.providerId, actualModel, reasoning, settings);
              }
              return true;
            },
            commit: () => {
              admission.commit();
              selection?.commit();
            },
          },
        );
        if (!committed) {
          throw new Error('The session or its selection changed before message admission');
        }
      },
    });

    if (args.sessionId) {
      try {
        this.deps.refreshModelControls(target.providerId);
      } catch {
        /* Admission already committed. */
      }
    }
    return { ...recipient, status };
  }
}

/** The reasoning a new session with this model would carry; null when the model has no reasoning control. */
export function resolveReasoningDestination(
  providerId: ProviderId,
  model: string,
  settings: Record<string, unknown>,
): SessionToolReasoningDestination | null {
  if (ProviderRegistry.getCapabilities(providerId).reasoningControl === 'none') return null;
  const snapshot = getProviderSettingsSnapshotWithModel(settings, providerId, model);
  const reasoning =
    (snapshot as { effortLevel?: string; thinkingBudget?: string }).effortLevel
    ?? (snapshot as { effortLevel?: string; thinkingBudget?: string }).thinkingBudget
    ?? null;
  if (reasoning === null) return null;
  const uiConfig = ProviderRegistry.getChatUIConfig(providerId);
  const options = uiConfig.getReasoningOptions(model, snapshot).map((option) => option.value);
  if (options.length === 0) return null;
  return {
    options,
    default: options.includes(reasoning)
      ? reasoning
      : uiConfig.getDefaultReasoningValue(model, snapshot),
  };
}

export function listProviderDestinations(
  settings: Record<string, unknown>,
): SessionToolProviderDestination[] {
  const defaults = resolveNewConversationModel(settings);
  return ProviderRegistry.getEnabledProviderIds(settings).map((providerId) => {
    const defaultModel = providerId === defaults?.providerId ? defaults.model : null;
    const models = ProviderRegistry.getChatUIConfig(providerId)
      .getModelOptions(settings)
      .map((option) => {
        const reasoning = resolveReasoningDestination(providerId, option.value, settings);
        return {
          id: option.value,
          ...(option.value === defaultModel ? { default: true as const } : {}),
          ...(reasoning ? { reasoning } : {}),
        };
      });
    return {
      provider: providerId,
      ...(providerId === defaults?.providerId ? { default: true as const } : {}),
      models,
    };
  });
}

/** Omitted values follow the new-tab policy; explicit values are validated and never substituted. */
export function resolveNewSessionChoice(
  args: SessionToolSendMessageArgs,
  settings: Record<string, unknown>,
): NewSessionChoice {
  const defaults = resolveNewConversationModel(settings);
  const enabled = ProviderRegistry.getEnabledProviderIds(settings);
  const providerId = args.provider ?? defaults?.providerId;
  if (!providerId || !enabled.includes(providerId)) {
    throw new Error(
      args.provider
        ? `Unknown or disabled provider "${args.provider}". Available: ${formatOptions(enabled)}`
        : 'No provider is available for a new session',
    );
  }
  let model: string | null;
  if (args.model) {
    model = findProviderModelOption(providerId, args.model, settings);
    if (!model) {
      const options = ProviderRegistry.getChatUIConfig(providerId)
        .getModelOptions(settings)
        .map((option) => option.value);
      throw new Error(
        `Unknown model "${args.model}" for ${providerId}. Available: ${formatOptions(options)}`,
      );
    }
  } else {
    model = defaults?.model ?? null;
    if (!model) throw new Error(`No model is available for ${providerId}`);
  }
  if (args.reasoning !== undefined) validateReasoning(providerId, model, args.reasoning, settings);
  return {
    providerId,
    model,
    ...(args.reasoning !== undefined ? { reasoning: args.reasoning } : {}),
  };
}

/**
 * An existing session's switch, validated against its own provider and resulting model.
 * Model is omitted when it would not change; omitted reasoning keeps the session's selection.
 */
export function resolveSessionSwitch(
  args: SessionToolSendMessageArgs,
  target: ConversationMeta,
  host: FeatureHost,
): { model?: string; reasoning?: string } {
  if (args.model === undefined && args.reasoning === undefined) return {};
  const settings = host.getCommittedSettings();
  const providerId = target.providerId;
  const currentSummary =
    (host as { getConversationSummary?: (id: string) => ConversationMeta | null }).getConversationSummary?.(target.id)
    ?? target;
  const current = resolveConversationModel(settings, providerId, currentSummary).model;
  let model = current;
  if (args.model !== undefined) {
    const selected = findProviderModelOption(providerId, args.model, settings);
    if (!selected) {
      const options = ProviderRegistry.getChatUIConfig(providerId)
        .getModelOptions(settings)
        .map((option) => option.value);
      throw new Error(
        `Unknown model "${args.model}" for ${providerId}. Available: ${formatOptions(options)}`,
      );
    }
    model = selected;
  }
  if (args.reasoning !== undefined) validateReasoning(providerId, model, args.reasoning, settings);
  return {
    ...(model !== current ? { model } : {}),
    ...(args.reasoning !== undefined ? { reasoning: args.reasoning } : {}),
  };
}

export function validateReasoning(
  providerId: ProviderId,
  model: string,
  value: string,
  settings: Record<string, unknown>,
): void {
  const reasoning = resolveReasoningDestination(providerId, model, settings);
  if (!reasoning) throw new Error(`Model ${model} for ${providerId} has no reasoning control.`);
  if (!reasoning.options.includes(value)) {
    throw new Error(
      `Unknown reasoning "${value}" for ${providerId} model ${model}. Available: ${formatOptions(
        reasoning.options,
      )}`,
    );
  }
}

export function prepareSessionReasoningSelection(
  tab: { reasoningSelections?: Map<string, string> },
  providerId: string,
  model: string,
  reasoning: string,
): { isCurrent(): boolean; commit(): void } {
  const key = `${providerId}:${model}`;
  const selections = tab.reasoningSelections ?? new Map<string, string>();
  const previous = selections.get(key);
  return {
    isCurrent: () => selections.get(key) === previous,
    commit: () => {
      selections.set(key, reasoning);
    },
  };
}

function formatOptions(options: readonly string[]): string {
  return options.length > 0 ? options.join(', ') : 'none';
}
