import { randomUUID } from 'node:crypto';

import type {
  ProviderExecutionInputBlock,
  ProviderExecutionRequest,
  ProviderExecutionRun,
  ProviderInteractionPort,
} from '../../../core/execution';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import type { ProviderCapabilities } from '../../../core/providers/types';
import type { ChatRuntime } from '../../../core/runtime/ChatRuntime';
import type {
  ApprovalCallback,
  AskUserQuestionCallback,
  AutoTurnCallback,
  ChatRewindMode,
  ChatRewindResult,
  ChatRuntimeConversationState,
  ChatRuntimeEnsureReadyOptions,
  ChatRuntimeQueryOptions,
  ChatTurnMetadata,
  ChatTurnRequest,
  ExitPlanModeCallback,
  PreparedChatTurn,
  SessionUpdateResult,
} from '../../../core/runtime/types';
import type {
  ChatMessage,
  Conversation,
  SlashCommand,
  StreamChunk,
  ToolCallInfo,
} from '../../../core/types';
import { getVaultPath } from '../../../utils/path';
import { getDeepSeekWorkspaceServices } from '../app/DeepSeekWorkspaceServices';
import { DEEPSEEK_PROVIDER_CAPABILITIES } from '../capabilities';
import { DeepSeekExecutionSession } from '../execution/DeepSeekExecutionSession';

export class DeepSeekChatRuntime implements ChatRuntime {
  readonly providerId = 'deepseek';

  private activeSession: DeepSeekExecutionSession | null = null;
  private activeRun: ProviderExecutionRun | null = null;
  private currentConversation: ChatRuntimeConversationState | null = null;
  private approvalCallback: ApprovalCallback | null = null;
  private approvalDismisser: (() => void) | null = null;
  private askUserQuestionCallback: AskUserQuestionCallback | null = null;
  private exitPlanModeCallback: ExitPlanModeCallback | null = null;
  private permissionModeSyncCallback: ((sdkMode: string) => void) | null = null;
  private autoTurnCallback: AutoTurnCallback | null = null;
  private lastTurnMetadata: ChatTurnMetadata & { turnStats?: unknown } = {};
  private readonly readyListeners = new Set<(ready: boolean) => void>();
  private resumeCheckpoint: string | undefined = undefined;
  private sessionInvalidated = false;

  constructor(private readonly plugin: ProviderHost) {}

  getCapabilities(): Readonly<ProviderCapabilities> {
    return DEEPSEEK_PROVIDER_CAPABILITIES;
  }

  prepareTurn(request: ChatTurnRequest): PreparedChatTurn {
    return {
      isCompact: false,
      mcpMentions: request.enabledMcpServers ?? new Set(),
      persistedContent: '',
      prompt: request.text,
      request,
    };
  }

  onReadyStateChange(listener: (ready: boolean) => void): () => void {
    this.readyListeners.add(listener);
    return () => {
      this.readyListeners.delete(listener);
    };
  }

  setResumeCheckpoint(checkpointId: string | undefined): void {
    this.resumeCheckpoint = checkpointId;
  }

  syncConversationState(
    conversation: ChatRuntimeConversationState | null,
    _externalContextPaths?: string[],
  ): void {
    const prevSessionId = this.currentConversation?.sessionId ?? null;
    const nextSessionId = conversation?.sessionId ?? null;
    this.currentConversation = conversation;
    if (this.activeSession && prevSessionId !== nextSessionId) {
      void this.activeSession.dispose();
      this.activeSession = null;
      this.activeRun = null;
    }
  }

  async reloadMcpServers(): Promise<void> {}

  async ensureReady(_options?: ChatRuntimeEnsureReadyOptions): Promise<boolean> {
    try {
      this.getOrCreateSession();
      this.notifyReady(true);
      return true;
    } catch {
      this.notifyReady(false);
      return false;
    }
  }

  isReady(): boolean {
    return this.activeSession !== null;
  }

