import { Menu, Notice, setIcon } from 'obsidian';

import type { TitleGenerationService } from '../../../core/providers/types';
import type { ChatRuntime } from '../../../core/runtime/ChatRuntime';
import type { ChatRewindConflict, ChatRewindMode } from '../../../core/runtime/types';
import { type ChatMessage, type Conversation } from '../../../core/types';
import { t } from '../../../i18n/i18n';
import { confirm } from '../../../shared/modals/ConfirmModal';
import { getUserDisplayText } from '../../../utils/context';
import type { FeatureHost } from '../../FeatureHost';
import type {
  ConversationBrowserEnhancement,
  ConversationBrowserListPresentation,
  ConversationBrowserSession,
} from '../conversation-browser/types';
import type { MessageRenderer } from '../rendering/MessageRenderer';
import { cleanupThinkingBlock } from '../rendering/ThinkingBlockRenderer';
import { findRewindContext } from '../rewind';
import type { SubagentManager } from '../services/SubagentManager';
import type { ChatState } from '../state/ChatState';
import type { TabAttention } from '../state/types';
import type { FileContextManager } from '../ui/FileContext';
import type { ImageContextManager } from '../ui/ImageContext';
import type { ExternalContextSelector, McpServerSelector } from '../ui/InputToolbar';
import type { StatusPanel } from '../ui/StatusPanel';
import { renderWelcomeContent } from '../ui/WelcomeOrb';

function runConversationAction(action: () => Promise<void>, failureMessage: string): void {
  void action().catch(() => {
    new Notice(failureMessage);
  });
}

const DEFAULT_HISTORY_PAGE_SIZE = 100;
const MAX_REWIND_CONFLICT_PATHS = 5;

function buildRewindConflictConfirmation(conflicts: ChatRewindConflict[]): string {
  const visiblePaths = conflicts
    .slice(0, MAX_REWIND_CONFLICT_PATHS)
    .map(conflict => `- ${conflict.path}`);
  const omitted = conflicts.length - visiblePaths.length;
  if (omitted > 0) visiblePaths.push(`- +${omitted} more`);
  return t('chat.rewind.confirmMessageConflicts', {
    count: conflicts.length,
    files: visiblePaths.join('\n'),
  });
}

export interface ConversationCallbacks {
  onNewConversation?: () => void;
  onConversationLoaded?: () => void;
  onConversationSwitched?: () => void;
}

export interface ConversationControllerDeps {
  plugin: FeatureHost;
  state: ChatState;
  renderer: MessageRenderer;
  subagentManager: SubagentManager;
  getHistoryDropdown: () => HTMLElement | null;
  getWelcomeEl: () => HTMLElement | null;
  setWelcomeEl: (el: HTMLElement | null) => void;
  getMessagesEl: () => HTMLElement;
  getInputEl: () => HTMLTextAreaElement;
  restoreMessageToComposer?: (message: Pick<ChatMessage, 'content' | 'images'>) => void;
  getFileContextManager: () => FileContextManager | null;
  getImageContextManager: () => ImageContextManager | null;
  getMcpServerSelector: () => McpServerSelector | null;
  getExternalContextSelector: () => ExternalContextSelector | null;
  clearQueuedMessage: () => void;
  getTitleGenerationService: () => TitleGenerationService | null;
  getStatusPanel: () => StatusPanel | null;
  getAgentService?: () => ChatRuntime | null;
  ensureServiceInitialized?: () => Promise<boolean>;
  getSelectedModel?: () => string | null;
  ensureServiceForConversation?: (conversation: Conversation | null) => Promise<void>;
  dismissPendingInlinePrompts?: () => void;
  isVisible?: () => boolean;
  conversationBrowserEnhancement?: ConversationBrowserEnhancement | null;
  onConversationReset?: () => void;
  awaitBackgroundWork?: () => Promise<void>;
  /** True once the owning tab has begun teardown. */
  isDisposed?: () => boolean;
}

type SaveOptions = {
  resumeAtMessageId?: string;
  resetProviderSession?: boolean;
};

export type HistoryConversationOpenState = 'closed' | 'open' | 'current';

export type HistoryConversationStatus = {
  openState: HistoryConversationOpenState;
  isRunning: boolean;
  attention?: TabAttention;
  location?: 'current-view' | 'other-view';
  tabIndex?: number;
};

type HistoryStatusIndicator = 'action-required' | 'running' | 'error' | 'unread';

function historyStatusIndicator(status: HistoryConversationStatus): HistoryStatusIndicator | null {
  if (status.attention?.kind === 'action-required') return 'action-required';
  if (status.isRunning) return 'running';
  if (status.attention?.kind === 'review') {
    return status.attention.outcome === 'error' ? 'error' : 'unread';
  }
  return null;
}

type HistoryRenderOptions = {
  onSelectConversation: (id: string) => Promise<void>;
  onOpenConversationInNewTab?: (id: string, activate?: boolean) => Promise<void>;
  onCloseConversationTab?: (id: string) => void | Promise<void>;
  getConversationOpenState?: (id: string) => HistoryConversationOpenState;
  getConversationStatus?: (id: string) => HistoryConversationStatus;
  onRerender: () => void;
  signal?: AbortSignal;
  pageSize?: number;
  visibleCount?: number;
};

type HistoryConversationFilter = 'active' | 'archived' | 'all';

export class ConversationController {
  private deps: ConversationControllerDeps;
  private callbacks: ConversationCallbacks;
  private conversationBrowserSession: ConversationBrowserSession | null;
  private historyFilter: HistoryConversationFilter = 'active';
  private activeInlineRename: {
    cancel: () => void;
    input: HTMLInputElement;
  } | null = null;

  constructor(deps: ConversationControllerDeps, callbacks: ConversationCallbacks = {}) {
    this.deps = deps;
    this.callbacks = callbacks;
    this.conversationBrowserSession = deps.conversationBrowserEnhancement?.createSession() ?? null;
  }

  private getAgentService(): ChatRuntime | null {
    return this.deps.getAgentService?.() ?? null;
  }

  get visibleMessages(): readonly ChatMessage[] {
    return this.deps.state.messages;
  }

  // ============================================
  // Conversation Lifecycle
  // ============================================

