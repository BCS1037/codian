import type {
  ProviderConversationHistoryService,
  ProviderConversationSessionAvailability,
  ProviderHistoryPathContext,
} from '../../../core/providers/types';
import { TOOL_SUBAGENT } from '../../../core/tools/toolNames';
import { omitToolResultImageData } from '../../../core/tools/toolResultContent';
import type {
  AsyncSubagentStatus,
  ChatMessage,
  Conversation,
  ForkSource,
  ImageAttachment,
  SubagentInfo,
  ToolCallInfo,
} from '../../../core/types';
import { isClaudeSubagentToolName } from '../subagentToolNames';
import { type ClaudeProviderState, getClaudeState } from '../types/providerState';
import {
  deleteSDKSession,
  encodeVaultPathForSDK,
  getSDKProjectsPath,
  loadSDKSessionMessages,
  loadSubagentToolCalls,
  locateSDKSession,
  locateSDKSessions,
} from './ClaudeHistoryStore';
import type { SDKSessionLocation } from './sdkSessionPaths';

function chooseRicherResult(sdkResult?: string, cachedResult?: string): string | undefined {
  const sdkText = typeof sdkResult === 'string' ? sdkResult.trim() : '';
  const cachedText = typeof cachedResult === 'string' ? cachedResult.trim() : '';

  if (sdkText.length === 0 && cachedText.length === 0) return undefined;
  if (sdkText.length === 0) return cachedResult;
  if (cachedText.length === 0) return sdkResult;

  return sdkText.length >= cachedText.length ? sdkResult : cachedResult;
}

function chooseRicherToolCalls(
  sdkToolCalls: ToolCallInfo[] = [],
  cachedToolCalls: ToolCallInfo[] = [],
): ToolCallInfo[] {
  if (sdkToolCalls.length >= cachedToolCalls.length) {
    return sdkToolCalls;
  }

  return cachedToolCalls;
}

function normalizeAsyncStatus(
  subagent: SubagentInfo | undefined,
  modeOverride?: SubagentInfo['mode'],
): AsyncSubagentStatus | undefined {
  if (!subagent) return undefined;

  const mode = modeOverride ?? subagent.mode;
  if (mode === 'sync') return undefined;
  if (mode === 'async') return subagent.asyncStatus ?? subagent.status;
  return subagent.asyncStatus;
}

function isTerminalAsyncStatus(status: AsyncSubagentStatus | undefined): boolean {
  return status === 'completed' || status === 'error' || status === 'orphaned';
}

function mergeSubagentInfo(
  taskToolCall: ToolCallInfo,
  cachedSubagent: SubagentInfo,
): SubagentInfo {
  const sdkSubagent = taskToolCall.subagent;
  const cachedAsyncStatus = normalizeAsyncStatus(cachedSubagent);
  if (!sdkSubagent) {
    return {
      ...cachedSubagent,
      asyncStatus: cachedAsyncStatus,
      result: chooseRicherResult(taskToolCall.result, cachedSubagent.result),
    };
  }

  const sdkAsyncStatus = normalizeAsyncStatus(sdkSubagent);
  const sdkIsTerminal = isTerminalAsyncStatus(sdkAsyncStatus);
  const cachedIsTerminal = isTerminalAsyncStatus(cachedAsyncStatus);
  const sdkResult = taskToolCall.result ?? sdkSubagent.result;

  const preferred = (!sdkIsTerminal && cachedIsTerminal) ? cachedSubagent : sdkSubagent;

  const mergedMode = sdkSubagent.mode
    ?? cachedSubagent.mode
    ?? (taskToolCall.input?.run_in_background === true ? 'async' : undefined);
  const fallbackResult = chooseRicherResult(sdkResult, cachedSubagent.result);
  const mergedResult = preferred === cachedSubagent
    ? (cachedSubagent.result ?? fallbackResult)
    : fallbackResult;
  const mergedAsyncStatus = normalizeAsyncStatus(preferred, mergedMode);

  return {
    ...cachedSubagent,
    ...sdkSubagent,
    description: sdkSubagent.description || cachedSubagent.description,
    prompt: sdkSubagent.prompt || cachedSubagent.prompt,
    mode: mergedMode,
    status: preferred.status,
    asyncStatus: mergedAsyncStatus,
    result: mergedResult,
    toolCalls: chooseRicherToolCalls(sdkSubagent.toolCalls, cachedSubagent.toolCalls),
    agentId: sdkSubagent.agentId || cachedSubagent.agentId,
    outputToolId: sdkSubagent.outputToolId || cachedSubagent.outputToolId,
    startedAt: sdkSubagent.startedAt ?? cachedSubagent.startedAt,
    completedAt: sdkSubagent.completedAt ?? cachedSubagent.completedAt,
    isExpanded: sdkSubagent.isExpanded ?? cachedSubagent.isExpanded,
  };
}

