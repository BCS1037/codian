import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import type { ProviderCapabilities, ProviderId } from '../../../core/providers/types';
import type { ChatRuntime } from '../../../core/runtime/ChatRuntime';
import type {
  ApprovalCallback,
  ApprovalDecisionOption,
  AskUserQuestionCallback,
  AutoTurnCallback,
  ChatRewindMode,
  ChatRewindResult,
  ChatRuntimeConversationState,
  ChatRuntimeEnsureReadyOptions,
  ChatRuntimeQueryOptions,
  ChatTurnMetadata,
  ChatTurnRequest,
  PreparedChatTurn,
  SessionUpdateResult,
} from '../../../core/runtime/types';
import type {
  ApprovalDecision,
  ChatMessage,
  Conversation,
  ExitPlanModeCallback,
  SlashCommand,
  StreamChunk,
} from '../../../core/types';
import { getEnhancedPath, parseEnvironmentVariables } from '../../../utils/env';
import { getVaultPath } from '../../../utils/path';
import {
  AcpClientConnection,
  type AcpContentBlock,
  AcpJsonRpcTransport,
  type AcpReadTextFileRequest,
  type AcpRequestPermissionRequest,
  type AcpRequestPermissionResponse,
  type AcpSessionNotification,
  AcpSessionUpdateNormalizer,
  AcpSubprocess,
  type AcpWriteTextFileRequest,
} from '../../acp';
import type { NativeAcpRuntimeOptions, NativeAcpSubprocess } from './types';

export class NativeAcpChatRuntime implements ChatRuntime {
  readonly providerId: ProviderId;

  private approvalCallback: ApprovalCallback | null = null;
  private connection: AcpClientConnection | null = null;
  private activeQueue: StreamChunkQueue | null = null;
  private disposed = false;
  private lastStartError: string | null = null;
  private process: NativeAcpSubprocess | null = null;
  private ready = false;
  private runtimeCwd: string | null = null;
  private readonly readyListeners = new Set<(ready: boolean) => void>();
  private sessionId: string | null = null;
  private sessionInvalidated = false;
  private sessionSyncRequired = false;
  private supportedCommands: SlashCommand[] = [];
  private targetSessionId: string | null = null;
  private transport: AcpJsonRpcTransport | null = null;
  private readonly updateNormalizer = new AcpSessionUpdateNormalizer();

  constructor(
    private readonly plugin: ProviderHost,
    private readonly options: NativeAcpRuntimeOptions,
  ) {
    this.providerId = options.providerId;
  }

  getCapabilities(): Readonly<ProviderCapabilities> {
    return this.options.capabilities;
  }

  prepareTurn(request: ChatTurnRequest): PreparedChatTurn {
    return {
      request,
      persistedContent: request.text,
      prompt: request.text,
      isCompact: false,
      mcpMentions: new Set(),
    };
  }

  onReadyStateChange(listener: (ready: boolean) => void): () => void {
    this.readyListeners.add(listener);
    return () => this.readyListeners.delete(listener);
  }

  setResumeCheckpoint(_checkpointId: string | undefined): void {}

  syncConversationState(conversation: ChatRuntimeConversationState | null): void {
    const nextTargetSessionId = conversation?.sessionId ?? null;
    if (this.ready && nextTargetSessionId !== this.sessionId) {
      this.sessionSyncRequired = true;
    }
    this.targetSessionId = nextTargetSessionId;
  }

  async reloadMcpServers(): Promise<void> {
    await this.restart();
  }