  /**
   * Resets to entry point state (New Chat).
   *
   * Entry point is a blank UI state - no conversation is created until the
   * first message is sent. This prevents empty conversations cluttering history.
   */
  async createNew(options: { force?: boolean; skipSave?: boolean } = {}): Promise<void> {
    const { plugin, state, subagentManager } = this.deps;
    const force = !!options.force;
    if (state.isStreaming && !force) return;
    if (state.isRewinding) return;
    if (state.isCreatingConversation) return;
    if (state.isSwitchingConversation) return;

    // Set flag to block message sending during reset
    state.isCreatingConversation = true;

    try {
      this.deps.dismissPendingInlinePrompts?.();

      if (force && state.isStreaming) {
        state.cancelRequested = true;
        state.bumpStreamGeneration();
        this.getAgentService()?.cancel();
      }

      if (this.deps.awaitBackgroundWork) {
        await this.deps.awaitBackgroundWork();
      }

      subagentManager.orphanAllActive();

      // Persist terminalized background tasks before clearing their runtime state.
      if (!options.skipSave && state.currentConversationId && state.messages.length > 0) {
        await this.save();
      }

      subagentManager.clear();

      // Clear streaming state and related DOM references
      cleanupThinkingBlock(state.currentThinkingState);
      state.currentContentEl = null;
      state.currentTextEl = null;
      state.currentTextContent = '';
      state.currentThinkingState = null;
      state.toolCallElements.clear();
      state.writeEditStates.clear();
      state.isStreaming = false;

      // Reset to entry point state - no conversation created yet
      state.currentConversationId = null;
      state.clearAttention();
      state.clearMessages();
      state.usage = null;
      state.currentTodos = null;
      state.pendingNewSessionPlan = null;
      state.planFilePath = null;
      state.prePlanPermissionMode = null;
      state.autoScrollEnabled = plugin.settings.enableAutoScroll ?? true;
      state.hasPendingConversationSave = false;

      // Reset agent service session (no session ID for entry point)
      // Pass persistent paths to prevent stale external contexts
      this.getAgentService()?.syncConversationState(
        null,
        plugin.settings.persistentExternalContextPaths || []
      );

      const messagesEl = this.deps.getMessagesEl();
      messagesEl.empty();

      // Recreate welcome element first (before StatusPanel for consistent ordering)
      const welcomeEl = messagesEl.createDiv({ cls: 'codian-welcome' });
      renderWelcomeContent(welcomeEl, this.getGreeting());
      this.deps.setWelcomeEl(welcomeEl);

      // Remount StatusPanel to restore state for new conversation
      this.deps.getStatusPanel()?.remount();

      this.deps.getInputEl().value = '';
      this.deps.onConversationReset?.();

      const fileCtx = this.deps.getFileContextManager();
      fileCtx?.resetForNewConversation();
      fileCtx?.autoAttachActiveFile();

      this.deps.getImageContextManager()?.clearImages();
      this.deps.getMcpServerSelector()?.clearEnabled();
      // Pass current settings to ensure we have the most up-to-date persistent paths
      this.deps.getExternalContextSelector()?.clearExternalContexts(
        plugin.settings.persistentExternalContextPaths || []
      );
      this.deps.clearQueuedMessage();

      this.callbacks.onNewConversation?.();
    } finally {
      state.isCreatingConversation = false;
    }
  }

  /**
   * Loads the current tab conversation, or starts at entry point if none.
   *
   * Entry point (no conversation) shows welcome screen without
   * creating a conversation. Conversation is created lazily on first message.
   */
  async loadActive(): Promise<void> {
    const { plugin, state, renderer } = this.deps;

    const conversationId = state.currentConversationId;
    const conversation = conversationId ? await plugin.getConversationById(conversationId) : null;

    // No active conversation - start at entry point
    if (!conversation) {
      state.currentConversationId = null;
      state.clearAttention();
      state.clearMessages();
      state.usage = null;
      state.currentTodos = null;
      state.pendingNewSessionPlan = null;
      state.planFilePath = null;
      state.prePlanPermissionMode = null;
      state.autoScrollEnabled = plugin.settings.enableAutoScroll ?? true;
      state.hasPendingConversationSave = false;

      // Pass persistent paths to prevent stale external contexts
      this.getAgentService()?.syncConversationState(
        null,
        plugin.settings.persistentExternalContextPaths || []
      );

      const fileCtx = this.deps.getFileContextManager();
      fileCtx?.resetForNewConversation();
      fileCtx?.autoAttachActiveFile();

      // Initialize external contexts with persistent paths from settings
      this.deps.getExternalContextSelector()?.clearExternalContexts(
        plugin.settings.persistentExternalContextPaths || []
      );

      this.deps.getMcpServerSelector()?.clearEnabled();

      const welcomeEl = renderer.renderMessages(
        [],
        () => this.getGreeting()
      );
      this.deps.setWelcomeEl(welcomeEl);
      this.updateWelcomeVisibility();

      this.callbacks.onConversationLoaded?.();
      return;
    }

    await this.deps.ensureServiceForConversation?.(conversation);
    this.restoreConversation(conversation, { autoAttachFile: true });
    this.updateWelcomeVisibility();

    this.callbacks.onConversationLoaded?.();
  }

  /** Switches to a different conversation. */
  async switchTo(id: string): Promise<void> {
    const { plugin, state, subagentManager } = this.deps;

    if (this.deps.isDisposed?.()) return;
    if (id === state.currentConversationId) return;
    if (state.isStreaming) return;
    if (state.isRewinding) return;
    if (state.isSwitchingConversation) return;
    if (state.isCreatingConversation) return;

    state.isSwitchingConversation = true;

    try {
      this.deps.dismissPendingInlinePrompts?.();
      if (this.deps.awaitBackgroundWork) {
        await this.deps.awaitBackgroundWork();
      }
      if (this.deps.isDisposed?.()) return;
      subagentManager.orphanAllActive();
      await this.save();
      if (this.deps.isDisposed?.()) return;

      subagentManager.clear();

      const conversation = await plugin.switchConversation(id);
      if (!conversation || this.deps.isDisposed?.()) {
        return;
      }

      await this.deps.ensureServiceForConversation?.(conversation);
      if (this.deps.isDisposed?.()) return;

      this.deps.getInputEl().value = '';
      this.deps.onConversationReset?.();
      this.deps.clearQueuedMessage();

      this.restoreConversation(conversation);

      this.deps.getHistoryDropdown()?.removeClass('visible');
      this.updateWelcomeVisibility();

      this.callbacks.onConversationSwitched?.();
    } finally {
      state.isSwitchingConversation = false;
    }
  }