  async *query(
    turn: PreparedChatTurn,
    conversationHistory?: ChatMessage[],
    queryOptions?: ChatRuntimeQueryOptions,
  ): AsyncGenerator<StreamChunk> {
    const session = this.getOrCreateSession();
    const abortController = new AbortController();
    const signal = (queryOptions as { signal?: AbortSignal })?.signal ?? abortController.signal;

    const input: ProviderExecutionInputBlock[] = [
      { type: 'text', text: turn.request.text },
      ...(turn.request.images ?? []).map(image => ({
        type: 'image' as const,
        image,
      })),
    ];

    const model = (queryOptions as { model?: string })?.model
      ?? (turn.request as { model?: string }).model
      ?? this.currentConversation?.selectedModel;

    const request: ProviderExecutionRequest = {
      inputId: randomUUID(),
      input,
      context: {
        linkedContent: turn.request.currentNotePath
          ? { path: turn.request.currentNotePath }
          : undefined,
        editorSelection: turn.request.editorSelection,
        browserSelection: turn.request.browserSelection,
        canvasSelection: turn.request.canvasSelection,
      },
      conversationHistory,
      configuration: {
        systemInstructions: { kind: 'provider-default' },
        model,
        reasoning: (turn.request as { reasoningEffort?: string }).reasoningEffort,
        permissionMode: (turn.request as { permissionMode?: string }).permissionMode,
      },
      toolPolicy: { kind: 'provider-default' },
      signal,
    };

    const run = session.execute(request);
    this.activeRun = run;

    try {
      for await (const event of run.events) {
        if (event.type === 'turn_started') {
          if (event.nativeUserMessageId) {
            this.lastTurnMetadata.userMessageId = event.nativeUserMessageId;
          }
        } else if (event.type === 'user_message_started') {
          yield {
            type: 'user_message_start',
            content: event.content ?? '',
            itemId: event.nativeUserMessageId,
          };
        } else if (event.type === 'assistant_message_started') {
          yield {
            type: 'assistant_message_start',
            itemId: event.nativeAssistantId,
          };
        } else if (event.type === 'text_delta') {
          yield { type: 'text', content: event.text };
        } else if (event.type === 'thinking_delta') {
          yield { type: 'thinking', content: event.text };
        } else if (event.type === 'tool_started') {
          if (event.toolScope.kind === 'subagent') {
            yield {
              type: 'subagent_tool_use',
              subagentId: event.toolScope.subagentId,
              id: event.toolCallId,
              name: event.name,
              input: event.input,
            };
          } else {
            yield {
              type: 'tool_use',
              id: event.toolCallId,
              name: event.name,
              input: event.input,
              providerPayload: event.providerPayload,
            };
          }
        } else if (event.type === 'tool_output') {
          yield {
            type: 'tool_output',
            id: event.toolCallId,
            content: event.content,
          };
        } else if (event.type === 'tool_completed') {
          if (event.toolScope.kind === 'subagent') {
            yield {
              type: 'subagent_tool_result',
              subagentId: event.toolScope.subagentId,
              id: event.toolCallId,
              content: event.content ?? '',
              isError: event.isError,
              isBlocked: event.isBlocked,
              toolUseResult: event.resultDetails as never,
            };
          } else {
            yield {
              type: 'tool_result',
              id: event.toolCallId,
              content: event.content ?? '',
              isError: event.isError,
              isBlocked: event.isBlocked,
              toolUseResult: event.resultDetails as never,
            };
          }
        } else if (event.type === 'usage_updated') {
          yield {
            type: 'usage',
            usage: event.usage,
            sessionId: session.getSnapshot().providerSessionId,
          };
        } else if (event.type === 'context_compacted') {
          yield { type: 'context_compacted' };
        } else if (event.type === 'notice') {
          yield {
            type: 'notice',
            content: event.message,
            level: event.level,
          };
        } else if (event.type === 'turn_completed') {
          if (event.nativeUserMessageId) {
            this.lastTurnMetadata.userMessageId = event.nativeUserMessageId;
          }
          if (event.nativeAssistantId) {
            this.lastTurnMetadata.assistantMessageId = event.nativeAssistantId;
          }
          if (event.turnStats) {
            this.lastTurnMetadata.turnStats = event.turnStats;
          }
          yield { type: 'done' };
        } else if (event.type === 'cancelled') {
          yield { type: 'done' };
        } else if (event.type === 'execution_error') {
          yield {
            type: 'error',
            content: event.message,
            code: event.category === 'provider-session-missing' ? 'provider_session_missing' : undefined,
            providerSessionId: event.missingProviderSessionId,
          };
        }
      }
    } finally {
      this.activeRun = null;
    }
  }

  async steer(turn: PreparedChatTurn): Promise<boolean> {
    if (!this.activeSession) return false;
    const request: ProviderExecutionRequest = {
      inputId: randomUUID(),
      input: [
        { type: 'text', text: turn.request.text },
        ...(turn.request.images ?? []).map(image => ({
          type: 'image' as const,
          image,
        })),
      ],
      configuration: {
        systemInstructions: { kind: 'provider-default' },
      },
      toolPolicy: { kind: 'provider-default' },
      signal: new AbortController().signal,
    };
    return this.activeSession.steer(request);
  }

  cancel(): void {
    if (this.activeRun) {
      this.activeRun.cancel();
    } else {
      this.activeSession?.cancel();
    }
  }

  resetSession(): void {
    if (this.activeSession) {
      void this.activeSession.dispose();
      this.activeSession = null;
    }
    this.activeRun = null;
    this.sessionInvalidated = true;
  }