function ensureTaskToolCall(
  msg: ChatMessage,
  subagentId: string,
  subagent: SubagentInfo,
): ToolCallInfo {
  msg.toolCalls = msg.toolCalls || [];
  let taskToolCall = msg.toolCalls.find(
    tc => tc.id === subagentId && isClaudeSubagentToolName(tc.name),
  );

  if (!taskToolCall) {
    taskToolCall = {
      id: subagentId,
      name: TOOL_SUBAGENT,
      input: {
        description: subagent.description,
        prompt: subagent.prompt || '',
        ...(subagent.mode === 'async' ? { run_in_background: true } : {}),
      },
      status: subagent.status,
      result: subagent.result,
      isExpanded: false,
      subagent,
    };
    msg.toolCalls.push(taskToolCall);
    return taskToolCall;
  }

  taskToolCall.name = TOOL_SUBAGENT;

  if (!taskToolCall.input.description) {
    taskToolCall.input.description = subagent.description;
  }
  if (!taskToolCall.input.prompt) {
    taskToolCall.input.prompt = subagent.prompt || '';
  }
  if (subagent.mode === 'async') {
    taskToolCall.input.run_in_background = true;
  }
  const mergedSubagent = mergeSubagentInfo(taskToolCall, subagent);
  taskToolCall.status = mergedSubagent.status;
  if (mergedSubagent.mode === 'async') {
    taskToolCall.input.run_in_background = true;
  }
  if (mergedSubagent.result !== undefined) {
    taskToolCall.result = mergedSubagent.result;
  }
  taskToolCall.subagent = mergedSubagent;
  return taskToolCall;
}

function hasImageData(image: ImageAttachment | undefined): boolean {
  return typeof image?.data === 'string' && image.data.length > 0;
}

function mergeImageAttachments(
  current: ImageAttachment[] | undefined,
  incoming: ImageAttachment[] | undefined,
): ImageAttachment[] | undefined {
  if (!incoming?.length) {
    return current;
  }
  if (!current?.length) {
    return incoming;
  }

  const merged = [...current];
  for (const [index, incomingImage] of incoming.entries()) {
    const currentImage = merged[index];
    if (!currentImage) {
      merged.push(incomingImage);
      continue;
    }

    if (!hasImageData(currentImage) && hasImageData(incomingImage)) {
      merged[index] = {
        ...currentImage,
        data: incomingImage.data,
        mediaType: incomingImage.mediaType,
        name: currentImage.name || incomingImage.name,
        size: incomingImage.size,
        source: currentImage.source ?? incomingImage.source,
      };
    }
  }

  return merged;
}

function mergeDuplicateMessage(target: ChatMessage, incoming: ChatMessage): void {
  target.images = mergeImageAttachments(target.images, incoming.images);
}

function dedupeMessages(messages: ChatMessage[]): ChatMessage[] {
  const byId = new Map<string, ChatMessage>();
  const result: ChatMessage[] = [];

  for (const message of messages) {
    const existing = byId.get(message.id);
    if (existing) {
      mergeDuplicateMessage(existing, message);
      continue;
    }

    byId.set(message.id, message);
    result.push(message);
  }

  return result;
}