  async rewind(
    userMessageId: string,
    mode: ChatRewindMode = 'code-and-conversation',
  ): Promise<void> {
    const { plugin, state, renderer } = this.deps;

    if (state.isRewinding) {
      new Notice(t('chat.rewind.inProgress'));
      return;
    }
    if (state.isStreaming) {
      new Notice(t('chat.rewind.unavailableStreaming'));
      return;
    }

    const msgs = state.messages;
    const userIdx = msgs.findIndex(m => m.id === userMessageId);
    if (userIdx === -1) {
      new Notice(t('chat.rewind.failed', { error: 'Message not found' }));
      return;
    }
    const userMsg = msgs[userIdx];
    if (!userMsg.userMessageId) {
      new Notice(t('chat.rewind.unavailableNoUuid'));
      return;
    }

    const rewindCtx = findRewindContext(msgs, userIdx);
    if (!rewindCtx.hasResponse) {
      new Notice(t('chat.rewind.unavailableNoUuid'));
      return;
    }
    const prevAssistantUuid = rewindCtx.prevAssistantUuid;

    const conversationId = state.currentConversationId;
    const isTargetCurrent = (): boolean => {
      if (state.currentConversationId !== conversationId) return false;
      const currentMessages = state.messages;
      const currentUserIdx = currentMessages.findIndex(message => message.id === userMessageId);
      if (currentUserIdx < 0) return false;
      const currentUser = currentMessages[currentUserIdx];
      if (currentUser.userMessageId !== userMsg.userMessageId) return false;
      const currentContext = findRewindContext(currentMessages, currentUserIdx);
      return currentContext.hasResponse
        && currentContext.prevAssistantUuid === prevAssistantUuid;
    };

    state.isRewinding = true;
    try {
      if (this.deps.ensureServiceInitialized) {
        let initialized = false;
        try {
          initialized = await this.deps.ensureServiceInitialized();
        } catch (e) {
          new Notice(t('chat.rewind.failed', {
            error: e instanceof Error ? e.message : 'Failed to initialize agent service',
          }));
          return;
        }
        if (this.deps.isDisposed?.()) return;
        if (!initialized) {
          new Notice(t('chat.rewind.failed', { error: 'Agent service not available' }));
          return;
        }
      }

      const agentService = this.getAgentService();
      if (!agentService) {
        new Notice(t('chat.rewind.failed', { error: 'Agent service not available' }));
        return;
      }
      if (!agentService.getCapabilities().supportsRewind) {
        new Notice(t('chat.rewind.failed', { error: 'Rewind is not supported by this provider.' }));
        return;
      }
      if (!isTargetCurrent()) {
        new Notice(t('chat.rewind.failed', { error: 'Conversation changed while rewinding.' }));
        return;
      }

      let confirmationMessage = mode === 'conversation'
        ? t('chat.rewind.confirmMessageConversationOnly')
        : t('chat.rewind.confirmMessage');
      if (mode === 'code-and-conversation' && agentService.previewRewind) {
        let preview;
        try {
          preview = await agentService.previewRewind(
            userMsg.userMessageId,
            prevAssistantUuid,
            mode,
          );
        } catch (e) {
          new Notice(t('chat.rewind.failed', {
            error: e instanceof Error ? e.message : 'Unknown error',
          }));
          return;
        }
        if (!preview.canRewind) {
          new Notice(t('chat.rewind.cannot', { error: preview.error ?? 'Unknown error' }));
          return;
        }
        if (preview.conflicts && preview.conflicts.length > 0) {
          confirmationMessage = buildRewindConflictConfirmation(preview.conflicts);
        }
        if (state.isStreaming) {
          new Notice(t('chat.rewind.unavailableStreaming'));
          return;
        }
        if (!isTargetCurrent() || this.getAgentService() !== agentService) {
          new Notice(t('chat.rewind.failed', { error: 'Conversation changed while rewinding.' }));
          return;
        }
      }

      const confirmed = await confirm(
        plugin.app,
        confirmationMessage,
        t('chat.rewind.confirmButton')
      );
      if (!confirmed) return;

      if (state.isStreaming) {
        new Notice(t('chat.rewind.unavailableStreaming'));
        return;
      }
      if (!isTargetCurrent() || this.getAgentService() !== agentService) {
        new Notice(t('chat.rewind.failed', { error: 'Conversation changed while rewinding.' }));
        return;
      }

      let result;
      try {
        result = await agentService.rewind(userMsg.userMessageId, prevAssistantUuid, mode);
      } catch (e) {
        new Notice(t('chat.rewind.failed', { error: e instanceof Error ? e.message : 'Unknown error' }));
        return;
      }
      if (!result.canRewind) {
        new Notice(t('chat.rewind.cannot', { error: result.error ?? 'Unknown error' }));
        return;
      }
      if (!isTargetCurrent() || this.getAgentService() !== agentService) {
        new Notice(t('chat.rewind.failed', { error: 'Conversation changed while rewinding.' }));
        return;
      }

      state.truncateAt(userMessageId);
      state.usage = null;

      const restoredContent = getUserDisplayText(userMsg);
      if (this.deps.restoreMessageToComposer) {
        this.deps.restoreMessageToComposer({
          content: restoredContent,
          images: userMsg.images,
        });
      } else {
        const inputEl = this.deps.getInputEl();
        inputEl.value = restoredContent;
        inputEl.focus();
      }

      const welcomeEl = renderer.renderMessages(state.messages, () => this.getGreeting());
      this.deps.setWelcomeEl(welcomeEl);
      this.updateWelcomeVisibility();

      const filesChanged = result.filesChanged?.length ?? 0;
      let saveError: string | null = null;
      try {
        await this.save(
          false,
          result.sessionStrategy === 'preserve-provider-session'
            ? { resumeAtMessageId: undefined }
            : {
              resumeAtMessageId: prevAssistantUuid,
              resetProviderSession: !prevAssistantUuid,
            },
        );
      } catch (e) {
        saveError = e instanceof Error ? e.message : 'Failed to save';
      }

      if (saveError) {
        new Notice(
          mode === 'conversation'
            ? t('chat.rewind.noticeConversationOnlySaveFailed', { error: saveError })
            : t('chat.rewind.noticeSaveFailed', { count: String(filesChanged), error: saveError })
        );
        return;
      }

      new Notice(
        mode === 'conversation'
          ? t('chat.rewind.noticeConversationOnly')
          : t('chat.rewind.notice', { count: String(filesChanged) })
      );
    } finally {
      state.isRewinding = false;
    }
  }