  getSessionId(): string | null {
    return this.activeSession?.getSnapshot().providerSessionId
      ?? this.currentConversation?.sessionId
      ?? null;
  }

  consumeSessionInvalidation(): boolean {
    const invalidated = this.sessionInvalidated;
    this.sessionInvalidated = false;
    return invalidated;
  }

  async getSupportedCommands(): Promise<SlashCommand[]> {
    const snapshot = this.activeSession?.getCommandSnapshot?.();
    return snapshot ? [...snapshot] : [];
  }

  cleanup(): void {
    if (this.activeSession) {
      void this.activeSession.dispose();
      this.activeSession = null;
    }
    this.activeRun = null;
    this.readyListeners.clear();
  }

  async rewind(
    _userMessageId: string,
    _assistantMessageId: string | undefined,
    _mode?: ChatRewindMode,
  ): Promise<ChatRewindResult> {
    return { canRewind: false, error: 'DeepSeek Harness does not support rewind.' };
  }

  setApprovalCallback(callback: ApprovalCallback | null): void {
    this.approvalCallback = callback;
  }

  setApprovalDismisser(dismisser: (() => void) | null): void {
    this.approvalDismisser = dismisser;
  }

  setAskUserQuestionCallback(callback: AskUserQuestionCallback | null): void {
    this.askUserQuestionCallback = callback;
  }

  setExitPlanModeCallback(callback: ExitPlanModeCallback | null): void {
    this.exitPlanModeCallback = callback;
  }

  setPermissionModeSyncCallback(callback: ((sdkMode: string) => void) | null): void {
    this.permissionModeSyncCallback = callback;
  }

  setAutoTurnCallback(callback: AutoTurnCallback | null): void {
    this.autoTurnCallback = callback;
  }

  consumeTurnMetadata(): ChatTurnMetadata {
    const meta = { ...this.lastTurnMetadata };
    this.lastTurnMetadata = {};
    return meta;
  }

  buildSessionUpdates(params: {
    conversation: Conversation | null;
    sessionInvalidated: boolean;
  }): SessionUpdateResult {
    const snapshot = this.activeSession?.getSnapshot();
    const sessionId = snapshot?.providerSessionId ?? params.conversation?.sessionId ?? null;
    const updates: Partial<Conversation> = {
      sessionId,
      providerState: snapshot?.providerState,
    };
    if (params.sessionInvalidated && !sessionId) {
      updates.providerState = undefined;
      updates.sessionId = null;
    }
    return { updates };
  }

  resolveSessionIdForFork(conversation: Conversation | null): string | null {
    return this.getSessionId() ?? conversation?.sessionId ?? null;
  }

  async loadSubagentToolCalls(_agentId: string): Promise<ToolCallInfo[]> {
    return [];
  }

  async loadSubagentFinalResult(_agentId: string): Promise<string | null> {
    return null;
  }

  private getOrCreateSession(): DeepSeekExecutionSession {
    if (this.activeSession) return this.activeSession;

    const workspace = getDeepSeekWorkspaceServices();
    const interactionPort: ProviderInteractionPort = {
      requestApproval: async (req, _signal) => {
        if (!this.approvalCallback) {
          return { interactionId: req.interactionId, decision: 'deny' };
        }
        const decision = await this.approvalCallback(
          req.toolName,
          req.input,
          req.description,
          {
            decisionReason: req.decisionReason,
            blockedPath: req.blockedPath,
            decisionOptions: req.decisionOptions ? [...req.decisionOptions] : undefined,
          },
        );
        return { interactionId: req.interactionId, decision };
      },
      askUserQuestion: async (req, signal) => {
        if (!this.askUserQuestionCallback) {
          return { interactionId: req.interactionId, answers: null };
        }
        const answers = await this.askUserQuestionCallback(req.input, signal);
        return { interactionId: req.interactionId, answers };
      },
      dismissInteraction: () => {
        this.approvalDismisser?.();
      },
    };

    const session = new DeepSeekExecutionSession(
      this.plugin,
      {
        lifecycle: 'persistent',
        nativePersistence: 'enabled',
        resumeSeed: {
          providerSessionId: this.currentConversation?.sessionId ?? undefined,
          providerState: this.currentConversation?.providerState,
          resumeCheckpoint: this.resumeCheckpoint,
        },
        vaultWorkingDirectory: getVaultPath(this.plugin.app) ?? process.cwd(),
        interactionPort,
      },
      workspace.deepseek,
    );

    this.activeSession = session;
    return session;
  }

  private notifyReady(ready: boolean): void {
    for (const listener of this.readyListeners) {
      try {
        listener(ready);
      } catch {
        /* listener errors are non-fatal */
      }
    }
  }
}