/**
 * Cached messages are the tab's live projection under Codian-local ids. Native history supersedes
 * every cached message it reflects by id or native identity. Complete history also supersedes every
 * unmatched one before the last reflected message; later messages are the unconfirmed tail. A live
 * task notification that native never consumed keeps its place. Incomplete history keeps every
 * unmatched message: it may be the only copy of an unreadable segment.
 */
function retainUnconfirmedCachedMessages(
  cached: ChatMessage[],
  native: ChatMessage[],
  complete: boolean,
): ChatMessage[] {
  const nativeIds = new Set(native.map(message => message.id));
  const nativeUserIds = new Set(native.flatMap(message => message.role === 'user' && message.userMessageId
    ? [message.userMessageId] : []));
  const nativeAssistantIds = new Set(native.flatMap(message => message.role === 'assistant'
    && message.assistantMessageId ? [message.assistantMessageId] : []));
  const nativeNotifications = new Set(native.flatMap(message => (message.contentBlocks ?? [])
    .flatMap(block => block.type === 'task_notification' ? [block.content] : [])));
  const reflectsNative = (message: ChatMessage): boolean => nativeIds.has(message.id) || (message.role === 'user'
    ? !!message.userMessageId && nativeUserIds.has(message.userMessageId)
    : !!message.assistantMessageId && nativeAssistantIds.has(message.assistantMessageId));
  const isUnconsumedNotification = (message: ChatMessage): boolean => !!message.contentBlocks?.length
    && message.contentBlocks.every(block => block.type === 'task_notification' && !nativeNotifications.has(block.content));
  let lastReflected = -1;
  cached.forEach((message, index) => { if (reflectsNative(message)) lastReflected = index; });
  return cached.filter((message, index) => nativeIds.has(message.id)
    || (!reflectsNative(message) && (!complete || index > lastReflected || isUnconsumedNotification(message))));
}

/** Native transcript order wins; cached-only messages keep their surrounding anchors. */
function mergeHistoryMessages(cached: ChatMessage[], native: ChatMessage[]): ChatMessage[] {
  const byId = new Map(dedupeMessages([...cached, ...native]).map(message => [message.id, message]));
  const nativeIds = new Set(native.map(message => message.id));
  const nextAnchors = new Map<string, string>();
  let nextAnchor: string | undefined;
  for (const message of [...cached].reverse()) {
    if (nativeIds.has(message.id)) nextAnchor = message.id;
    else if (nextAnchor) nextAnchors.set(message.id, nextAnchor);
  }
  const emitted = new Set<string>();
  const result: ChatMessage[] = [];
  const append = (message: ChatMessage) => {
    if (emitted.has(message.id)) return;
    emitted.add(message.id);
    result.push(byId.get(message.id)!);
  };
  let cursor = 0;
  for (const message of native) {
    while (cursor < cached.length) {
      const candidate = cached[cursor];
      if (candidate.id === message.id) {
        cursor++;
        break;
      }
      if (emitted.has(candidate.id)) {
        cursor++;
        continue;
      }
      // A shared message anchors later cache entries; timestamps only place
      // entries absent from native history, never reorder native messages.
      if (nativeIds.has(candidate.id)
        || (nextAnchors.get(candidate.id) !== message.id && candidate.timestamp > message.timestamp)) break;
      append(candidate);
      cursor++;
    }
    append(message);
  }
  for (; cursor < cached.length; cursor++) append(cached[cursor]);
  return result;
}