  async ensureReady(options: ChatRuntimeEnsureReadyOptions = {}): Promise<boolean> {
    if (this.disposed) {
      return false;
    }
    if (this.ready && this.process?.isAlive() && this.connection && !this.sessionSyncRequired) {
      return true;
    }

    try {
      this.lastStartError = null;
      if (this.sessionSyncRequired) {
        await this.shutdownProcess();
      }
      await this.startProcess();
      const cwd = getVaultPath(this.plugin.app) ?? process.cwd();
      if (this.targetSessionId) {
        const response = await this.connection!.loadSession({
          cwd,
          mcpServers: [],
          sessionId: this.targetSessionId ?? null,
        });
        this.sessionId = response.sessionId ?? null;
        if (this.sessionId) {
          await this.options.sessionAdapter?.syncSessionConfig({
            ...response,
            sessionId: this.sessionId,
          });
        }
      } else if (options.allowSessionCreation !== false) {
        const response = await this.connection!.newSession({ cwd, mcpServers: [] });
        this.sessionId = response.sessionId;
        await this.options.sessionAdapter?.syncSessionConfig(response);
      }
      this.sessionSyncRequired = false;
      this.setReady(true);
      return true;
    } catch (error) {
      this.lastStartError = this.options.sessionAdapter?.formatStartError?.(error)
        ?? (error instanceof Error ? error.message : String(error));
      await this.shutdownProcess();
      return false;
    }
  }

  async *query(
    turn: PreparedChatTurn,
    _conversationHistory?: ChatMessage[],
    queryOptions?: ChatRuntimeQueryOptions,
  ): AsyncGenerator<StreamChunk> {
    if (!(await this.ensureReady()) || !this.connection || !this.sessionId) {
      yield {
        type: 'error',
        content: `Failed to start ${this.options.providerId}${this.lastStartError ? `: ${this.lastStartError}` : '.'}`,
      };
      yield { type: 'done' };
      return;
    }

    this.updateNormalizer.reset();
    const queue = new StreamChunkQueue();
    this.activeQueue = queue;
    try {
      await this.options.sessionAdapter?.applySelections({
        connection: this.connection,
        model: queryOptions?.model,
        sessionId: this.sessionId,
      });
    } catch (error) {
      yield {
        type: 'error',
        content: error instanceof Error ? error.message : String(error),
      };
      yield { type: 'done' };
      this.activeQueue = null;
      return;
    }
    const promptBlocks: AcpContentBlock[] = [{ type: 'text', text: turn.prompt }];
    for (const image of turn.request.images ?? []) {
      if (image.data) {
        promptBlocks.push({
          data: image.data,
          mimeType: image.mediaType,
          type: 'image',
        });
      }
    }
    const prompt = this.connection.prompt({
      prompt: promptBlocks,
      sessionId: this.sessionId,
    }).then(() => {
      queue.push({ type: 'done' });
    }).catch((error) => {
      queue.push({
        type: 'error',
        content: error instanceof Error ? error.message : String(error),
      });
      queue.push({ type: 'done' });
    }).finally(() => {
      queue.close();
      if (this.activeQueue === queue) {
        this.activeQueue = null;
      }
    });

    while (true) {
      const chunk = await queue.next();
      if (!chunk) {
        break;
      }
      yield chunk;
    }
    await prompt;
  }

  cancel(): void {
    if (this.connection && this.sessionId) {
      this.connection.cancel({ sessionId: this.sessionId });
    }
    this.activeQueue?.close();
    this.activeQueue = null;
  }