  async navigateBranch(userMessageId: string, branchMessageId: string): Promise<void> {
    const { state, renderer } = this.deps;
    if (
      this.deps.isDisposed?.()
      || state.isStreaming
      || state.isRewinding
      || state.isSwitchingConversation
      || state.isCreatingConversation
    ) return;

    const conversationId = state.currentConversationId;
    if (!conversationId) return;
    let runtime = this.getAgentService();
    const targetIsAdjacent = (message: ChatMessage | undefined): boolean => !!message?.branchNavigation
      && (
        message.branchNavigation.previousMessageId === branchMessageId
        || message.branchNavigation.nextMessageId === branchMessageId
      );
    const targetMessage = state.messages.find(message => message.userMessageId === userMessageId);
    if (!targetMessage?.userMessageId || !targetIsAdjacent(targetMessage)) {
      new Notice(t('chat.branchNavigation.failed', {
        error: t('chat.branchNavigation.unavailable'),
      }));
      return;
    }

    state.isRewinding = true;
    try {
      const runtimeBeforeInitialization = runtime;
      if (this.deps.ensureServiceInitialized) {
        const initialized = await this.deps.ensureServiceInitialized();
        if (!initialized) {
          new Notice(t('chat.branchNavigation.failed', {
            error: t('chat.branchNavigation.runtimeUnavailable'),
          }));
          return;
        }
      }
      runtime = this.getAgentService();

      if (
        this.deps.isDisposed?.()
        || state.currentConversationId !== conversationId
        || state.isStreaming
        || (runtimeBeforeInitialization && runtime?.providerId !== runtimeBeforeInitialization.providerId)
      ) return;

      const navigateConversationBranch = runtime?.navigateConversationBranch;
      if (!runtime?.getCapabilities().supportsConversationBranches || !navigateConversationBranch) {
        new Notice(t('chat.branchNavigation.failed', {
          error: t('chat.branchNavigation.unsupported'),
        }));
        return;
      }
      const navigationRuntime = runtime;

      const currentTargetMessage = state.messages.find(message => message.userMessageId === userMessageId);
      if (!targetIsAdjacent(currentTargetMessage)) {
        new Notice(t('chat.branchNavigation.failed', {
          error: t('chat.branchNavigation.unavailable'),
        }));
        return;
      }

      await this.save(false);
      if (
        this.deps.isDisposed?.()
        || state.currentConversationId !== conversationId
        || state.isStreaming
        || this.getAgentService() !== navigationRuntime
      ) return;

      const result = await navigateConversationBranch.call(navigationRuntime, {
        userMessageId,
        branchMessageId,
      });
      if (result.status === 'cancelled') return;
      if (result.status === 'failed' || result.status === 'recovery-required') {
        new Notice(t(
          result.status === 'recovery-required'
            ? 'chat.branchNavigation.recoveryRequired'
            : 'chat.branchNavigation.failed',
          { error: result.error },
        ));
        return;
      }
      if (
        this.deps.isDisposed?.()
        || state.currentConversationId !== conversationId
        || this.getAgentService() !== navigationRuntime
      ) return;

      state.messages = [...result.messages];
      state.usage = result.usage ?? null;
      state.currentTodos = null;
      state.hasPendingConversationSave = true;
      const welcomeEl = renderer.renderMessages(state.messages, () => this.getGreeting());
      this.deps.setWelcomeEl(welcomeEl);
      this.updateWelcomeVisibility();

      try {
        await this.save(false);
      } catch (error) {
        state.hasPendingConversationSave = true;
        new Notice(t('chat.branchNavigation.saveFailed', {
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    } catch (error) {
      new Notice(t('chat.branchNavigation.failed', {
        error: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      state.isRewinding = false;
    }
  }

  /**
   * Saves the current conversation.
   *
   * If we're at an entry point (no conversation yet) and have messages,
   * creates a new conversation first (lazy creation).
   *
   * For native sessions (new conversations with sessionId from SDK),
   * only metadata is saved - the SDK handles message persistence.
   */
  async save(updateLastResponse = false, options?: SaveOptions): Promise<void> {
    const { plugin, state } = this.deps;

    // Entry point with no messages - nothing to save
    if (!state.currentConversationId && state.messages.length === 0) {
      return;
    }

    const agentService = this.getAgentService();
    const sessionInvalidated = agentService?.consumeSessionInvalidation?.() ?? false;

    // Entry point with messages - create conversation lazily
    // New conversations always use SDK-native storage.
    if (!state.currentConversationId && state.messages.length > 0) {
      const initialSessionId = agentService?.getSessionId() ?? undefined;
      const selectedModel = this.deps.getSelectedModel?.() ?? undefined;
      const conversation = await plugin.createConversation({
        providerId: agentService?.providerId,
        sessionId: initialSessionId,
        ...(selectedModel ? { selectedModel } : {}),
      });
      state.currentConversationId = conversation.id;
    }

    const fileCtx = this.deps.getFileContextManager();
    const currentNote = fileCtx?.getCurrentNotePath() || undefined;
    const externalContextSelector = this.deps.getExternalContextSelector();
    const externalContextPaths = externalContextSelector?.getExternalContexts() ?? [];
    const mcpServerSelector = this.deps.getMcpServerSelector();
    const enabledMcpServers = mcpServerSelector ? Array.from(mcpServerSelector.getEnabledServers()) : [];

    const conversation = plugin.getConversationSync(state.currentConversationId!);

    const { updates: sessionUpdates } = agentService && !options?.resetProviderSession
      ? agentService.buildSessionUpdates({ conversation, sessionInvalidated })
      : { updates: {} };

    const updates: Partial<Conversation> = {
      ...sessionUpdates,
      messages: state.messages,
      currentNote: currentNote,
      externalContextPaths: externalContextPaths.length > 0 ? externalContextPaths : undefined,
      usage: state.usage ?? undefined,
      enabledMcpServers: enabledMcpServers.length > 0 ? enabledMcpServers : undefined,
    };

    if (updateLastResponse) {
      updates.lastResponseAt = Date.now();
    }

    if (options) {
      updates.resumeAtMessageId = options.resumeAtMessageId;
      if (options.resetProviderSession) {
        updates.sessionId = null;
        updates.providerState = undefined;
      }
    }

    await plugin.updateConversation(state.currentConversationId!, updates);
    state.hasPendingConversationSave = false;
  }

  /**
   * Shared logic for restoring a conversation into the current tab.
   * Used by both loadActive() and switchTo() to avoid duplication.
   */
  private restoreConversation(
    conversation: Conversation,
    options?: { autoAttachFile?: boolean }
  ): void {
    const { plugin, state, renderer } = this.deps;

    const restoredAttention = plugin.sessionRuntimePool?.getConversationAttention(conversation.id);
    state.currentConversationId = conversation.id;
    state.clearAttention();
    if (restoredAttention?.kind === 'review') {
      state.markReviewRequired(restoredAttention.outcome, restoredAttention.since);
      if (this.deps.isVisible?.()) {
        state.acknowledgeReview();
        plugin.setConversationAttention(conversation.id, null);
      }
    }
    state.messages = [...conversation.messages];
    state.usage = conversation.usage ?? null;
    state.autoScrollEnabled = plugin.settings.enableAutoScroll ?? true;
    state.hasPendingConversationSave = false;

    // Clear status panels (auto-hide: panels reappear when agent creates new todos)
    state.currentTodos = null;

    const hasMessages = state.messages.length > 0;

    // Determine external context paths for this session
    // Empty session: use persistent paths; session with messages: use saved paths
    const externalContextPaths = hasMessages
      ? conversation.externalContextPaths || []
      : plugin.settings.persistentExternalContextPaths || [];

    this.getAgentService()?.syncConversationState(conversation, externalContextPaths);

    const fileCtx = this.deps.getFileContextManager();
    fileCtx?.resetForLoadedConversation(hasMessages);

    if (conversation.currentNote) {
      fileCtx?.setCurrentNote(conversation.currentNote);
    } else if (!hasMessages && options?.autoAttachFile) {
      fileCtx?.autoAttachActiveFile();
    }

    this.restoreExternalContextPaths(conversation.externalContextPaths, !hasMessages);

    const mcpServerSelector = this.deps.getMcpServerSelector();
    if (conversation.enabledMcpServers && conversation.enabledMcpServers.length > 0) {
      mcpServerSelector?.setEnabledServers(conversation.enabledMcpServers);
    } else {
      mcpServerSelector?.clearEnabled();
    }

    const welcomeEl = renderer.renderMessages(
      state.messages,
      () => this.getGreeting()
    );
    this.deps.setWelcomeEl(welcomeEl);
  }

  /**
   * Restores external context paths based on session state.
   * New or empty sessions get current persistent paths from settings.
   * Sessions with messages restore exactly what was saved.
   */
  private restoreExternalContextPaths(
    savedPaths: string[] | undefined,
    isEmptySession: boolean
  ): void {
    const { plugin } = this.deps;
    const externalContextSelector = this.deps.getExternalContextSelector();
    if (!externalContextSelector) {
      return;
    }

    if (isEmptySession) {
      // Empty session: use current persistent paths from settings
      externalContextSelector.clearExternalContexts(
        plugin.settings.persistentExternalContextPaths || []
      );
    } else {
      // Session with messages: restore exactly what was saved
      externalContextSelector.setExternalContexts(savedPaths || []);
    }
  }

  // ============================================
  // History Dropdown
  // ============================================

  toggleHistoryDropdown(): void {
    const dropdown = this.deps.getHistoryDropdown();
    if (!dropdown) return;

    const isVisible = dropdown.hasClass('visible');
    if (isVisible) {
      dropdown.removeClass('visible');
      this.resetHistorySearch();
    } else {
      dropdown.addClass('visible');
      this.updateHistoryDropdown();
    }
  }

  cancelInlineRename(): boolean {
    const activeInlineRename = this.activeInlineRename;
    if (!activeInlineRename) return false;
    if (activeInlineRename.input.isConnected === false) {
      this.activeInlineRename = null;
      return false;
    }

    this.activeInlineRename = null;
    activeInlineRename.cancel();
    return true;
  }

  resetHistorySearch(): void {
    this.conversationBrowserSession?.reset();
    this.historyFilter = 'active';
  }

  updateHistoryDropdown(): void {
    const dropdown = this.deps.getHistoryDropdown();
    if (!dropdown) return;

    this.renderHistoryItems(dropdown, {
      onSelectConversation: (id) => this.switchTo(id),
      onRerender: () => this.updateHistoryDropdown(),
    });
  }

  /**
   * Renders history dropdown items to a container.
   * Shared implementation for updateHistoryDropdown() and renderHistoryDropdown().
   */
  private renderHistoryItems(
    container: HTMLElement,
    options: HistoryRenderOptions
  ): void {
    const { plugin, state } = this.deps;
    if (options.signal?.aborted) return;

    if (
      this.activeInlineRename
      && container.contains(this.activeInlineRename.input)
    ) {
      this.activeInlineRename = null;
    }

    container.empty();

    const dropdownHeader = container.createDiv({ cls: 'codian-history-header' });
    dropdownHeader.createSpan({ text: 'Conversations' });
    this.renderHistoryFilters(dropdownHeader, options.onRerender);

    const list = container.createDiv({ cls: 'codian-history-list' });
    const statusCache = new Map<string, HistoryConversationStatus>();
    const getStatus = (id: string): HistoryConversationStatus => {
      let s = statusCache.get(id);
      if (!s) {
        const fallback: HistoryConversationOpenState =
          id === state.currentConversationId ? 'current' : 'closed';
        s = this.getHistoryConversationStatus(id, fallback, options);
        statusCache.set(id, s);
      }
      return s;
    };

    const allConversations = [...plugin.getConversationList()];
    const filteredConversations = allConversations.filter(conversation => (
      this.historyFilter === 'all'
      || (this.historyFilter === 'archived' ? conversation.archived === true : conversation.archived !== true)
    ));
    const indexedConversations = filteredConversations.sort((a, b) => {
      const pinnedDiff = Number(b.pinned === true) - Number(a.pinned === true);
      if (pinnedDiff !== 0) return pinnedDiff;

      const statusA = getStatus(a.id);
      const statusB = getStatus(b.id);
      const isOpenA = statusA.openState === 'current' || statusA.openState === 'open';
      const isOpenB = statusB.openState === 'current' || statusB.openState === 'open';

      if (isOpenA !== isOpenB) {
        return isOpenA ? -1 : 1;
      }

      if (isOpenA && isOpenB) {
        const tabA = typeof statusA.tabIndex === 'number'
          ? statusA.tabIndex
          : (statusA.openState === 'current' ? 0 : Infinity);
        const tabB = typeof statusB.tabIndex === 'number'
          ? statusB.tabIndex
          : (statusB.openState === 'current' ? 0 : Infinity);
        if (tabA !== tabB && (tabA !== Infinity || tabB !== Infinity)) {
          return tabA - tabB;
        }
      }

      const timeA = a.lastResponseAt ?? a.updatedAt ?? a.createdAt;
      const timeB = b.lastResponseAt ?? b.updatedAt ?? b.createdAt;
      return timeB - timeA;
    });
    let presentation: ConversationBrowserListPresentation = {
      conversations: indexedConversations,
      emptyText: 'No conversations',
      highlightedConversationId: null,
      renderTitle: (title, conversation) => title.setText(conversation.title),
      renderPreview: () => {},
    };

    this.conversationBrowserSession?.render({
      container,
      header: dropdownHeader,
      conversations: indexedConversations,
      rerender: options.onRerender,
      close: () => container.removeClass('visible'),
      selectConversation: (id) => {
        runConversationAction(
          () => this.runHistoryAction(
            () => options.onSelectConversation(id),
            'Failed to load conversation',
          ),
          'Failed to load conversation',
        );
      },
      getActionableConversationIds: conversations => conversations
        .filter(conversation => {
          const fallbackOpenState: HistoryConversationOpenState =
            conversation.id === state.currentConversationId ? 'current' : 'closed';
          return this.getHistoryConversationStatus(
            conversation.id,
            fallbackOpenState,
            options,
          ).openState !== 'current';
        })
        .map(conversation => conversation.id),
      renderList: nextPresentation => { presentation = nextPresentation; },
    });

    const {
      conversations,
      emptyText,
      highlightedConversationId,
    } = presentation;

    if (conversations.length === 0) {
      list.createDiv({ cls: 'codian-history-empty', text: emptyText });
      return;
    }

    const pageSize = Math.max(1, options.pageSize ?? DEFAULT_HISTORY_PAGE_SIZE);
    const visibleCount = Math.max(pageSize, options.visibleCount ?? pageSize);
    const visibleConversations = conversations.slice(0, visibleCount);
    const conversationStatuses = new Map(visibleConversations.map(conversation => [
      conversation.id,
      getStatus(conversation.id),
    ] as const));
    for (const conv of visibleConversations) {
      if (options.signal?.aborted) return;
      const conversationStatus = conversationStatuses.get(conv.id)!;
      const { openState, isRunning } = conversationStatus;
      const statusIndicator = historyStatusIndicator(conversationStatus);
      const isCurrent = openState === 'current';
      const isOpen = openState === 'open';
      const item = list.createDiv({
        cls: [
          'codian-history-item',
          isCurrent ? 'active' : '',
          isOpen ? 'open' : '',
          isRunning ? 'running' : '',
          statusIndicator ? `status-${statusIndicator}` : '',
          conv.pinned ? 'pinned' : '',
          conv.archived ? 'archived' : '',
          conv.id === highlightedConversationId ? 'keyboard-selected' : '',
        ].filter(Boolean).join(' '),
      });
      item.setAttribute('data-conversation-id', conv.id);
      item.setAttribute('data-open-state', openState);
      item.setAttribute('data-running', isRunning ? 'true' : 'false');
      if (statusIndicator) item.setAttribute('data-status-indicator', statusIndicator);
      item.setAttribute('data-pinned', conv.pinned === true ? 'true' : 'false');
      item.setAttribute('data-archived', conv.archived === true ? 'true' : 'false');
      item.setAttribute('data-tab-location', conversationStatus.location ?? 'current-view');
      if (typeof conversationStatus.tabIndex === 'number') {
        item.setAttribute('data-tab-index', String(conversationStatus.tabIndex));
      }

      const iconEl = item.createDiv({ cls: 'codian-history-item-icon' });
      const statusIcon = statusIndicator === 'action-required'
        ? 'alert-circle'
        : statusIndicator === 'error'
          ? 'circle-x'
          : null;
      setIcon(iconEl, statusIcon ?? this.getHistoryItemIcon(openState, isRunning));
      if (statusIndicator && statusIndicator !== 'unread') {
        const statusLabel = statusIndicator === 'action-required'
          ? t('chat.historySearch.needsInput')
          : statusIndicator === 'error'
            ? t('chat.historySearch.stoppedWithError')
            : t('chat.historySearch.running');
        iconEl.setAttribute('aria-label', statusLabel);
      }

      const content = item.createDiv({ cls: 'codian-history-item-content' });
      if (openState === 'current' || openState === 'open') {
        const tabNumber = typeof conversationStatus.tabIndex === 'number'
          ? conversationStatus.tabIndex
          : null;
        const tabPill = content.createSpan({
          cls: [
            'codian-history-tab-pill',
            isCurrent ? 'is-active' : 'is-open',
          ].join(' '),
          text: tabNumber !== null ? `Tab ${tabNumber}` : (isCurrent ? 'Current' : 'Tab'),
        });
        tabPill.setAttribute(
          'aria-label',
          isCurrent ? `Current tab ${tabNumber ?? ''}`.trim() : `Open in tab ${tabNumber ?? ''}`.trim(),
        );
      }
      const titleEl = content.createDiv({ cls: 'codian-history-item-title' });
      presentation.renderTitle(titleEl, conv);
      if (conv.pinned) {
        const pinEl = titleEl.createSpan({
          cls: 'codian-history-item-pin',
        });
        setIcon(pinEl, 'pin');
        pinEl.setAttribute('aria-label', t('chat.historySearch.pinned'));
      }
      if (statusIndicator === 'unread') {
        titleEl.createSpan({ cls: 'codian-history-item-unread-dot' })
          .setAttribute('aria-label', t('chat.historySearch.unread'));
      }
      titleEl.setAttribute('title', conv.title);
      presentation.renderPreview(content, conv);
      content.createDiv({
        cls: 'codian-history-item-date',
        text: this.getHistoryItemStatusText(conversationStatus, conv.lastResponseAt ?? conv.createdAt),
      });

      if (!isCurrent) {
        content.addEventListener('click', (e) => {
          e.stopPropagation();
          if (this.isHistoryNewTabModifierClick(e) && options.onOpenConversationInNewTab) {
            e.preventDefault();
            runConversationAction(
              () => this.runHistoryAction(
                () => options.onOpenConversationInNewTab?.(conv.id, true),
                'Failed to load conversation',
              ),
              'Failed to load conversation',
            );
            return;
          }

          runConversationAction(
            () => this.runHistoryAction(
              () => options.onSelectConversation(conv.id),
              'Failed to load conversation',
            ),
            'Failed to load conversation',
          );
        });

        if (options.onOpenConversationInNewTab) {
          content.addEventListener('auxclick', (e) => {
            if (e.button !== 1) return;
            e.preventDefault();
            e.stopPropagation();
            runConversationAction(
              () => this.runHistoryAction(
                () => options.onOpenConversationInNewTab?.(conv.id, true),
                'Failed to load conversation',
              ),
              'Failed to load conversation',
            );
          });
        }
      }

      item.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.showHistoryContextMenu(
          item,
          conv.id,
          conv.title,
          isCurrent,
          conv.archived === true,
          options,
          e,
          conv.titleGenerationStatus,
        );
      });

      const actions = item.createDiv({ cls: 'codian-history-item-actions' });

      // Show loading indicator if pending
      if (conv.titleGenerationStatus === 'pending') {
        const loadingEl = actions.createEl('span', { cls: 'codian-action-btn codian-action-loading' });
        setIcon(loadingEl, 'loader-2');
        loadingEl.setAttribute('aria-label', 'Generating title...');
      }

      const moreBtn = actions.createEl('button', {
        cls: 'codian-action-btn codian-more-btn',
        attr: { type: 'button' },
      });
      setIcon(moreBtn, 'more-vertical');
      moreBtn.setAttribute('aria-label', t('chat.historySearch.moreOptions'));
      moreBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.showHistoryContextMenu(
          item,
          conv.id,
          conv.title,
          isCurrent,
          conv.archived === true,
          options,
          e,
          conv.titleGenerationStatus,
        );
      });

      const attention = conversationStatus.attention;
      const canShowInlineHistoryActions = attention == null
        || (attention.kind === 'review' && attention.outcome === 'completed');
      if (canShowInlineHistoryActions) {
        const pinButton = actions.createEl('button', {
          cls: 'codian-action-btn codian-pin-btn',
          attr: { type: 'button' },
        });
        setIcon(pinButton, conv.pinned ? 'pin-off' : 'pin');
        pinButton.setAttribute(
          'aria-label',
          t(conv.pinned ? 'chat.historySearch.unpin' : 'chat.historySearch.pin'),
        );
        pinButton.addEventListener('click', (e) => {
          e.stopPropagation();
          runConversationAction(
            () => this.updateHistoryIndexFlag(conv.id, 'pinned', conv.pinned !== true, options),
            t('chat.historySearch.updateFailed'),
          );
        });

        const archiveButton = actions.createEl('button', {
          cls: 'codian-action-btn codian-archive-btn',
          attr: { type: 'button' },
        });
        setIcon(archiveButton, conv.archived ? 'archive-restore' : 'archive');
        archiveButton.setAttribute(
          'aria-label',
          t(conv.archived ? 'chat.historySearch.unarchive' : 'chat.historySearch.archive'),
        );
        archiveButton.disabled = isRunning && conv.archived !== true;
        archiveButton.addEventListener('click', (e) => {
          e.stopPropagation();
          if (archiveButton.disabled) return;
          runConversationAction(
            () => this.updateHistoryIndexFlag(conv.id, 'archived', conv.archived !== true, options),
            t('chat.historySearch.updateFailed'),
          );
        });
      }
    }

    if (visibleConversations.length < conversations.length && !options.signal?.aborted) {
      const loadMoreButton = list.createEl('button', {
        cls: 'codian-history-load-more',
        text: `Load more (${conversations.length - visibleConversations.length} remaining)`,
      });
      loadMoreButton.addEventListener('click', () => {
        if (options.signal?.aborted) return;
        this.renderHistoryItems(container, {
          ...options,
          visibleCount: visibleCount + pageSize,
        });
      });
    }
  }

  private getHistoryConversationStatus(
    conversationId: string,
    fallbackOpenState: HistoryConversationOpenState,
    options: HistoryRenderOptions,
  ): HistoryConversationStatus {
    const status = options.getConversationStatus?.(conversationId);
    if (status) return status;

    return {
      openState: options.getConversationOpenState?.(conversationId) ?? fallbackOpenState,
      isRunning: false,
    };
  }

  private getHistoryItemStatusText(
    status: HistoryConversationStatus,
    timestamp: number,
  ): string {
    const { openState, isRunning } = status;
    const location = status.location ?? 'current-view';

    if (openState !== 'closed' && location === 'other-view') {
      return isRunning ? 'Running in another pane' : 'Open in another pane';
    }

    if (isRunning) {
      if (openState === 'closed') return 'Running';
      return `Running in ${this.getHistoryTabLabel(status)}`;
    }

    switch (openState) {
      case 'current':
        return typeof status.tabIndex === 'number'
          ? `Current tab ${status.tabIndex}`
          : 'Current session';
      case 'open':
        return `Open in ${this.getHistoryTabLabel(status)}`;
      case 'closed':
        return this.formatDate(timestamp);
    }
  }

  private getHistoryTabLabel(status: HistoryConversationStatus): string {
    if (typeof status.tabIndex === 'number') {
      return `tab ${status.tabIndex}`;
    }

    if (status.openState === 'current') {
      return 'current tab';
    }

    return 'tab';
  }

  private getHistoryItemIcon(
    openState: HistoryConversationOpenState,
    isRunning: boolean,
  ): string {
    if (isRunning) return 'loader-2';
    if (openState === 'current') return 'message-square-dot';
    return 'message-square';
  }

  private isHistoryNewTabModifierClick(event: MouseEvent): boolean {
    return !event.altKey && !event.shiftKey && (event.metaKey || event.ctrlKey);
  }

  private async runHistoryAction(
    action: () => Promise<void> | void,
    errorMessage: string,
  ): Promise<void> {
    try {
      await action();
    } catch {
      new Notice(errorMessage);
    }
  }

  private showHistoryContextMenu(
    item: HTMLElement,
    conversationId: string,
    title: string,
    isCurrent: boolean,
    archived: boolean,
    options: HistoryRenderOptions,
    event: MouseEvent,
    titleGenerationStatus?: 'pending' | 'success' | 'failed',
  ): void {
    const menu = new Menu();
    const fallbackOpenState: HistoryConversationOpenState = isCurrent ? 'current' : 'closed';
    const status = this.getHistoryConversationStatus(conversationId, fallbackOpenState, options);
    const { openState } = status;

    if (titleGenerationStatus === 'failed') {
      menu.addItem((menuItem) => menuItem
        .setTitle(t('chat.historySearch.regenerateTitle'))
        .setIcon('refresh-cw')
        .onClick(() => {
          void runConversationAction(
            () => this.regenerateTitle(conversationId),
            'Failed to regenerate response',
          );
        }));
    }

    if (openState === 'closed' && options.onOpenConversationInNewTab) {
      menu.addItem((menuItem) => menuItem
        .setTitle(t('chat.historySearch.openInNewTab'))
        .setIcon('square-plus')
        .onClick(() => {
          void this.runHistoryAction(
            () => options.onOpenConversationInNewTab?.(conversationId, true),
            'Failed to load conversation',
          );
        }));
      menu.addItem((menuItem) => menuItem
        .setTitle(t('chat.historySearch.openInBackgroundTab'))
        .setIcon('plus')
        .onClick(() => {
          void this.runHistoryAction(
            () => options.onOpenConversationInNewTab?.(conversationId, false),
            'Failed to load conversation',
          );
        }));
    }

    menu.addItem((menuItem) => menuItem
      .setTitle(t('chat.historySearch.rename'))
      .setIcon('pencil')
      .onClick(() => {
        this.showRenameInput(item, conversationId, title, options);
      }));

    if (!archived) {
      const isCompletedReview = status.attention?.kind === 'review'
        && status.attention.outcome === 'completed';
      if (isCompletedReview) {
        menu.addItem((menuItem) => menuItem
          .setTitle(t('chat.historySearch.markRead'))
          .setIcon('check')
          .onClick(() => {
            this.deps.plugin.setConversationAttention(conversationId, null);
            options.onRerender();
          }));
      } else if (status.attention == null && !status.isRunning) {
        menu.addItem((menuItem) => menuItem
          .setTitle(t('chat.historySearch.markUnread'))
          .setIcon('flag')
          .onClick(() => {
            this.deps.plugin.setConversationAttention(conversationId, {
              kind: 'review',
              outcome: 'completed',
              since: Date.now(),
            });
            options.onRerender();
          }));
      }
    }

    menu.addItem((menuItem) => menuItem
      .setTitle(t('chat.historySearch.delete'))
      .setIcon('trash-2')
      .onClick(() => {
        void this.runHistoryAction(
          () => this.deleteHistoryConversation(conversationId, options),
          'Failed to delete conversation',
        );
      }));

    menu.showAtMouseEvent(event);
  }

  private async updateHistoryIndexFlag(
    conversationId: string,
    field: 'pinned' | 'archived',
    value: boolean,
    options: HistoryRenderOptions,
  ): Promise<void> {
    if (field === 'pinned') {
      await this.deps.plugin.updateConversation(conversationId, { pinned: value });
    } else {
      await this.deps.plugin.updateConversation(conversationId, { archived: value });
    }
    options.onRerender();
  }

  private renderHistoryFilters(header: HTMLElement, onRerender: () => void): void {
    const filters = header.createDiv({ cls: 'codian-history-filters' });
    const filterOptions: Array<{ id: HistoryConversationFilter; label: string; cls: string }> = [
      { id: 'active', label: t('chat.historySearch.filterActive'), cls: 'codian-history-filter-active' },
      { id: 'archived', label: t('chat.historySearch.filterArchived'), cls: 'codian-history-filter-archived' },
      { id: 'all', label: t('chat.historySearch.filterAll'), cls: 'codian-history-filter-all' },
    ];

    for (const option of filterOptions) {
      const button = filters.createEl('button', {
        cls: `codian-history-filter ${option.cls}`,
        text: option.label,
        attr: {
          type: 'button',
          'aria-pressed': this.historyFilter === option.id ? 'true' : 'false',
        },
      });
      button.addEventListener('click', event => {
        event.stopPropagation();
        if (this.historyFilter === option.id) return;
        this.historyFilter = option.id;
        onRerender();
      });
    }
  }

  private async deleteHistoryConversation(
    conversationId: string,
    options: HistoryRenderOptions,
  ): Promise<void> {
    const { plugin, state } = this.deps;
    if (state.isStreaming) return;

    await plugin.deleteConversation(conversationId);
    options.onRerender();

    if (conversationId === state.currentConversationId) {
      await this.loadActive();
    }
  }

  /** Shows inline rename input for a conversation. */
  private showRenameInput(
    item: HTMLElement,
    convId: string,
    currentTitle: string,
    options: HistoryRenderOptions,
  ): void {
    const titleEl = item.querySelector('.codian-history-item-title') as HTMLElement;
    if (!titleEl) return;

    item.classList.add('is-renaming');
    const input = item.createEl('input');
    input.type = 'text';
    input.className = 'codian-rename-input';
    input.value = currentTitle;

    titleEl.replaceWith(input);
    input.focus();
    input.select();

    let isFinishing = false;
    const cancelRename = () => {
      item.classList.remove('is-renaming');
      input.value = currentTitle;
      input.blur();
    };
    this.activeInlineRename = { cancel: cancelRename, input };
    const finishRename = async () => {
      if (isFinishing) return;
      isFinishing = true;
      item.classList.remove('is-renaming');
      const newTitle = input.value.trim();
      if (!newTitle || newTitle === currentTitle) {
        isFinishing = false;
        options.onRerender();
        return;
      }

      try {
        await this.deps.plugin.renameConversation(convId, newTitle);
        options.onRerender();
      } catch {
        new Notice('Failed to rename conversation');
      } finally {
        isFinishing = false;
      }
    };

    input.addEventListener('blur', () => {
      if (this.activeInlineRename?.input === input) {
        this.activeInlineRename = null;
      }
      runConversationAction(finishRename, 'Failed to rename conversation');
    });
    input.addEventListener('keydown', (e) => {
      // Check !e.isComposing for IME support (Chinese, Japanese, Korean, etc.)
      if (e.key === 'Enter' && !e.isComposing) {
        input.blur();
      } else if (e.key === 'Escape' && !e.isComposing) {
        e.preventDefault();
        e.stopPropagation();
        cancelRename();
      }
    });
  }

  // ============================================
  // Welcome & Greeting
  // ============================================

  /** Generates a dynamic greeting based on time/day. */
  getGreeting(): string {
    const now = new Date();
    const hour = now.getHours();
    const day = now.getDay(); // 0 = Sunday, 6 = Saturday
    const name = this.deps.plugin.settings.userName?.trim();

    // Helper to optionally personalize a greeting (with fallback for no-name case)
    const personalize = (base: string, noNameFallback?: string): string =>
      name ? `${base}, ${name}` : (noNameFallback ?? base);

    // Day-specific greetings (some personalized, some universal)
    const dayGreetings: Record<number, string[]> = {
      0: [personalize('Happy Sunday'), 'Sunday session?', 'Welcome to the weekend'],
      1: [personalize('Happy Monday'), personalize('Back at it', 'Back at it!')],
      2: [personalize('Happy Tuesday')],
      3: [personalize('Happy Wednesday')],
      4: [personalize('Happy Thursday')],
      5: [personalize('Happy Friday'), personalize('That Friday feeling')],
      6: [personalize('Happy Saturday', 'Happy Saturday!'), personalize('Welcome to the weekend')],
    };

    // Time-specific greetings
    const getTimeGreetings = (): string[] => {
      if (hour >= 5 && hour < 12) {
        return [personalize('Good morning'), 'Coffee and Codian time?'];
      } else if (hour >= 12 && hour < 18) {
        return [personalize('Good afternoon'), personalize('Hey there'), personalize("How's it going") + '?'];
      } else if (hour >= 18 && hour < 22) {
        return [personalize('Good evening'), personalize('Evening'), personalize('How was your day') + '?'];
      } else {
        return ['Hello, night owl', personalize('Evening')];
      }
    };

    // General greetings
    const generalGreetings = [
      personalize('Hey there'),
      name ? `Hi ${name}, how are you?` : 'Hi, how are you?',
      personalize("How's it going") + '?',
      personalize('Welcome back') + '!',
      personalize("What's new") + '?',
      ...(name ? [`${name} returns!`] : []),
      'You are absolutely right!',
    ];

    // Combine day + time + general greetings, pick randomly
    const allGreetings = [
      ...(dayGreetings[day] || []),
      ...getTimeGreetings(),
      ...generalGreetings,
    ];

    return allGreetings[Math.floor(Math.random() * allGreetings.length)];
  }

  /** Updates welcome element visibility based on message count. */
  updateWelcomeVisibility(): void {
    const welcomeEl = this.deps.getWelcomeEl();
    if (!welcomeEl) return;

    if (this.deps.state.messages.length === 0) {
      welcomeEl.removeClass('codian-hidden');
    } else {
      welcomeEl.addClass('codian-hidden');
    }
  }

  /**
   * Initializes the welcome greeting for a new tab without a conversation.
   * Called when a new tab is activated and has no conversation loaded.
   */
  initializeWelcome(): void {
    const welcomeEl = this.deps.getWelcomeEl();
    if (!welcomeEl) return;

    // Initialize file context to auto-attach the currently focused note
    const fileCtx = this.deps.getFileContextManager();
    fileCtx?.resetForNewConversation();
    fileCtx?.autoAttachActiveFile();

    // Render the full welcome surface once; new tabs begin with an empty shell.
    if (!welcomeEl.querySelector('.codian-welcome-greeting')) {
      renderWelcomeContent(welcomeEl, this.getGreeting());
    }

    this.updateWelcomeVisibility();
  }

  // ============================================
  // Utilities
  // ============================================

  /** Generates a fallback title from the first message (used when AI fails). */
  generateFallbackTitle(firstMessage: string): string {
    const firstSentence = firstMessage.split(/[.!?\n]/)[0].trim();
    const autoTitle = firstSentence.substring(0, 50);
    const suffix = firstSentence.length > 50 ? '...' : '';
    return `${autoTitle}${suffix}`;
  }

  /** Regenerates AI title for a conversation. */
  async regenerateTitle(conversationId: string): Promise<void> {
    const { plugin } = this.deps;
    if (!plugin.settings.enableAutoTitleGeneration) return;

    // Title generation is delegated to the active provider service
    const fullConv = await plugin.getConversationById(conversationId);
    if (!fullConv || fullConv.messages.length < 1) return;

    const titleService = this.deps.getTitleGenerationService();
    if (!titleService) return;

    // Find first user message by role (not by index)
    const firstUserMsg = fullConv.messages.find(m => m.role === 'user');
    if (!firstUserMsg) return;

    const userContent = getUserDisplayText(firstUserMsg);

    // Store current title to check if user renames during generation
    const expectedTitle = fullConv.title;

    // Set pending status before starting generation
    await plugin.updateConversation(conversationId, { titleGenerationStatus: 'pending' });
    this.updateHistoryDropdown();

    // Fire async AI title generation
    await titleService.generateTitle(
      conversationId,
      userContent,
      async (convId, result) => {
        // Check if conversation still exists and user hasn't manually renamed
        const currentConv = await plugin.getConversationById(convId);
        if (!currentConv) return;

        // Only apply AI title if user hasn't manually renamed (title still matches expected)
        const userManuallyRenamed = currentConv.title !== expectedTitle;

        if (result.success && !userManuallyRenamed) {
          await plugin.renameConversation(convId, result.title);
          await plugin.updateConversation(convId, { titleGenerationStatus: 'success' });
        } else if (!userManuallyRenamed) {
          // Keep existing title, mark as failed (only if user hasn't renamed)
          await plugin.updateConversation(convId, { titleGenerationStatus: 'failed' });
        } else {
          // User manually renamed, clear the status (user's choice takes precedence)
          await plugin.updateConversation(convId, { titleGenerationStatus: undefined });
        }
        this.updateHistoryDropdown();
      }
    );
  }

  /** Formats a timestamp for display. */
  formatDate(timestamp: number): string {
    const date = new Date(timestamp);
    const now = new Date();

    if (date.toDateString() === now.toDateString()) {
      return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
    }
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  // ============================================
  // History Dropdown Rendering (for CodianView)
  // ============================================

  /**
   * Renders the history dropdown content to a provided container.
   * Used by CodianView to render the dropdown with custom selection callback.
   */
  renderHistoryDropdown(
    container: HTMLElement,
    options: Omit<HistoryRenderOptions, 'onRerender'>,
  ): void {
    this.renderHistoryItems(container, {
      ...options,
      onRerender: () => this.renderHistoryDropdown(container, options),
    });
  }
}