async function enrichAsyncSubagentToolCalls(
  subagentData: Record<string, SubagentInfo>,
  vaultPath: string,
  sessionIds: string[],
  relocatedSessionPaths: Map<string, string>,
  pathContext?: ProviderHistoryPathContext,
): Promise<void> {
  const uniqueSessionIds = [...new Set(sessionIds)];
  if (uniqueSessionIds.length === 0) return;

  const loaderCache = new Map<string, ReturnType<typeof loadSubagentToolCalls>>();

  for (const subagent of Object.values(subagentData)) {
    if (subagent.mode !== 'async') continue;
    if (!subagent.agentId) continue;
    if ((subagent.toolCalls?.length ?? 0) > 0) continue;

    for (const sessionId of uniqueSessionIds) {
      const cacheKey = `${sessionId}:${subagent.agentId}`;

      let loader = loaderCache.get(cacheKey);
      if (!loader) {
        const relocatedSessionPath = relocatedSessionPaths.get(sessionId);
        if (pathContext) {
          loader = loadSubagentToolCalls(
            vaultPath,
            sessionId,
            subagent.agentId,
            relocatedSessionPath,
            pathContext,
          );
        } else {
          loader = loadSubagentToolCalls(
            vaultPath,
            sessionId,
            subagent.agentId,
            relocatedSessionPath,
          );
        }
        loaderCache.set(cacheKey, loader);
      }

      const recoveredToolCalls = await loader;
      if (recoveredToolCalls.length === 0) continue;

      subagent.toolCalls = recoveredToolCalls.map(toolCall => ({
        ...toolCall,
        input: { ...toolCall.input },
      }));
      break;
    }
  }
}

function applySubagentData(
  messages: ChatMessage[],
  subagentData: Record<string, SubagentInfo>,
): void {
  const attachedSubagentIds = new Set<string>();

  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;

    for (const [subagentId, subagent] of Object.entries(subagentData)) {
      const hasSubagentBlock = msg.contentBlocks?.some(
        block => (block.type === 'subagent' && block.subagentId === subagentId)
          || (block.type === 'tool_use' && block.toolId === subagentId),
      );
      const hasTaskToolCall = msg.toolCalls?.some(tc => tc.id === subagentId) ?? false;

      if (!hasSubagentBlock && !hasTaskToolCall) continue;
      ensureTaskToolCall(msg, subagentId, subagent);

      if (!msg.contentBlocks) {
        msg.contentBlocks = [];
      }

      let hasNormalizedSubagentBlock = false;
      for (let i = 0; i < msg.contentBlocks.length; i++) {
        const block = msg.contentBlocks[i];
        if (block.type === 'tool_use' && block.toolId === subagentId) {
          msg.contentBlocks[i] = {
            type: 'subagent',
            subagentId,
            mode: subagent.mode,
          };
          hasNormalizedSubagentBlock = true;
        } else if (block.type === 'subagent' && block.subagentId === subagentId && !block.mode) {
          block.mode = subagent.mode;
          hasNormalizedSubagentBlock = true;
        } else if (block.type === 'subagent' && block.subagentId === subagentId) {
          hasNormalizedSubagentBlock = true;
        }
      }

      if (!hasNormalizedSubagentBlock && hasTaskToolCall) {
        msg.contentBlocks.push({
          type: 'subagent',
          subagentId,
          mode: subagent.mode,
        });
      }

      attachedSubagentIds.add(subagentId);
    }
  }

  for (const [subagentId, subagent] of Object.entries(subagentData)) {
    if (attachedSubagentIds.has(subagentId)) continue;

    let anchor = [...messages].reverse().find((msg): msg is ChatMessage => msg.role === 'assistant');
    if (!anchor) {
      anchor = {
        id: `subagent-recovery-${subagentId}`,
        role: 'assistant',
        content: '',
        timestamp: subagent.completedAt ?? subagent.startedAt ?? Date.now(),
        contentBlocks: [],
      };
      messages.push(anchor);
    }

    ensureTaskToolCall(anchor, subagentId, subagent);

    anchor.contentBlocks = anchor.contentBlocks || [];
    const hasSubagentBlock = anchor.contentBlocks.some(
      block => block.type === 'subagent' && block.subagentId === subagentId,
    );
    if (!hasSubagentBlock) {
      anchor.contentBlocks.push({
        type: 'subagent',
        subagentId,
        mode: subagent.mode,
      });
    }
  }
}