  resetSession(): void {
    this.sessionId = null;
    this.targetSessionId = null;
    this.sessionInvalidated = true;
    this.sessionSyncRequired = true;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  consumeSessionInvalidation(): boolean {
    const invalidated = this.sessionInvalidated;
    this.sessionInvalidated = false;
    return invalidated;
  }

  isReady(): boolean {
    return this.ready;
  }

  async getSupportedCommands(): Promise<SlashCommand[]> {
    return [...this.supportedCommands];
  }

  cleanup(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    void this.shutdownProcess();
  }

  async rewind(
    _userMessageId: string,
    _assistantMessageId: string | undefined,
    _mode?: ChatRewindMode,
  ): Promise<ChatRewindResult> {
    return { canRewind: false };
  }

  setApprovalCallback(callback: ApprovalCallback | null): void {
    this.approvalCallback = callback;
  }

  setApprovalDismisser(_dismisser: (() => void) | null): void {}
  setAskUserQuestionCallback(_callback: AskUserQuestionCallback | null): void {}
  setExitPlanModeCallback(_callback: ExitPlanModeCallback | null): void {}
  setPermissionModeSyncCallback(_callback: ((sdkMode: string) => void) | null): void {}
  setAutoTurnCallback(_callback: AutoTurnCallback | null): void {}

  consumeTurnMetadata(): ChatTurnMetadata {
    return {};
  }

  buildSessionUpdates(params: {
    conversation: Conversation | null;
    sessionInvalidated: boolean;
  }): SessionUpdateResult {
    return {
      updates: {
        sessionId: params.sessionInvalidated ? null : this.sessionId,
      },
    };
  }

  resolveSessionIdForFork(conversation: Conversation | null): string | null {
    return this.sessionId ?? conversation?.sessionId ?? null;
  }

  private async startProcess(): Promise<void> {
    if (this.process?.isAlive() && this.connection) {
      return;
    }

    const cwd = getVaultPath(this.plugin.app) ?? process.cwd();
    this.runtimeCwd = cwd;
    const resolvedCommand = await this.plugin.getResolvedProviderCliPath(this.providerId)
      ?? this.options.defaultCommand;
    const envVars = parseEnvironmentVariables(
      getRuntimeEnvironmentText(this.plugin.settings, this.providerId),
    );
    const spec = {
      args: [...this.options.args],
      command: resolvedCommand,
      cwd,
      env: {
        ...process.env,
        ...envVars,
        PATH: getEnhancedPath(
          envVars.PATH,
          path.isAbsolute(resolvedCommand) ? resolvedCommand : undefined,
        ),
      },
    };
    this.process = this.options.createSubprocess?.(spec) ?? new AcpSubprocess(spec);
    this.process.start();

    this.transport = new AcpJsonRpcTransport({
      input: this.process.stdout,
      onClose: listener => this.process!.onClose(listener),
      output: this.process.stdin,
    });
    this.connection = new AcpClientConnection({
      clientInfo: {
        name: 'codian',
        version: this.plugin.manifest?.version ?? '0.0.0',
      },
      delegate: {
        fileSystem: {
          readTextFile: request => this.readTextFile(request),
          writeTextFile: request => this.writeTextFile(request),
        },
        onSessionNotification: notification => this.handleSessionNotification(notification),
        requestPermission: request => this.handlePermissionRequest(request),
      },
      transport: this.transport,
    });
    this.transport.start();
    await this.connection.initialize();
  }

  private handleSessionNotification(notification: AcpSessionNotification): void {
    const normalized = this.updateNormalizer.normalize(notification.update);
    if (normalized.type === 'message_chunk'
      || normalized.type === 'tool_call'
      || normalized.type === 'tool_call_update') {
      for (const chunk of normalized.streamChunks) {
        this.activeQueue?.push(chunk);
      }
    } else if (normalized.type === 'commands') {
      this.supportedCommands = normalized.commands;
    } else if (normalized.type === 'config_options' && this.sessionId) {
      void this.options.sessionAdapter?.handleConfigOptions?.(
        normalized.configOptions,
        this.sessionId,
      );
    }
  }

  private async handlePermissionRequest(
    request: AcpRequestPermissionRequest,
  ): Promise<AcpRequestPermissionResponse> {
    const reject = request.options.find(option => option.kind.startsWith('reject'));
    if (!this.approvalCallback) {
      return { outcome: reject ? { outcome: 'selected', optionId: reject.optionId } : { outcome: 'cancelled' } };
    }

    const input = request.toolCall.rawInput;
    const decision = await this.approvalCallback(
      request.toolCall.title ?? request.toolCall.kind ?? 'tool',
      input && typeof input === 'object' && !Array.isArray(input)
        ? input as Record<string, unknown>
        : {},
      request.toolCall.title ?? 'Tool permission requested',
      { decisionOptions: buildAcpApprovalDecisionOptions(request.options) },
    );
    return mapApprovalDecision(decision, request.options);
  }

  private async readTextFile(request: AcpReadTextFileRequest): Promise<{ content: string }> {
    const content = await fs.readFile(this.resolveSessionPath(request.sessionId, request.path), 'utf8');
    if (request.line == null && request.limit == null) {
      return { content };
    }

    const lines = content.split(/\r?\n/);
    const startIndex = Math.max(0, (request.line ?? 1) - 1);
    const endIndex = request.limit == null
      ? lines.length
      : startIndex + Math.max(0, request.limit);
    return { content: lines.slice(startIndex, endIndex).join('\n') };
  }

  private async writeTextFile(request: AcpWriteTextFileRequest): Promise<Record<string, never>> {
    const resolvedPath = this.resolveSessionPath(request.sessionId, request.path);
    await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
    await fs.writeFile(resolvedPath, request.content, 'utf8');
    return {};
  }

  private resolveSessionPath(sessionId: string, rawPath: string): string {
    if (!this.sessionId || sessionId !== this.sessionId) {
      throw new Error(`ACP file request session mismatch for ${this.options.providerId}.`);
    }
    return path.isAbsolute(rawPath)
      ? rawPath
      : path.resolve(this.runtimeCwd ?? process.cwd(), rawPath);
  }

  private async restart(): Promise<void> {
    await this.shutdownProcess();
    await this.ensureReady();
  }

  private async shutdownProcess(): Promise<void> {
    this.setReady(false);
    this.connection?.dispose();
    this.connection = null;
    this.transport?.dispose();
    this.transport = null;
    this.runtimeCwd = null;
    const processToStop = this.process;
    this.process = null;
    if (processToStop) {
      await processToStop.shutdown().catch(() => {});
    }
  }

  private setReady(ready: boolean): void {
    if (this.ready === ready) {
      return;
    }
    this.ready = ready;
    for (const listener of this.readyListeners) {
      listener(ready);
    }
  }
}

function buildAcpApprovalDecisionOptions(
  options: AcpRequestPermissionRequest['options'],
): ApprovalDecisionOption[] {
  return options.map(option => ({
    ...(option.kind === 'allow_once'
      ? { decision: 'allow' as const }
      : option.kind === 'allow_always'
        ? { decision: 'allow-always' as const }
        : {}),
    label: option.name,
    value: option.optionId,
  }));
}

function mapApprovalDecision(
  decision: ApprovalDecision,
  options: AcpRequestPermissionRequest['options'],
): AcpRequestPermissionResponse {
  if (typeof decision === 'object' && decision.type === 'select-option') {
    const selected = options.find(option => option.optionId === decision.value);
    return selected
      ? { outcome: { outcome: 'selected', optionId: selected.optionId } }
      : { outcome: { outcome: 'cancelled' } };
  }

  const preferredKinds = decision === 'allow'
    ? ['allow_once', 'allow_always']
    : decision === 'allow-always'
      ? ['allow_always', 'allow_once']
      : decision === 'deny'
        ? ['reject_once', 'reject_always']
        : [];
  for (const kind of preferredKinds) {
    const selected = options.find(option => option.kind === kind);
    if (selected) {
      return { outcome: { outcome: 'selected', optionId: selected.optionId } };
    }
  }
  return { outcome: { outcome: 'cancelled' } };
}

class StreamChunkQueue {
  private closed = false;
  private readonly items: StreamChunk[] = [];
  private readonly waiters: Array<(chunk: StreamChunk | null) => void> = [];

  push(chunk: StreamChunk): void {
    if (this.closed) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(chunk);
    } else {
      this.items.push(chunk);
    }
  }

  next(): Promise<StreamChunk | null> {
    const chunk = this.items.shift();
    if (chunk) {
      return Promise.resolve(chunk);
    }
    if (this.closed) {
      return Promise.resolve(null);
    }
    return new Promise(resolve => this.waiters.push(resolve));
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.(null);
    }
  }
}