function buildPersistedSubagentData(messages: ChatMessage[]): Record<string, SubagentInfo> {
  const result: Record<string, SubagentInfo> = {};

  for (const msg of messages) {
    if (msg.role !== 'assistant' || !msg.toolCalls) continue;

    for (const toolCall of msg.toolCalls) {
      if (!isClaudeSubagentToolName(toolCall.name) || !toolCall.subagent) continue;
      result[toolCall.subagent.id] = buildPersistedSubagent(toolCall.subagent);
    }
  }

  return result;
}

function sanitizePersistedSubagentData(
  subagentData: Record<string, SubagentInfo>,
): Record<string, SubagentInfo> {
  if (!isObjectRecord(subagentData)) return subagentData;
  return Object.fromEntries(
    Object.entries(subagentData).map(([id, subagent]) => [
      id,
      buildPersistedSubagent(subagent),
    ]),
  );
}

function stripToolResultImageData(result: string | undefined): string | undefined {
  if (!result?.includes('"base64"')) return result;

  try {
    let changed = false;
    const parsed: unknown = JSON.parse(result, (key, value: unknown) => {
      const next = omitToolResultImageData(key, value);
      if (next !== value) changed = true;
      return next;
    });
    return changed ? JSON.stringify(parsed) : result;
  } catch {
    return result;
  }
}

function buildPersistedSubagent(subagent: SubagentInfo): SubagentInfo {
  return sanitizePersistedSubagent(subagent) as SubagentInfo;
}

function sanitizePersistedSubagent(subagent: unknown): unknown {
  if (!isObjectRecord(subagent)) return subagent;

  const sanitized: Record<string, unknown> = { ...subagent };
  if (typeof sanitized.result === 'string') {
    sanitized.result = stripToolResultImageData(sanitized.result);
  }
  if (Array.isArray(sanitized.toolCalls)) {
    sanitized.toolCalls = sanitized.toolCalls.map((toolCall) => {
      if (!isObjectRecord(toolCall)) return toolCall;

      const sanitizedToolCall: Record<string, unknown> = { ...toolCall };
      if (typeof sanitizedToolCall.result === 'string') {
        sanitizedToolCall.result = stripToolResultImageData(sanitizedToolCall.result);
      }
      if ('subagent' in sanitizedToolCall) {
        sanitizedToolCall.subagent = sanitizePersistedSubagent(sanitizedToolCall.subagent);
      }
      return sanitizedToolCall;
    });
  }
  return sanitized;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeProviderState(
  providerState: ClaudeProviderState,
): Record<string, unknown> | undefined {
  const sanitizedEntries = Object.entries(providerState).filter(([, value]) => value !== undefined);
  if (sanitizedEntries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(sanitizedEntries);
}

export class ClaudeConversationHistoryService implements ProviderConversationHistoryService {
  private hydratedConversationIds = new Set<string>();
  private historyCacheKeysByConversation = new Map<string, string>();
  private pendingSessionLocationsByConversation = new Map<
    string,
    Map<string, SDKSessionLocation>
  >();
  private relocatedSessionPathsByConversation = new Map<string, Map<string, string>>();

  private getConversationSessionIds(conversation: Conversation): string[] {
    const state = getClaudeState(conversation.providerState);
    if (this.isPendingForkConversation(conversation)) {
      return [state.forkSource!.sessionId];
    }

    return [...new Set([
      ...(state.previousProviderSessionIds || []),
      state.providerSessionId ?? conversation.sessionId,
    ].filter((id): id is string => !!id))];
  }

  private synchronizeHistoryCache(
    conversation: Conversation,
    vaultPath: string,
    pathContext?: ProviderHistoryPathContext,
  ): void {
    const state = getClaudeState(conversation.providerState);
    const cacheKey = JSON.stringify([
      getSDKProjectsPath(pathContext),
      encodeVaultPathForSDK(vaultPath),
      this.getConversationSessionIds(conversation),
      conversation.resumeAtMessageId ?? null,
      state.forkSource?.resumeAt ?? null,
    ]);
    const previousKey = this.historyCacheKeysByConversation.get(conversation.id);
    if (previousKey !== undefined && previousKey !== cacheKey) {
      this.hydratedConversationIds.delete(conversation.id);
      this.pendingSessionLocationsByConversation.delete(conversation.id);
      this.relocatedSessionPathsByConversation.delete(conversation.id);
    }
    this.historyCacheKeysByConversation.set(conversation.id, cacheKey);
  }

  async getConversationSessionAvailability(
    conversation: Conversation,
    vaultPath: string | null,
    pathContext?: ProviderHistoryPathContext,
  ): Promise<ProviderConversationSessionAvailability> {
    const sessionId = this.resolveSessionIdForConversation(conversation);
    if (!vaultPath) {
      return 'unknown';
    }
    this.synchronizeHistoryCache(conversation, vaultPath, pathContext);
    if (!sessionId) return 'unknown';

    const location = await (pathContext
      ? locateSDKSession(vaultPath, sessionId, pathContext)
      : locateSDKSession(vaultPath, sessionId));
    this.pendingSessionLocationsByConversation.set(
      conversation.id,
      new Map([[sessionId, location]]),
    );
    if (location.availability === 'relocated' && location.sessionPath) {
      const relocatedSessionPaths = new Map(
        this.relocatedSessionPathsByConversation.get(conversation.id) ?? [],
      );
      relocatedSessionPaths.set(sessionId, location.sessionPath);
      this.relocatedSessionPathsByConversation.set(
        conversation.id,
        relocatedSessionPaths,
      );
    } else if (location.availability !== 'unknown') {
      const relocatedSessionPaths = new Map(
        this.relocatedSessionPathsByConversation.get(conversation.id) ?? [],
      );
      relocatedSessionPaths.delete(sessionId);
      if (relocatedSessionPaths.size > 0) {
        this.relocatedSessionPathsByConversation.set(
          conversation.id,
          relocatedSessionPaths,
        );
      } else {
        this.relocatedSessionPathsByConversation.delete(conversation.id);
      }
    }
    return location.availability;
  }

  async prepareRelocatedConversationSession(
    conversation: Conversation,
    vaultPath: string | null,
    pathContext?: ProviderHistoryPathContext,
  ): Promise<boolean> {
    const sessionId = this.resolveSessionIdForConversation(conversation);
    if (!vaultPath || !sessionId) {
      return false;
    }

    await this.hydrateConversationHistory(conversation, vaultPath, pathContext);
    if (!this.hydratedConversationIds.has(conversation.id)) {
      return false;
    }

    const state = { ...getClaudeState(conversation.providerState) };
    state.previousProviderSessionIds = [
      ...new Set([...(state.previousProviderSessionIds || []), sessionId]),
    ];
    delete state.providerSessionId;

    if (state.forkSource?.sessionId === sessionId) {
      conversation.resumeAtMessageId = state.forkSource.resumeAt;
      delete state.forkSource;
    }

    conversation.sessionId = null;
    conversation.providerState = sanitizeProviderState(state);
    return true;
  }

  async resolveMissingConversationSession(
    conversation: Conversation,
    vaultPath: string | null,
    missingProviderSessionId?: string,
    pathContext?: ProviderHistoryPathContext,
  ): Promise<'delete' | 'reset' | 'preserve'> {
    const currentSessionId = this.resolveSessionIdForConversation(conversation);
    if (
      !vaultPath
      || !currentSessionId
      || (missingProviderSessionId
        && missingProviderSessionId.toLowerCase() !== currentSessionId.toLowerCase())
    ) {
      return 'preserve';
    }

    this.synchronizeHistoryCache(conversation, vaultPath, pathContext);

    const sessionIds = this.getConversationSessionIds(conversation);
    const locations = await (pathContext
      ? locateSDKSessions(vaultPath, sessionIds, pathContext)
      : locateSDKSessions(vaultPath, sessionIds));
    const preservedSessionIds = sessionIds.filter(
      sessionId => locations.get(sessionId)?.availability !== 'missing',
    );
    if (preservedSessionIds.length === 0) {
      this.pendingSessionLocationsByConversation.delete(conversation.id);
      this.relocatedSessionPathsByConversation.delete(conversation.id);
      this.hydratedConversationIds.delete(conversation.id);
      return 'delete';
    }

    const state = { ...getClaudeState(conversation.providerState) };
    state.previousProviderSessionIds = preservedSessionIds;
    delete state.providerSessionId;
    if (state.forkSource?.sessionId === currentSessionId) {
      conversation.resumeAtMessageId = state.forkSource.resumeAt;
      delete state.forkSource;
    }

    conversation.sessionId = null;
    conversation.providerState = sanitizeProviderState(state);
    this.pendingSessionLocationsByConversation.delete(conversation.id);
    this.hydratedConversationIds.delete(conversation.id);
    return 'reset';
  }

  isPendingForkConversation(conversation: Conversation): boolean {
    const state = getClaudeState(conversation.providerState);
    return !!state.forkSource
      && !state.providerSessionId
      && !conversation.sessionId;
  }

  resolveSessionIdForConversation(conversation: Conversation | null): string | null {
    if (!conversation) return null;
    const state = getClaudeState(conversation.providerState);
    return state.providerSessionId ?? conversation.sessionId ?? state.forkSource?.sessionId ?? null;
  }

  buildForkProviderState(
    sourceSessionId: string,
    resumeAt: string,
    _sourceProviderState?: Record<string, unknown>,
  ): Record<string, unknown> {
    const state: ClaudeProviderState = {
      forkSource: { sessionId: sourceSessionId, resumeAt } satisfies ForkSource,
    };
    return state as Record<string, unknown>;
  }

  buildPersistedProviderState(
    conversation: Conversation,
  ): Record<string, unknown> | undefined {
    const providerState: ClaudeProviderState = {
      ...getClaudeState(conversation.providerState),
    };

    const subagentData = buildPersistedSubagentData(conversation.messages);
    if (Object.keys(subagentData).length > 0) {
      providerState.subagentData = subagentData;
    } else if (conversation.messages.length > 0) {
      delete providerState.subagentData;
    }

    return this.sanitizePersistedProviderState({ ...providerState });
  }

  sanitizePersistedProviderState(
    providerState: Record<string, unknown>,
  ): Record<string, unknown> | undefined {
    const sanitizedState = { ...providerState } as ClaudeProviderState;
    if (sanitizedState.subagentData) {
      sanitizedState.subagentData = sanitizePersistedSubagentData(sanitizedState.subagentData);
    }
    return sanitizeProviderState(sanitizedState);
  }

  async hydrateConversationHistory(
    conversation: Conversation,
    vaultPath: string | null,
    pathContext?: ProviderHistoryPathContext,
  ): Promise<void> {
    if (!vaultPath) {
      return;
    }
    this.synchronizeHistoryCache(conversation, vaultPath, pathContext);
    if (this.hydratedConversationIds.has(conversation.id) && conversation.messages.length > 0) return;

    const state = getClaudeState(conversation.providerState);
    const isPendingFork = this.isPendingForkConversation(conversation);
    const allSessionIds = this.getConversationSessionIds(conversation);

    if (allSessionIds.length === 0) {
      return;
    }

    const allSdkMessages: ChatMessage[] = [];
    let missingSessionCount = 0;
    let unknownSessionCount = 0;
    let errorCount = 0;
    let successCount = 0;
    const relocatedSessionPaths = new Map(
      this.relocatedSessionPathsByConversation.get(conversation.id) ?? [],
    );
    const cachedLocations = new Map(
      this.pendingSessionLocationsByConversation.get(conversation.id) ?? [],
    );
    this.pendingSessionLocationsByConversation.delete(conversation.id);
    const unresolvedSessionIds = allSessionIds.filter(
      id => !relocatedSessionPaths.has(id) && !cachedLocations.has(id),
    );
    const locatedSessions = await (pathContext
      ? locateSDKSessions(vaultPath, unresolvedSessionIds, pathContext)
      : locateSDKSessions(vaultPath, unresolvedSessionIds));
    const resolvedLocations = new Map([...cachedLocations, ...locatedSessions]);
    for (const [sessionId, location] of locatedSessions) {
      if (location.availability === 'relocated' && location.sessionPath) {
        relocatedSessionPaths.set(sessionId, location.sessionPath);
      }
    }
    if (relocatedSessionPaths.size > 0) {
      this.relocatedSessionPathsByConversation.set(conversation.id, relocatedSessionPaths);
    }

    const resumableSessionId = isPendingFork
      ? state.forkSource!.sessionId
      : (state.providerSessionId ?? conversation.sessionId);
    const checkpointSessionId = resumableSessionId
      ?? (conversation.resumeAtMessageId ? allSessionIds[allSessionIds.length - 1] : null);

    for (const sessionId of allSessionIds) {
      const relocatedSessionPath = relocatedSessionPaths.get(sessionId);
      const location = relocatedSessionPath
        ? { availability: 'relocated' as const, sessionPath: relocatedSessionPath }
        : resolvedLocations.get(sessionId) ?? { availability: 'unknown' as const };
      if (!location.sessionPath) {
        if (location.availability === 'missing') {
          missingSessionCount++;
        } else {
          unknownSessionCount++;
        }
        continue;
      }

      const isCheckpointSession = sessionId === checkpointSessionId;
      const truncateAt = isCheckpointSession
        ? (isPendingFork ? state.forkSource!.resumeAt : conversation.resumeAtMessageId)
        : undefined;
      const sessionPathOverride = relocatedSessionPaths.get(sessionId);
      const result = pathContext
        ? await loadSDKSessionMessages(
          vaultPath,
          sessionId,
          truncateAt,
          sessionPathOverride,
          pathContext,
        )
        : sessionPathOverride
          ? await loadSDKSessionMessages(vaultPath, sessionId, truncateAt, sessionPathOverride)
          : await loadSDKSessionMessages(vaultPath, sessionId, truncateAt);

      if (result.error) {
        errorCount++;
        continue;
      }

      successCount++;
      allSdkMessages.push(...result.messages);
    }

    const allSessionsMissing = missingSessionCount === allSessionIds.length;
    if (successCount === 0 || allSessionsMissing) {
      return;
    }

    const filteredSdkMessages = allSdkMessages.filter(msg => !msg.isRebuiltContext);

    const complete = errorCount === 0 && unknownSessionCount === 0 && missingSessionCount === 0;
    const cached = retainUnconfirmedCachedMessages(conversation.messages, filteredSdkMessages, complete);
    const merged = mergeHistoryMessages(cached, filteredSdkMessages);

    if (state.subagentData) {
      await enrichAsyncSubagentToolCalls(
        state.subagentData,
        vaultPath,
        allSessionIds,
        relocatedSessionPaths,
        pathContext,
      );
      applySubagentData(merged, state.subagentData);
    }

    conversation.messages = merged;
    if (complete) {
      this.hydratedConversationIds.add(conversation.id);
    }
  }

  async deleteConversationSession(
    conversation: Conversation,
    vaultPath: string | null,
    pathContext?: ProviderHistoryPathContext,
  ): Promise<void> {
    this.pendingSessionLocationsByConversation.delete(conversation.id);
    this.relocatedSessionPathsByConversation.delete(conversation.id);
    this.hydratedConversationIds.delete(conversation.id);
    this.historyCacheKeysByConversation.delete(conversation.id);
    const state = getClaudeState(conversation.providerState);
    const sessionId = state.providerSessionId ?? conversation.sessionId;
    if (!vaultPath || !sessionId) {
      return;
    }

    if (pathContext) {
      await deleteSDKSession(vaultPath, sessionId, pathContext);
    } else {
      await deleteSDKSession(vaultPath, sessionId);
    }
  }
}
