import * as fsp from 'node:fs/promises';
import * as zlib from 'node:zlib';

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

import { forEachJSONLLine } from '@/utils/jsonlFile';

import type { ChatMessage, ContentBlock, ImageAttachment, ToolCallInfo } from '../../../core/types';
import { extractUserDisplayContent } from '../../../utils/context';
import {
  buildImageAttachmentFromBase64,
  parseImageDataUri,
} from '../../../utils/imageAttachment';
import {
  extractCodexUserVisibleText,
  joinCodexUserTextParts,
} from '../codexUserText';
import { stripCodexMemoryCitationMarkup } from '../normalization/CodexMemoryCitation';
import {
  appendCodexCommandOutput,
  codexToolRequestsMatch,
  decodeCodexExecEnvelopeCalls,
  extractCodexExecCellId,
  isCodexInternalToolCall,
  isCodexSilentWriteStdinCall,
  isCodexToolOutputError,
  normalizeCodexMcpToolInput,
  normalizeCodexMcpToolName,
  normalizeCodexMcpToolState,
  normalizeCodexToolCall,
  normalizeCodexToolInput,
  normalizeCodexToolName,
  normalizeCodexToolResult,
  parseCodexArguments,
  readCodexExecCellIdArgument,
  stringifyCodexToolOutput,
} from '../normalization/codexToolNormalization';

interface CodexEvent {
  type: string;
  thread_id?: string;
  item?: CodexItem;
  usage?: { input_tokens: number; cached_input_tokens: number; output_tokens: number };
  error?: { message: string };
  message?: string;
}

interface CodexItem {
  id: string;
  type: string;
  text?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number;
  status?: string;
  changes?: Array<{ path: string; kind: string }>;
  query?: string;
  message?: string;
  server?: string;
  tool?: string;
}

interface PersistedMessagePart {
  image_url?: string | { url?: string };
  type?: string;
  text?: string;
}

interface PersistedMessagePayload {
  type: 'message';
  role?: string;
  content?: PersistedMessagePart[];
}

interface PersistedReasoningPayload {
  type: 'reasoning';
  summary?: Array<{ type?: string; text?: string } | string>;
  content?: Array<{ type?: string; text?: string } | string>;
  text?: string;
}

interface PersistedToolCallPayload {
  type: 'function_call' | 'custom_tool_call';
  name?: string;
  arguments?: string;
  call_id?: string;
  input?: string;
}

interface PersistedToolCallOutputPayload {
  type: 'function_call_output' | 'custom_tool_call_output';
  call_id?: string;
  output?: string | unknown[];
}

interface PersistedWebSearchCallPayload {
  type: 'web_search_call';
  action?: {
    type?: string;
    query?: string;
    queries?: string[];
    url?: string;
    pattern?: string;
  };
  status?: string;
  call_id?: string;
}

interface PersistedMcpToolCallPayload {
  type: 'mcp_tool_call';
  server?: string;
  tool?: string;
  call_id?: string;
  status?: string;
  arguments?: string | Record<string, unknown>;
  result?: { content?: Array<{ type?: string; text?: string }> } | null;
  error?: string | null;
  duration_ms?: number | null;
}

interface PersistedEventPayload {
  item?: {
    type?: string;
    kind?: string;
    id?: string;
    delivery?: string;
    questions?: unknown[];
    query?: string;
    action?: unknown;
    results?: unknown;
    command?: unknown;
    cwd?: unknown;
    parsed_cmd?: Array<{ cmd?: unknown }>;
    aggregated_output?: unknown;
    exit_code?: unknown;
  };
  type?: string;
  text?: string;
  message?: string;
  memory_citation?: unknown;
  memoryCitation?: unknown;
}

interface PersistedCompactionPayload {
  type: 'compaction';
  encrypted_content?: string;
}

export interface CodexSessionRecord {
  timestamp: number;
  type?: string;
  event?: CodexEvent;
  payload?: PersistedPayload;
}

export type ParsedSessionRecord = CodexSessionRecord;

// ---------------------------------------------------------------------------
// Multi-bubble turn model
// ---------------------------------------------------------------------------

interface CodexAssistantBubble {
  contentChunks: string[];
  thinkingChunks: string[];
  toolCalls: ToolCallInfo[];
  toolIndexesById: Map<string, number>;
  contentBlocks: ContentBlock[];
  startedAt: number;
  lastEventAt: number;
  interrupted: boolean;
}

interface CodexTurnState {
  id: string;
  serverTurnId?: string;
  startedAt: number;
  completedAt?: number;
  completed?: boolean;
  lastEventAt: number;
  userTimestamp?: number;
  userChunks: string[];
  userImages: ImageAttachment[];
  assistantBubbles: CodexAssistantBubble[];
  activeBubbleIndex: number | null;
}

type PersistedPayload =
  | PersistedMessagePayload
  | PersistedReasoningPayload
  | PersistedToolCallPayload
  | PersistedToolCallOutputPayload
  | PersistedWebSearchCallPayload
  | PersistedMcpToolCallPayload
  | PersistedCompactionPayload
  | PersistedEventPayload
  | undefined;

// ---------------------------------------------------------------------------
// Turn/bubble lifecycle helpers
// ---------------------------------------------------------------------------

function newBubble(timestamp: number): CodexAssistantBubble {
  return {
    contentChunks: [],
    thinkingChunks: [],
    toolCalls: [],
    toolIndexesById: new Map(),
    contentBlocks: [],
    startedAt: timestamp,
    lastEventAt: timestamp,
    interrupted: false,
  };
}

function newTurnState(id: string, timestamp: number): CodexTurnState {
  return {
    id,
    startedAt: timestamp,
    lastEventAt: timestamp,
    userChunks: [],
    userImages: [],
    assistantBubbles: [],
    activeBubbleIndex: null,
  };
}

function createPersistedParseContext(): PersistedParseContext {
  return {
    turns: new Map(),
    turnOrder: [],
    currentTurnId: null,
    toolCallToTurn: new Map(),
    suppressedToolOutputIds: new Set(),
    terminalSessionToCommandId: new Map(),
    pendingStdinCalls: new Map(),
    execCellToCommandId: new Map(),
    execEnvelopeToolCallIds: new Map(),
    nativeCallCandidates: [],
    withheldExecCellIds: new Set(),
    observedNativeItemIds: new Set(),
    withheldExecOutputCallIds: new Set(),
    failedExecCallIds: new Set(),
    waitCallToCommand: new Map(),
    turnCounter: 0,
  };
}

function ensureTurn(
  turns: Map<string, CodexTurnState>,
  turnOrder: string[],
  preferredTurnId: string,
  currentTurnId: string | null,
  timestamp: number,
): CodexTurnState {
  const id = currentTurnId ?? preferredTurnId;
  const existing = turns.get(id);
  if (existing) {
    if (timestamp > 0 && timestamp > existing.lastEventAt) {
      existing.lastEventAt = timestamp;
    }
    return existing;
  }

  const turn = newTurnState(id, timestamp);
  turns.set(id, turn);
  turnOrder.push(id);
  return turn;
}

function ensureAssistantBubble(turn: CodexTurnState, timestamp: number): CodexAssistantBubble {
  if (turn.activeBubbleIndex !== null) {
    const bubble = turn.assistantBubbles[turn.activeBubbleIndex];
    if (timestamp > 0 && timestamp > bubble.lastEventAt) {
      bubble.lastEventAt = timestamp;
    }
    return bubble;
  }

  const bubble = newBubble(timestamp);
  turn.assistantBubbles.push(bubble);
  turn.activeBubbleIndex = turn.assistantBubbles.length - 1;
  return bubble;
}

function closeAssistantBubble(turn: CodexTurnState): void {
  turn.activeBubbleIndex = null;
}

function pushToolInvocation(bubble: CodexAssistantBubble, toolCall: ToolCallInfo): void {
  const existingIndex = bubble.toolIndexesById.get(toolCall.id);
  if (existingIndex !== undefined) {
    bubble.toolCalls[existingIndex] = toolCall;
    return;
  }

  bubble.toolIndexesById.set(toolCall.id, bubble.toolCalls.length);
  bubble.toolCalls.push(toolCall);
  bubble.contentBlocks.push({ type: 'tool_use', toolId: toolCall.id });
}

function appendUniqueChunk(chunks: string[], value: string): void {
  const trimmed = value.trim();
  if (!trimmed) return;
  if (chunks[chunks.length - 1] === trimmed) return;
  chunks.push(trimmed);
}

function appendOrderedTextChunk(
  bubble: CodexAssistantBubble,
  type: 'text' | 'thinking',
  value: string,
): void {
  const trimmed = value.trim();
  if (!trimmed) return;

  const chunks = type === 'text' ? bubble.contentChunks : bubble.thinkingChunks;
  const lastBlock = bubble.contentBlocks[bubble.contentBlocks.length - 1];
  if (lastBlock?.type === type) {
    if (chunks[chunks.length - 1] === trimmed) return;

    chunks.push(trimmed);
    lastBlock.content = `${lastBlock.content}\n\n${trimmed}`;
    return;
  }

  chunks.push(trimmed);
  bubble.contentBlocks.push({ type, content: trimmed });
}

function replaceLatestOrderedTextChunk(
  bubble: CodexAssistantBubble,
  type: 'text' | 'thinking',
  value: string,
): void {
  const trimmed = value.trim();
  if (!trimmed) return;

  const chunks = type === 'text' ? bubble.contentChunks : bubble.thinkingChunks;
  const lastBlock = bubble.contentBlocks[bubble.contentBlocks.length - 1];
  if (lastBlock?.type !== type || chunks.length === 0) {
    appendOrderedTextChunk(bubble, type, trimmed);
    return;
  }

  chunks[chunks.length - 1] = trimmed;
  lastBlock.content = trimmed;
}

function appendUserChunk(turn: CodexTurnState, value: string, timestamp: number): void {
  const chunkCountBefore = turn.userChunks.length;
  appendUniqueChunk(turn.userChunks, value);

  if (turn.userChunks.length > chunkCountBefore && !turn.userTimestamp && timestamp > 0) {
    turn.userTimestamp = timestamp;
  }
}

function appendUserImages(
  turn: CodexTurnState,
  content: PersistedMessagePart[] | undefined,
  timestamp: number,
): void {
  const images = extractMessageImages(content, `codex-img-${turn.id}`, turn.userImages.length);
  if (images.length === 0) {
    return;
  }

  turn.userImages.push(...images);
  if (!turn.userTimestamp && timestamp > 0) {
    turn.userTimestamp = timestamp;
  }
}

// ---------------------------------------------------------------------------
// Legacy TurnAccumulator — kept for the `event` wrapper format
// ---------------------------------------------------------------------------

interface TurnAccumulator {
  assistantText: string;
  thinkingText: string;
  toolCalls: ToolCallInfo[];
  contentBlocks: ContentBlock[];
  interrupted: boolean;
  timestamp: number;
}

function newTurn(timestamp = 0): TurnAccumulator {
  return {
    assistantText: '',
    thinkingText: '',
    toolCalls: [],
    contentBlocks: [],
    interrupted: false,
    timestamp,
  };
}

function flushTurn(turn: TurnAccumulator, messages: ChatMessage[], msgIndex: number): number {
  if (
    !turn.assistantText &&
    !turn.thinkingText &&
    turn.toolCalls.length === 0
  ) {
    return msgIndex;
  }

  const msg: ChatMessage = {
    id: `codex-msg-${msgIndex}`,
    role: 'assistant',
    content: turn.assistantText,
    timestamp: turn.timestamp || Date.now(),
    toolCalls: turn.toolCalls.length > 0 ? turn.toolCalls : undefined,
    contentBlocks: turn.contentBlocks.length > 0 ? turn.contentBlocks : undefined,
  };

  if (turn.interrupted) {
    msg.isInterrupt = true;
  }

  messages.push(msg);
  return msgIndex + 1;
}

function setTextBlock(turn: TurnAccumulator, content: string): void {
  const index = turn.contentBlocks.findIndex(block => block.type === 'text');
  if (index === -1) {
    turn.contentBlocks.push({ type: 'text', content });
    return;
  }

  turn.contentBlocks[index] = { type: 'text', content };
}

function setThinkingBlock(turn: TurnAccumulator, content: string): void {
  const normalized = content.trim();
  if (!normalized) {
    return;
  }

  turn.thinkingText = normalized;

  const index = turn.contentBlocks.findIndex(block => block.type === 'thinking');
  if (index === -1) {
    turn.contentBlocks.push({ type: 'thinking', content: normalized });
    return;
  }

  turn.contentBlocks[index] = { type: 'thinking', content: normalized };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function parseTimestamp(value: unknown): number {
  if (typeof value !== 'string') {
    return 0;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseSessionRecord(line: string): CodexSessionRecord | null {
  let parsed: {
    timestamp?: string;
    type?: string;
    event?: CodexEvent;
    payload?: PersistedPayload;
  };

  try {
    parsed = JSON.parse(line) as typeof parsed;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  return {
    timestamp: parseTimestamp(parsed.timestamp),
    type: parsed.type,
    event: parsed.event,
    payload: parsed.payload,
  };
}

function extractMessageText(content: PersistedMessagePart[] | undefined): string {
  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map(part => (typeof part?.text === 'string' ? part.text : ''))
    .join('');
}

function extractUserMessageText(content: PersistedMessagePart[] | undefined): string {
  if (!Array.isArray(content)) {
    return '';
  }

  return joinCodexUserTextParts(
    content.map(part => (typeof part?.text === 'string' ? part.text : '')),
  );
}

function extractMessageImages(
  content: PersistedMessagePart[] | undefined,
  idPrefix: string,
  startIndex = 0,
): ImageAttachment[] {
  if (!Array.isArray(content)) {
    return [];
  }

  const images: ImageAttachment[] = [];
  for (const part of content) {
    if (part?.type !== 'input_image') {
      continue;
    }

    const imageUrl = typeof part.image_url === 'string'
      ? part.image_url
      : typeof part.image_url?.url === 'string'
        ? part.image_url.url
        : null;
    const parsed = parseImageDataUri(imageUrl);
    if (!parsed) {
      continue;
    }

    const image = buildImageAttachmentFromBase64({
      data: parsed.data,
      id: `${idPrefix}-${startIndex + images.length}`,
      mediaType: parsed.mediaType,
      name: `image-${startIndex + images.length + 1}.${parsed.mediaType.split('/')[1]}`,
    });
    if (image) {
      images.push(image);
    }
  }

  return images;
}

function hasMessageImages(content: PersistedMessagePart[] | undefined): boolean {
  if (!Array.isArray(content)) {
    return false;
  }

  return content.some((part) => {
    if (part?.type !== 'input_image') {
      return false;
    }
    const imageUrl = typeof part.image_url === 'string'
      ? part.image_url
      : typeof part.image_url?.url === 'string'
        ? part.image_url.url
        : null;
    return parseImageDataUri(imageUrl) !== null;
  });
}

function joinTextParts(parts: Array<{ text?: string } | string>): string {
  return parts
    .map((part) => {
      if (typeof part === 'string') return part;
      return typeof part?.text === 'string' ? part.text : '';
    })
    .map(part => part.trim())
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

function extractReasoningText(payload: PersistedReasoningPayload | PersistedEventPayload): string {
  if ('summary' in payload && Array.isArray(payload.summary) && payload.summary.length > 0) {
    return joinTextParts(payload.summary);
  }

  if ('content' in payload && Array.isArray(payload.content) && payload.content.length > 0) {
    return joinTextParts(payload.content);
  }

  return typeof payload.text === 'string' ? payload.text.trim() : '';
}

// ---------------------------------------------------------------------------
// Legacy event wrapper processing (kept as-is)
// ---------------------------------------------------------------------------

function processLegacyItem(
  eventType: string,
  item: CodexItem,
  turn: TurnAccumulator,
): void {
  switch (item.type) {
    case 'agent_message':
      if (eventType === 'item.completed' || eventType === 'item.updated') {
        if (item.text) {
          const visibleText = stripCodexMemoryCitationMarkup(item.text);
          turn.assistantText = visibleText;
          setTextBlock(turn, visibleText);
        }
      }
      break;

    case 'reasoning':
      if (eventType === 'item.completed' || eventType === 'item.updated') {
        if (item.text) {
          setThinkingBlock(turn, item.text);
        }
      }
      break;

    case 'command_execution':
      if (eventType === 'item.started') {
        turn.toolCalls.push({
          id: item.id,
          name: normalizeCodexToolName(item.type),
          input: normalizeCodexToolInput(item.type, { command: item.command ?? '' }),
          status: 'running',
        });
        turn.contentBlocks.push({ type: 'tool_use', toolId: item.id });
      } else if (eventType === 'item.completed') {
        const tc = turn.toolCalls.find(tool => tool.id === item.id);
        if (tc) {
          const rawOutput = item.aggregated_output ?? '';
          tc.result = normalizeCodexToolResult(tc.name, rawOutput);
          tc.status = item.exit_code === 0 ? 'completed' : 'error';
        }
      }
      break;

    case 'file_change': {
      const changes = item.changes ?? [];
      if (eventType === 'item.started' || eventType === 'item.completed') {
        const existing = turn.toolCalls.find(tool => tool.id === item.id);
        if (!existing) {
          const paths = changes.map(change => `${change.kind}: ${change.path}`).join(', ');
          turn.toolCalls.push({
            id: item.id,
            name: normalizeCodexToolName('file_change'),
            input: { changes },
            status: item.status === 'completed' ? 'completed' : 'error',
            result: paths ? `Applied: ${paths}` : 'Applied',
          });
          turn.contentBlocks.push({ type: 'tool_use', toolId: item.id });
        } else if (eventType === 'item.completed') {
          existing.status = item.status === 'completed' ? 'completed' : 'error';
        }
      }
      break;
    }

    case 'web_search':
      if (eventType === 'item.started') {
        turn.toolCalls.push({
          id: item.id,
          name: normalizeCodexToolName(item.type),
          input: normalizeCodexToolInput(item.type, { query: item.query ?? '' }),
          status: 'running',
        });
        turn.contentBlocks.push({ type: 'tool_use', toolId: item.id });
      } else if (eventType === 'item.completed') {
        const tc = turn.toolCalls.find(tool => tool.id === item.id);
        if (tc) {
          tc.result = 'Search complete';
          tc.status = 'completed';
        }
      }
      break;

    case 'mcp_tool_call':
      if (eventType === 'item.started') {
        const server = item.server ?? '';
        const tool = item.tool ?? '';
        turn.toolCalls.push({
          id: item.id,
          name: `mcp__${server}__${tool}`,
          input: {},
          status: 'running',
        });
        turn.contentBlocks.push({ type: 'tool_use', toolId: item.id });
      } else if (eventType === 'item.completed') {
        const tc = turn.toolCalls.find(tool => tool.id === item.id);
        if (tc) {
          tc.status = item.status === 'completed' ? 'completed' : 'error';
          tc.result = item.status === 'completed' ? 'Completed' : 'Failed';
        }
      }
      break;

    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Persisted-format (response_item) processing — with bubble model
// ---------------------------------------------------------------------------

interface PersistedNativeCall {
  /** Omitted when the call's own output is authoritative; it still prevents ambiguous matches. */
  toolCallId?: string;
  /** An opaque script may issue any request, so it blocks correlation until the turn ends. */
  request: { name: string; input: Record<string, unknown> } | null;
}

interface PersistedParseContext {
  turns: Map<string, CodexTurnState>;
  turnOrder: string[];
  currentTurnId: string | null;
  toolCallToTurn: Map<string, { turnId: string; bubbleIndex: number }>;
  suppressedToolOutputIds: Set<string>;
  terminalSessionToCommandId: Map<string, string>;
  pendingStdinCalls: Map<string, { parentCallId?: string }>;
  execCellToCommandId: Map<string, string>;
  execEnvelopeToolCallIds: Map<string, string[]>;
  nativeCallCandidates: PersistedNativeCall[];
  withheldExecCellIds: Set<string>;
  observedNativeItemIds: Set<string>;
  workingDirectory?: string;
  withheldExecOutputCallIds: Set<string>;
  failedExecCallIds: Set<string>;
  waitCallToCommand: Map<string, { commandCallId: string; cellId: string }>;
  turnCounter: number;
}

function nextTurnId(ctx: PersistedParseContext): string {
  ctx.turnCounter += 1;
  return `turn-${ctx.turnCounter}`;
}

function processPersistedToolCall(
  payload: PersistedToolCallPayload,
  timestamp: number,
  ctx: PersistedParseContext,
): void {
  const callId = payload.call_id;
  if (!callId) return;

  const rawArgs = payload.arguments ?? payload.input;
  const parsedArgs = parseCodexArguments(rawArgs);
  const normalized = normalizeCodexToolCall(payload.name, parsedArgs);
  const execEnvelopeCalls = payload.name === 'exec'
    ? decodeCodexExecEnvelopeCalls(parsedArgs)
    : null;
  // Script output is not attributed per call, so internal values cannot be separated from it.
  if (execEnvelopeCalls?.some(call => isCodexInternalToolCall(call.rawName))) ctx.withheldExecOutputCallIds.add(callId);
  if (execEnvelopeCalls?.every(call => isCodexInternalToolCall(call.rawName))) {
    ctx.suppressedToolOutputIds.add(callId);
    return;
  }
  const failedScript = payload.name === 'exec' && ctx.failedExecCallIds.has(callId);
  if (payload.name === 'exec' && !execEnvelopeCalls) {
    ctx.nativeCallCandidates.push({ request: null });
  }
  const candidates = execEnvelopeCalls ?? [{ ...normalized, rawInput: parsedArgs }];
  candidates.forEach(({ name, input, rawInput }, index) => {
    if (name !== 'Bash' && name !== 'WebSearch') return;
    // Direct/single command outputs own their result, but omitting them would
    // make an identical request in another script appear uniquely correlated.
    const toolCallId = execEnvelopeCalls && !failedScript && (name === 'WebSearch' || execEnvelopeCalls.length > 1)
      ? (execEnvelopeCalls.length > 1 ? `${callId}:${index + 1}` : callId)
      : undefined;
    if (name === 'Bash') {
      const requestedDirectory = rawInput.workdir ?? rawInput.cwd ?? rawInput.workingDirectory;
      const workingDirectory = resolvePersistedWorkingDirectory(requestedDirectory, ctx.workingDirectory);
      if (workingDirectory === null) {
        ctx.nativeCallCandidates.push({ request: null });
        return;
      }
      ctx.nativeCallCandidates.push({ toolCallId, request: { name, input: {
        ...input,
        workingDirectory,
      } } });
    } else {
      ctx.nativeCallCandidates.push({ toolCallId, request: { name, input } });
    }
  });
  // A failed script can stop before later calls or emit partial results. Its
  // source and output do not establish which nested tools actually executed.
  if (failedScript) {
    pushPersistedNormalizedToolCall(callId, { name: 'exec', input: parsedArgs }, timestamp, ctx);
    return;
  }
  if (execEnvelopeCalls && execEnvelopeCalls.length > 1) {
    const toolCallIds = execEnvelopeCalls.map((call, index) => {
      const nestedCallId = `${callId}:${index + 1}`;
      // A nested poll has no individual result in the script's aggregate output.
      if (isCodexSilentWriteStdinCall(call.name, call.input)) return nestedCallId;
      if (isCodexInternalToolCall(call.rawName)) ctx.suppressedToolOutputIds.add(nestedCallId);
      else processPersistedNormalizedToolCall(nestedCallId, call, timestamp, ctx);
      return nestedCallId;
    });
    ctx.execEnvelopeToolCallIds.set(callId, toolCallIds);
    if (!ctx.withheldExecOutputCallIds.has(callId)) {
      pushPersistedNormalizedToolCall(callId, { name: 'exec', input: parsedArgs }, timestamp, ctx);
    }
    return;
  }

  processPersistedNormalizedToolCall(callId, normalized, timestamp, ctx);
}

function processPersistedNormalizedToolCall(
  callId: string,
  normalized: { name: string; input: Record<string, unknown> },
  timestamp: number,
  ctx: PersistedParseContext,
): void {
  if (normalized.name === 'wait') {
    const cellId = readCodexExecCellIdArgument(normalized.input);
    if (cellId && ctx.withheldExecCellIds.delete(cellId)) {
      ctx.withheldExecOutputCallIds.add(callId);
      ctx.suppressedToolOutputIds.add(callId);
      return;
    }
    const commandCallId = cellId ? ctx.execCellToCommandId.get(cellId) : undefined;
    if (cellId && commandCallId) {
      ctx.waitCallToCommand.set(callId, { commandCallId, cellId });
      return;
    }
  }

  if (isCodexSilentWriteStdinCall(normalized.name, normalized.input)) {
    const terminalSessionId = readTerminalSessionIdArgument(normalized.input);
    const parentCallId = terminalSessionId
      ? ctx.terminalSessionToCommandId.get(terminalSessionId)
      : undefined;
    ctx.pendingStdinCalls.set(callId, { parentCallId });
    if (parentCallId) return;
    // Without a command owner, the poll's own call ID retains its output and
    // transcript position. Only an explicit empty acknowledgement removes it.
  }

  pushPersistedNormalizedToolCall(callId, normalized, timestamp, ctx);
}

function pushPersistedNormalizedToolCall(
  callId: string,
  normalized: { name: string; input: Record<string, unknown> },
  timestamp: number,
  ctx: PersistedParseContext,
): void {
  const turn = ensureTurn(
    ctx.turns,
    ctx.turnOrder,
    nextTurnId(ctx),
    ctx.currentTurnId,
    timestamp,
  );
  const bubble = ensureAssistantBubble(turn, timestamp);

  const toolCall: ToolCallInfo = {
    id: callId,
    name: normalized.name,
    input: normalized.input,
    status: 'running',
  };

  pushToolInvocation(bubble, toolCall);

  ctx.toolCallToTurn.set(callId, {
    turnId: turn.id,
    bubbleIndex: turn.activeBubbleIndex!,
  });
}

function processPersistedToolOutput(
  payload: PersistedToolCallOutputPayload,
  timestamp: number,
  ctx: PersistedParseContext,
): void {
  const callId = payload.call_id;
  if (!callId) return;

  // output can be a string or an array (e.g. view_image returns image objects)
  const rawOutput = stringifyCodexToolOutput(payload.output);

  const execEnvelopeToolCallIds = ctx.execEnvelopeToolCallIds.get(callId);
  if (execEnvelopeToolCallIds) {
    applyPersistedExecEnvelopeOutput(
      callId,
      execEnvelopeToolCallIds,
      payload.output,
      rawOutput,
      ctx,
      ctx.withheldExecOutputCallIds.has(callId),
    );
    ctx.execEnvelopeToolCallIds.delete(callId);
    return;
  }

  const waitCall = ctx.waitCallToCommand.get(callId);
  if (waitCall) {
    const parentToolCall = findPersistedToolCallById(ctx, waitCall.commandCallId);
    ctx.execCellToCommandId.delete(waitCall.cellId);
    if (parentToolCall) {
      applyPersistedToolOutput(parentToolCall, payload.output, rawOutput, ctx);
    }
    ctx.waitCallToCommand.delete(callId);
    return;
  }

  const pendingStdinCall = ctx.pendingStdinCalls.get(callId);
  if (pendingStdinCall) {
    ctx.pendingStdinCalls.delete(callId);
    if (pendingStdinCall.parentCallId) {
      const parentToolCall = findPersistedToolCallById(ctx, pendingStdinCall.parentCallId);
      if (parentToolCall) {
        applyPersistedToolOutput(parentToolCall, payload.output, rawOutput, ctx, {
          allowImplicitCommandCompletion: false,
        });
      }
      return;
    }
    const acknowledgement = normalizeCodexToolResult('exec', rawOutput).trim();
    if (!extractCodexExecCellId(rawOutput) && (!acknowledgement || acknowledgement === 'Input sent.')) {
      removePersistedToolCall(ctx, callId);
      return;
    }
  }

  if (ctx.suppressedToolOutputIds.delete(callId)) {
    return;
  }

  // Cross-turn resolution: look up where the tool call was originally pushed
  const origin = ctx.toolCallToTurn.get(callId);
  if (origin) {
    const originTurn = ctx.turns.get(origin.turnId);
    if (originTurn && origin.bubbleIndex < originTurn.assistantBubbles.length) {
      const originBubble = originTurn.assistantBubbles[origin.bubbleIndex];
      const existing = originBubble.toolCalls.find(tool => tool.id === callId);
      if (existing) {
        if (ctx.withheldExecOutputCallIds.has(callId)) existing.status = isCodexToolOutputError(rawOutput) ? 'error' : 'completed';
        else applyPersistedToolOutput(existing, payload.output, rawOutput, ctx);
        return;
      }
    }
  }

  if (payload.type === 'custom_tool_call_output') {
    return;
  }

  // Fallback: push orphan entry into current turn
  const turn = ensureTurn(ctx.turns, ctx.turnOrder, nextTurnId(ctx), ctx.currentTurnId, timestamp);
  const bubble = ensureAssistantBubble(turn, timestamp);
  const normalizedResult = normalizeCodexToolResult('tool', rawOutput);

  pushToolInvocation(bubble, {
    id: callId,
    name: 'tool',
    input: {},
    status: isCodexToolOutputError(rawOutput) ? 'error' : 'completed',
    result: normalizedResult,
  });
}

/** Claims the open script call a native item completes, when its request identifies exactly one. */
function claimPersistedExecCall(
  name: string,
  nativeInputs: Record<string, unknown>[],
  ctx: PersistedParseContext,
): ToolCallInfo | null {
  const matches = ctx.nativeCallCandidates.filter(({ request }) => !request || (request.name === name
    && nativeInputs.some(input => codexToolRequestsMatch(name, request.input, input))));
  if (matches.length !== 1 || !matches[0].request) return null;
  const [call] = matches;
  const toolCall = call.toolCallId ? findPersistedToolCallById(ctx, call.toolCallId) : null;
  // A decoded command can execute repeatedly inside a script. Retain its
  // request so a later identical command never appears falsely unique.
  if (name === 'Bash') call.toolCallId = undefined;
  else ctx.nativeCallCandidates.splice(ctx.nativeCallCandidates.indexOf(call), 1);
  return toolCall;
}

/** Undefined means absent; null means unresolvable and cannot establish native ownership. */
function resolvePersistedWorkingDirectory(directory: unknown, baseDirectory?: string): string | null | undefined {
  try {
    if (typeof directory !== 'string' || !directory) return baseDirectory && path.resolve(baseDirectory);
    const localDirectory = directory.startsWith('file:') ? fileURLToPath(directory) : directory;
    return path.resolve(baseDirectory ?? '', localDirectory);
  } catch {
    return null;
  }
}

function applyPersistedNativeExecItem(item: NonNullable<PersistedEventPayload['item']>, ctx: PersistedParseContext): void {
  if (item.id) {
    if (ctx.observedNativeItemIds.has(item.id)) return;
    ctx.observedNativeItemIds.add(item.id);
  }
  const commands = [item.parsed_cmd?.[0]?.cmd, Array.isArray(item.command) ? item.command.at(-1) : item.command]
    .filter((command): command is string => typeof command === 'string' && command.length > 0);
  const workingDirectory = resolvePersistedWorkingDirectory(item.cwd);
  if (workingDirectory === null) return;
  const toolCall = claimPersistedExecCall('Bash', commands.map(command => ({ command, workingDirectory })), ctx);
  if (!toolCall || typeof item.aggregated_output !== 'string') return;
  toolCall.result = item.aggregated_output;
  if (typeof item.exit_code === 'number') toolCall.status = item.exit_code === 0 ? 'completed' : 'error';
}

function findPersistedToolCallById(ctx: PersistedParseContext, callId: string): ToolCallInfo | null {
  const origin = ctx.toolCallToTurn.get(callId);
  if (!origin) {
    return null;
  }

  const turn = ctx.turns.get(origin.turnId);
  if (!turn || origin.bubbleIndex >= turn.assistantBubbles.length) {
    return null;
  }

  return turn.assistantBubbles[origin.bubbleIndex].toolCalls.find(tool => tool.id === callId) ?? null;
}

function removePersistedToolCall(ctx: PersistedParseContext, callId: string): void {
  const origin = ctx.toolCallToTurn.get(callId);
  if (!origin) return;
  const bubble = ctx.turns.get(origin.turnId)?.assistantBubbles[origin.bubbleIndex];
  if (!bubble) return;
  bubble.toolCalls = bubble.toolCalls.filter(tool => tool.id !== callId);
  bubble.contentBlocks = bubble.contentBlocks.filter(block => block.type !== 'tool_use' || block.toolId !== callId);
  bubble.toolIndexesById.clear();
  bubble.toolCalls.forEach((tool, index) => bubble.toolIndexesById.set(tool.id, index));
  ctx.toolCallToTurn.delete(callId);
}

function applyPersistedExecEnvelopeOutput(
  envelopeCallId: string,
  toolCallIds: string[],
  rawOutputValue: string | unknown[] | undefined,
  rawOutputText: string,
  ctx: PersistedParseContext,
  withholdsOutput: boolean,
): void {
  const toolCalls = toolCallIds
    .map(toolCallId => findPersistedToolCallById(ctx, toolCallId))
    .filter((toolCall): toolCall is ToolCallInfo => toolCall !== null);

  // Output parts follow emission order, not call order. Keep them on the script.
  const isError = isCodexToolOutputError(rawOutputText);
  for (const toolCall of toolCalls) {
    // Calls completed by their native item keep its status.
    if (toolCall.status === 'running') toolCall.status = isError ? 'error' : 'completed';
  }

  const envelope = findPersistedToolCallById(ctx, envelopeCallId);
  if (envelope && !withholdsOutput) {
    applyPersistedToolOutput(envelope, rawOutputValue, rawOutputText, ctx);
  }
}

function readTerminalSessionIdArgument(input: Record<string, unknown>): string | undefined {
  const value = input.session_id ?? input.sessionId;
  if (typeof value === 'string' && value) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function readPersistedCommandToolResult(rawOutputText: string): {
  output: string;
  status: 'running' | 'completed' | 'unknown';
  exitCode?: number;
  terminalSessionId?: string;
  execCellId?: string;
} {
  const outputMarker = 'Output:\n';
  const markerIndex = rawOutputText.startsWith('Script ') ? rawOutputText.indexOf(outputMarker) : -1;
  let commandResultText = markerIndex >= 0
    ? rawOutputText.slice(markerIndex + outputMarker.length)
    : rawOutputText;
  let metadata = parseCodexArguments(commandResultText);
  if (metadata.status === 'fulfilled'
    && metadata.value
    && typeof metadata.value === 'object'
    && !Array.isArray(metadata.value)
    && typeof (metadata.value as Record<string, unknown>).output === 'string') {
    metadata = metadata.value as Record<string, unknown>;
    commandResultText = JSON.stringify(metadata);
  }
  const exitCodeMatch = commandResultText.match(/(?:Exit code:|Process exited with code)\s*(-?\d+)/i);
  const exitCode = typeof metadata.exit_code === 'number' && Number.isInteger(metadata.exit_code)
    ? metadata.exit_code
    : exitCodeMatch ? Number(exitCodeMatch[1]) : undefined;
  const runningMatch = commandResultText.match(/Process running with session ID\s*([^\n]+)/i);
  const terminalSessionId = readTerminalSessionIdArgument(metadata) || runningMatch?.[1]?.trim();
  const execCellId = extractCodexExecCellId(rawOutputText);

  return {
    output: normalizeCodexToolResult('Bash', commandResultText),
    status: exitCode !== undefined ? 'completed' : terminalSessionId || execCellId ? 'running' : 'unknown',
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(terminalSessionId ? { terminalSessionId } : {}),
    ...(execCellId ? { execCellId } : {}),
  };
}

function applyPersistedToolOutput(
  toolCall: ToolCallInfo,
  rawOutputValue: string | unknown[] | undefined,
  rawOutputText: string,
  ctx: PersistedParseContext,
  options: { allowImplicitCommandCompletion?: boolean } = {},
): void {
  if (toolCall.name === 'exec') {
    toolCall.result = appendCodexCommandOutput(toolCall.result, normalizeCodexToolResult('exec', rawOutputText));
    if (Array.isArray(rawOutputValue)) {
      const images = extractMessageImages(rawOutputValue as PersistedMessagePart[], toolCall.id)
        .map(({ data, mediaType }) => ({ kind: 'data' as const, data, mediaType }));
      if (images.length > 0) toolCall.resultImages = [...(toolCall.resultImages ?? []), ...images];
    }
    const cellId = extractCodexExecCellId(rawOutputText);
    if (cellId) {
      ctx.execCellToCommandId.set(cellId, toolCall.id);
      toolCall.status = 'running';
    } else {
      toolCall.status = (ctx.failedExecCallIds.has(toolCall.id) || isCodexToolOutputError(rawOutputText)) ? 'error' : 'completed';
    }
    return;
  }

  if (toolCall.name === 'Bash' || toolCall.name === 'write_stdin') {
    const commandResult = readPersistedCommandToolResult(rawOutputText);
    toolCall.result = appendCodexCommandOutput(toolCall.result, commandResult.output);
    if (commandResult.terminalSessionId && toolCall.name === 'Bash') {
      ctx.terminalSessionToCommandId.set(commandResult.terminalSessionId, toolCall.id);
    }
    if (commandResult.execCellId) {
      ctx.execCellToCommandId.set(commandResult.execCellId, toolCall.id);
    }
    if (commandResult.execCellId || (commandResult.status === 'running' && toolCall.name === 'Bash')) {
      toolCall.status = 'running';
      return;
    }
    if (commandResult.status === 'unknown' && options.allowImplicitCommandCompletion === false) {
      return;
    }
    toolCall.status = commandResult.exitCode !== undefined
      ? commandResult.exitCode === 0 ? 'completed' : 'error'
      : isCodexToolOutputError(rawOutputText) || isCodexToolOutputError(commandResult.output) ? 'error' : 'completed';
    return;
  }

  toolCall.result = normalizePersistedToolOutput(toolCall, rawOutputValue, rawOutputText);
  toolCall.status = (toolCall.name === 'exec' && ctx.failedExecCallIds.has(toolCall.id))
    || isCodexToolOutputError(rawOutputText) ? 'error' : 'completed';
}

function normalizePersistedToolOutput(
  toolCall: ToolCallInfo,
  rawOutputValue: string | unknown[] | undefined,
  rawOutputText: string,
): string {
  if (Array.isArray(rawOutputValue) && toolCall.name === 'Read') {
    const filePath = toolCall.input.file_path;
    if (typeof filePath === 'string' && filePath) {
      return filePath;
    }
  }

  return normalizeCodexToolResult(toolCall.name, rawOutputText);
}

function processPersistedWebSearchCall(
  payload: PersistedWebSearchCallPayload,
  timestamp: number,
  lineIndex: number,
  ctx: PersistedParseContext,
): void {
  const turn = ensureTurn(ctx.turns, ctx.turnOrder, nextTurnId(ctx), ctx.currentTurnId, timestamp);
  const bubble = ensureAssistantBubble(turn, timestamp);

  // Persisted web_search_call entries commonly omit call_id. Use transcript line index
  // so live tailing and history reload reconstruct the same visible tool sequence.
  const callId = payload.call_id || `tail-ws-${lineIndex}`;

  if (bubble.toolIndexesById.has(callId)) return;

  const input = normalizeCodexToolInput('web_search_call', {
    action: payload.action ?? {},
  });

  const isTerminal = payload.status === 'completed' || payload.status === 'failed'
    || payload.status === 'error' || payload.status === 'cancelled';

  const toolCall: ToolCallInfo = {
    id: callId,
    name: 'WebSearch',
    input,
    status: isTerminal ? (payload.status === 'completed' ? 'completed' : 'error') : 'running',
    ...(isTerminal ? { result: 'Search complete' } : {}),
  };

  pushToolInvocation(bubble, toolCall);

  ctx.toolCallToTurn.set(callId, {
    turnId: turn.id,
    bubbleIndex: turn.assistantBubbles.indexOf(bubble),
  });
}

function processPersistedMcpToolCall(
  payload: PersistedMcpToolCallPayload,
  timestamp: number,
  ctx: PersistedParseContext,
): void {
  const callId = payload.call_id;
  if (!callId) return;

  const turn = ensureTurn(ctx.turns, ctx.turnOrder, nextTurnId(ctx), ctx.currentTurnId, timestamp);
  const bubble = ensureAssistantBubble(turn, timestamp);

  if (bubble.toolIndexesById.has(callId)) return;

  const normalizedInput = normalizeCodexMcpToolInput(payload.arguments);
  const normalizedState = normalizeCodexMcpToolState(payload.status, payload.result, payload.error);

  const toolCall: ToolCallInfo = {
    id: callId,
    name: normalizeCodexMcpToolName(payload.server, payload.tool),
    input: normalizedInput,
    status: normalizedState.status,
    ...(normalizedState.result ? { result: normalizedState.result } : {}),
  };

  pushToolInvocation(bubble, toolCall);

  ctx.toolCallToTurn.set(callId, {
    turnId: turn.id,
    bubbleIndex: turn.activeBubbleIndex!,
  });
}

function processPersistedPayload(
  payload: PersistedPayload,
  timestamp: number,
  lineIndex: number,
  ctx: PersistedParseContext,
): void {
  if (!payload?.type) {
    return;
  }

  switch (payload.type) {
    case 'message': {
      const messagePayload = payload as PersistedMessagePayload;

      if (messagePayload.role === 'user') {
        const text = extractUserMessageText(messagePayload.content);
        const visibleText = extractCodexUserVisibleText(text);
        const hasImages = hasMessageImages(messagePayload.content);
        if (visibleText === null && !hasImages) break;

        // Close any active bubble in the current turn before starting user content
        if (ctx.currentTurnId) {
          const prevTurn = ctx.turns.get(ctx.currentTurnId);
          if (prevTurn) closeAssistantBubble(prevTurn);
        }

        // User message opens a new turn
        ctx.currentTurnId = null;
        const turn = ensureTurn(ctx.turns, ctx.turnOrder, nextTurnId(ctx), null, timestamp);
        ctx.currentTurnId = turn.id;
        if (visibleText !== null) {
          appendUserChunk(turn, visibleText, timestamp);
        }
        appendUserImages(turn, messagePayload.content, timestamp);
      } else if (messagePayload.role === 'assistant') {
        const text = stripCodexMemoryCitationMarkup(
          extractMessageText(messagePayload.content),
        );
        const turn = ensureTurn(ctx.turns, ctx.turnOrder, nextTurnId(ctx), ctx.currentTurnId, timestamp);
        const bubble = ensureAssistantBubble(turn, timestamp);
        if (text) {
          appendOrderedTextChunk(bubble, 'text', text);
        }
      }
      break;
    }

    case 'reasoning': {
      const reasoningPayload = payload as PersistedReasoningPayload;
      const text = extractReasoningText(reasoningPayload);
      if (!text) break;

      const turn = ensureTurn(ctx.turns, ctx.turnOrder, nextTurnId(ctx), ctx.currentTurnId, timestamp);
      const bubble = ensureAssistantBubble(turn, timestamp);
      appendOrderedTextChunk(bubble, 'thinking', text);
      break;
    }

    case 'function_call':
    case 'custom_tool_call':
      processPersistedToolCall(payload as PersistedToolCallPayload, timestamp, ctx);
      break;

    case 'function_call_output':
    case 'custom_tool_call_output':
      processPersistedToolOutput(payload as PersistedToolCallOutputPayload, timestamp, ctx);
      break;

    case 'web_search_call':
      processPersistedWebSearchCall(payload as PersistedWebSearchCallPayload, timestamp, lineIndex, ctx);
      break;

    case 'mcp_tool_call':
      processPersistedMcpToolCall(payload as PersistedMcpToolCallPayload, timestamp, ctx);
      break;

    case 'compaction':
      break;

    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// event_msg processing
// ---------------------------------------------------------------------------

function extractServerTurnId(payload: PersistedEventPayload): string | undefined {
  const turnId = (payload as Record<string, unknown>).turn_id;
  return typeof turnId === 'string' ? turnId : undefined;
}

function processEventMsg(
  payload: PersistedEventPayload,
  timestamp: number,
  ctx: PersistedParseContext,
): void {
  if (!payload?.type) return;

  switch (payload.type) {
    case 'item_completed': {
      const item = payload.item;
      if (item?.type === 'CommandExecution') {
        applyPersistedNativeExecItem(item, ctx);
        break;
      }
      break;
    }

    case 'task_started': {
      // Native items complete their calls within the same turn.
      ctx.nativeCallCandidates.length = 0;
      const serverTurnId = extractServerTurnId(payload);
      const id = nextTurnId(ctx);
      const turn = ensureTurn(ctx.turns, ctx.turnOrder, id, null, timestamp);
      turn.startedAt = timestamp;
      if (serverTurnId) turn.serverTurnId = serverTurnId;
      ctx.currentTurnId = turn.id;
      break;
    }

    case 'task_complete': {
      if (ctx.currentTurnId) {
        const turn = ctx.turns.get(ctx.currentTurnId);
        if (turn) {
          turn.completedAt = timestamp;
          turn.completed = true;
          closeAssistantBubble(turn);
          const serverTurnId = extractServerTurnId(payload);
          if (serverTurnId && !turn.serverTurnId) turn.serverTurnId = serverTurnId;
        }
      }
      ctx.currentTurnId = null;
      break;
    }

    case 'turn_aborted': {
      if (ctx.currentTurnId) {
        const turn = ctx.turns.get(ctx.currentTurnId);
        if (turn) {
          const bubble = ensureAssistantBubble(turn, timestamp);
          bubble.interrupted = true;
          closeAssistantBubble(turn);
          turn.completedAt = timestamp;
        }
      }
      ctx.currentTurnId = null;
      break;
    }

    case 'user_message': {
      const turn = ensureTurn(ctx.turns, ctx.turnOrder, nextTurnId(ctx), ctx.currentTurnId, timestamp);
      const msg = payload.message;
      if (typeof msg === 'string') {
        const visibleText = extractCodexUserVisibleText(msg);
        if (visibleText !== null) {
          appendUserChunk(turn, visibleText, timestamp);
        }
      }
      break;
    }

    case 'agent_message': {
      const turn = ensureTurn(ctx.turns, ctx.turnOrder, nextTurnId(ctx), ctx.currentTurnId, timestamp);
      const bubble = ensureAssistantBubble(turn, timestamp);
      const msg = payload.message;
      if (typeof msg === 'string') {
        appendOrderedTextChunk(
          bubble,
          'text',
          stripCodexMemoryCitationMarkup(msg),
        );
      }
      break;
    }

    case 'agent_reasoning': {
      const text = extractReasoningText(payload);
      if (!text) break;

      const turn = ensureTurn(ctx.turns, ctx.turnOrder, nextTurnId(ctx), ctx.currentTurnId, timestamp);
      const bubble = ensureAssistantBubble(turn, timestamp);
      appendOrderedTextChunk(bubble, 'thinking', text);
      break;
    }

    case 'context_compacted': {
      const activeTurnId = ctx.currentTurnId;
      if (activeTurnId) {
        const activeTurn = ctx.turns.get(activeTurnId);
        if (activeTurn) closeAssistantBubble(activeTurn);
      }

      // Auto-compaction can occur in the middle of a running turn. Keep the
      // boundary in that turn so later records retain their turn ownership.
      const turn = ensureTurn(
        ctx.turns,
        ctx.turnOrder,
        nextTurnId(ctx),
        activeTurnId,
        timestamp,
      );
      const bubble = ensureAssistantBubble(turn, timestamp);
      bubble.contentBlocks.push({ type: 'context_compacted' });
      closeAssistantBubble(turn);
      break;
    }

    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Flush multi-bubble turns to ChatMessage[]
// ---------------------------------------------------------------------------

function flushBubbleTurnMessages(
  turn: CodexTurnState,
  msgIndex: number,
): { messages: ChatMessage[]; nextMsgIndex: number } {
  const messages: ChatMessage[] = [];

  const visibleUserText = extractCodexUserVisibleText(turn.userChunks.join('\n'));
  const userImages = turn.userImages.length > 0 ? turn.userImages : undefined;
  if (visibleUserText || userImages) {
    const displayContent = visibleUserText ? extractUserDisplayContent(visibleUserText) : undefined;
    messages.push({
      id: `codex-msg-${msgIndex}`,
      role: 'user',
      content: visibleUserText ?? '',
      ...(displayContent !== undefined ? { displayContent } : {}),
      ...(userImages ? { images: userImages } : {}),
      ...(turn.serverTurnId ? { userMessageId: turn.serverTurnId } : {}),
      timestamp: turn.userTimestamp || turn.startedAt || Date.now(),
    });
    msgIndex += 1;
  }

  let lastAssistantTimestamp = 0;
  const assistantMessages: ChatMessage[] = [];

  for (const bubble of turn.assistantBubbles) {
    const contentText = bubble.contentChunks.join('\n\n');
    const thinkingText = bubble.thinkingChunks.join('\n\n');
    const hasContent = contentText.trim().length > 0;
    const hasThinking = thinkingText.trim().length > 0;
    const hasToolCalls = bubble.toolCalls.length > 0;
    const hasCompactBoundary = bubble.contentBlocks.some(b => b.type === 'context_compacted');

    if (!hasContent && !hasThinking && !hasToolCalls && !hasCompactBoundary) {
      if (bubble.interrupted) {
        messages.push({
          id: `codex-msg-${msgIndex}`,
          role: 'assistant',
          content: '',
          timestamp: bubble.startedAt || turn.startedAt || Date.now(),
          isInterrupt: true,
        });
        msgIndex += 1;
      }
      continue;
    }

    const contentBlocks = bubble.contentBlocks;

    const msg: ChatMessage = {
      id: `codex-msg-${msgIndex}`,
      role: 'assistant',
      content: contentText.trim(),
      timestamp: bubble.startedAt || turn.startedAt || Date.now(),
      toolCalls: hasToolCalls ? bubble.toolCalls : undefined,
      contentBlocks: contentBlocks.length > 0 ? contentBlocks : undefined,
    };

    if (bubble.interrupted) {
      msg.isInterrupt = true;
    }

    if (bubble.lastEventAt > lastAssistantTimestamp) {
      lastAssistantTimestamp = bubble.lastEventAt;
    }

    assistantMessages.push(msg);
    messages.push(msg);
    msgIndex += 1;
  }

  if (assistantMessages.length > 0 && turn.userTimestamp && lastAssistantTimestamp > turn.userTimestamp) {
    const durationMs = lastAssistantTimestamp - turn.userTimestamp;
    const lastMsg = assistantMessages[assistantMessages.length - 1];
    lastMsg.durationSeconds = Math.round(durationMs / 1000);
  }

  if (turn.serverTurnId && turn.completed && assistantMessages.length > 0) {
    const lastNonInterrupt = [...assistantMessages].reverse().find(m => !m.isInterrupt);
    if (lastNonInterrupt) {
      lastNonInterrupt.assistantMessageId = turn.serverTurnId;
    }
  }

  return { messages, nextMsgIndex: msgIndex };
}

// ---------------------------------------------------------------------------
// Session file discovery
// ---------------------------------------------------------------------------

const SAFE_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function getPathModuleForSessionPath(sessionPath: string): typeof path.posix {
  return sessionPath.includes('\\') || /^[A-Za-z]:/.test(sessionPath)
    ? path.win32
    : path.posix;
}

export function deriveCodexSessionsRootFromSessionPath(
  sessionFilePath: string | null | undefined,
): string | null {
  if (!sessionFilePath) {
    return null;
  }

  const pathModule = getPathModuleForSessionPath(sessionFilePath);
  let current = pathModule.dirname(pathModule.normalize(sessionFilePath));
  let previous: string | null = null;

  while (current && current !== previous) {
    if (pathModule.basename(current).toLowerCase() === 'sessions') {
      return current;
    }
    previous = current;
    current = pathModule.dirname(current);
  }

  return null;
}

export function deriveCodexMemoriesDirFromSessionsRoot(
  sessionsDir: string | null | undefined,
): string | null {
  if (!sessionsDir) {
    return null;
  }

  const pathModule = getPathModuleForSessionPath(sessionsDir);
  return pathModule.join(pathModule.dirname(sessionsDir), 'memories');
}

export function findCodexSessionFile(
  threadId: string,
  root: string = path.join(os.homedir(), '.codex', 'sessions'),
): string | null {
  if (!threadId || !SAFE_SESSION_ID_PATTERN.test(threadId) || !fs.existsSync(root)) {
    return null;
  }

  const directPath = path.join(root, `${threadId}.jsonl`);
  if (fs.existsSync(directPath)) {
    return directPath;
  }
  const directZstPath = path.join(root, `${threadId}.jsonl.zst`);
  if (fs.existsSync(directZstPath)) {
    return directZstPath;
  }

  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }

      if (
        entry.isFile()
        && (entry.name.endsWith(`-${threadId}.jsonl`) || entry.name.endsWith(`-${threadId}.jsonl.zst`))
      ) {
        return fullPath;
      }
    }
  }

  return null;
}

export async function findCodexSessionFileAsync(
  threadId: string,
  root: string = path.join(os.homedir(), '.codex', 'sessions'),
  timeoutMs = 10_000,
  dependencies: CodexSessionFileLookupDependencies = {},
): Promise<string | null> {
  if (!threadId || !SAFE_SESSION_ID_PATTERN.test(threadId)) {
    return null;
  }

  const deadline = Date.now() + Math.max(0, timeoutMs);
  const pathExists = dependencies.pathExists ?? defaultPathExists;
  const readDirectory = dependencies.readDirectory
    ?? ((value: string) => fsp.readdir(value, { withFileTypes: true }));
  try {
    if (!(await runBeforeDeadline(() => pathExists(root), deadline))) {
      return null;
    }
    const directPath = path.join(root, `${threadId}.jsonl`);
    if (await runBeforeDeadline(() => pathExists(directPath), deadline)) {
      return directPath;
    }
    const directZstPath = path.join(root, `${threadId}.jsonl.zst`);
    if (await runBeforeDeadline(() => pathExists(directZstPath), deadline)) {
      return directZstPath;
    }
  } catch {
    return null;
  }

  const stack = [root];
  while (stack.length > 0 && Date.now() <= deadline) {
    const current = stack.pop();
    if (!current) continue;

    let entries: fs.Dirent[];
    try {
      entries = await runBeforeDeadline(() => readDirectory(current), deadline);
    } catch {
      if (Date.now() >= deadline) {
        return null;
      }
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (
        entry.isFile()
        && (entry.name.endsWith(`-${threadId}.jsonl`) || entry.name.endsWith(`-${threadId}.jsonl.zst`))
      ) {
        return fullPath;
      }
    }
  }
  return null;
}

const CODEX_UUID_PATTERN = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;

export function extractCodexThreadIdFromPath(filePath: string): string | null {
  const base = path.basename(filePath);
  const uuidMatch = base.match(CODEX_UUID_PATTERN);
  if (uuidMatch) {
    return uuidMatch[0];
  }
  const genericMatch = base.match(/(?:^|.+?-)([A-Za-z0-9_-]+)\.jsonl(?:\.zst)?$/);
  return genericMatch ? genericMatch[1] : null;
}

export interface CodexSessionFileLookupDependencies {
  pathExists?: (value: string) => Promise<boolean>;
  readDirectory?: (value: string) => Promise<fs.Dirent[]>;
}

async function runBeforeDeadline<T>(
  operation: () => Promise<T>,
  deadline: number,
): Promise<T> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    throw new Error('Codex history lookup deadline exceeded.');
  }

  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error('Codex history lookup deadline exceeded.'));
    }, remainingMs);
    operation().then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

async function defaultPathExists(value: string): Promise<boolean> {
  try {
    await fsp.access(value);
    return true;
  } catch {
    return false;
  }
}

export function parseCodexSessionFile(filePath: string): ChatMessage[] {
  let content: string;
  try {
    if (filePath.endsWith('.zst')) {
      const buffer = fs.readFileSync(filePath);
      content = typeof zlib.zstdDecompressSync === 'function'
        ? zlib.zstdDecompressSync(buffer).toString('utf-8')
        : buffer.toString('utf-8');
    } else {
      content = fs.readFileSync(filePath, 'utf-8');
    }
  } catch {
    return [];
  }

  return parseCodexSessionContent(content);
}


/**
 * Streams a native transcript into records without materializing the whole file as one string.
 * Returns null when the file is missing; every other read failure rejects so callers never mistake
 * an unreadable transcript for an empty one. Malformed lines are skipped.
 */
export async function readCodexSessionRecords(filePath: string): Promise<CodexSessionRecord[] | null> {
  const records: CodexSessionRecord[] = [];
  try {
    await forEachJSONLLine(filePath, (line) => {
      const record = parseSessionRecord(line);
      if (record) records.push(record);
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return null;
    throw error;
  }
  return records;
}

/** Missing transcripts have no history; other read failures reject. */
export async function parseCodexSessionFileAsync(filePath: string): Promise<ChatMessage[]> {
  const records = await readCodexSessionRecords(filePath);
  return records ? parseCodexSessionTurns(records).flatMap(turn => turn.messages) : [];
}

export interface CodexParsedTurn {
  turnId: string | null;
  messages: ChatMessage[];
}

export function parseCodexSessionRecordLines(lines: readonly string[]): CodexSessionRecord[] {
  return lines
    .map(parseSessionRecord)
    .filter((record): record is CodexSessionRecord => record !== null);
}

export function parseCodexSessionRecords(content: string): CodexSessionRecord[] {
  return parseCodexSessionRecordLines(content.split('\n'));
}

export function parseCodexSessionContent(content: string): ChatMessage[] {
  const turns = parseCodexSessionTurns(content);
  return turns.flatMap(t => t.messages);
}

export function parseCodexSessionTurns(content: string | CodexSessionRecord[]): CodexParsedTurn[] {
  const records = typeof content === 'string' ? parseCodexSessionRecordLines(content.split('\n')) : content;

  // Detect format: legacy uses type=event, modern uses event_msg/response_item
  let hasLegacy = false;
  let hasModern = false;
  for (const record of records) {
    if (record.type === 'event') hasLegacy = true;
    else if (record.type === 'event_msg' || record.type === 'response_item' || record.type === 'compacted') hasModern = true;
    if (hasLegacy && hasModern) break;
  }

  // Pure legacy sessions use the old flat accumulator (no turn-level structure)
  if (hasLegacy && !hasModern) {
    const messages = parseLegacySession(records);
    return messages.length > 0 ? [{ turnId: null, messages }] : [];
  }

  // Modern or mixed sessions use the bubble model with turn-level grouping
  return parseModernSessionTurns(records);
}

// ---------------------------------------------------------------------------
// Legacy (event wrapper) parser — preserved for backward compat
// ---------------------------------------------------------------------------

function parseLegacySession(records: ParsedSessionRecord[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  let turn = newTurn();
  let msgIndex = 0;

  for (const parsed of records) {
    if (parsed.type === 'event' && parsed.event) {
      const event = parsed.event;

      switch (event.type) {
        case 'turn.started':
          if (turn.assistantText || turn.thinkingText || turn.toolCalls.length > 0) {
            msgIndex = flushTurn(turn, messages, msgIndex);
          }
          turn = newTurn();
          break;

        case 'item.started':
        case 'item.updated':
        case 'item.completed':
          if (event.item) {
            processLegacyItem(event.type, event.item, turn);
          }
          break;

        case 'turn.completed':
          msgIndex = flushTurn(turn, messages, msgIndex);
          turn = newTurn();
          break;

        case 'turn.failed':
          turn.interrupted = true;
          msgIndex = flushTurn(turn, messages, msgIndex);
          turn = newTurn();
          break;

        default:
          break;
      }
    }
  }

  flushTurn(turn, messages, msgIndex);
  return messages;
}

// ---------------------------------------------------------------------------
// Modern (response_item + event_msg) parser — bubble model
// ---------------------------------------------------------------------------

function parseModernSessionTurns(records: ParsedSessionRecord[]): CodexParsedTurn[] {
  const ctx = createPersistedParseContext();
  const compactedRecordsWithEvent = new Set<ParsedSessionRecord>();
  let pendingCompactionRecord: ParsedSessionRecord | undefined;

  for (const record of records) {
    const payload = record.payload;
    if (record.type === 'response_item'
      && (payload?.type === 'custom_tool_call_output' || payload?.type === 'function_call_output')) {
      const output = payload as PersistedToolCallOutputPayload;
      if (output.call_id && /^Script failed(?:\r?\n|$)/.test(stringifyCodexToolOutput(output.output))) {
        ctx.failedExecCallIds.add(output.call_id);
      }
    }

    if (record.type === 'compacted') {
      pendingCompactionRecord = record;
    } else if (record.type === 'event_msg' && payload?.type === 'context_compacted') {
      if (pendingCompactionRecord) compactedRecordsWithEvent.add(pendingCompactionRecord);
      pendingCompactionRecord = undefined;
    } else if (record.type === 'response_item' || record.type === 'event_msg') {
      pendingCompactionRecord = undefined;
    }
  }

  for (const [lineIndex, parsed] of records.entries()) {
    const timestamp = parsed.timestamp;

    // Legacy event records can appear in mixed sessions
    if (parsed.type === 'event' && parsed.event) {
      processLegacyEventInModernContext(parsed.event, timestamp, ctx);
      continue;
    }

    if (parsed.type === 'event_msg') {
      processEventMsg(parsed.payload as PersistedEventPayload, timestamp, ctx);
      continue;
    }

    if (parsed.type === 'compacted') {
      if (!compactedRecordsWithEvent.has(parsed)) {
        processEventMsg({ type: 'context_compacted' }, timestamp, ctx);
      }
      continue;
    }

    if (parsed.type === 'response_item') {
      processPersistedPayload(parsed.payload, timestamp, lineIndex, ctx);
    }
  }

  return flushBubbleTurnsGrouped(ctx.turns, ctx.turnOrder);
}

function flushBubbleTurnsGrouped(
  turns: Map<string, CodexTurnState>,
  turnOrder: string[],
): CodexParsedTurn[] {
  const result: CodexParsedTurn[] = [];
  let messageOffset = 0;

  for (const turnId of turnOrder) {
    const turn = turns.get(turnId);
    if (!turn) continue;
    const { messages: turnMessages, nextMsgIndex } = flushBubbleTurnMessages(turn, messageOffset);
    if (turnMessages.length === 0) continue;
    messageOffset = nextMsgIndex;

    result.push({
      turnId: turn.serverTurnId ?? null,
      messages: turnMessages,
    });
  }

  return result;
}

function findToolCallOrigin(
  ctx: PersistedParseContext,
  callId: string,
): ToolCallInfo | null {
  const origin = ctx.toolCallToTurn.get(callId);
  if (!origin) {
    return null;
  }

  const turn = ctx.turns.get(origin.turnId);
  if (!turn || origin.bubbleIndex >= turn.assistantBubbles.length) {
    return null;
  }

  return turn.assistantBubbles[origin.bubbleIndex].toolCalls.find(tool => tool.id === callId) ?? null;
}

function trackToolCallOrigin(
  ctx: PersistedParseContext,
  callId: string,
  turn: CodexTurnState,
): void {
  ctx.toolCallToTurn.set(callId, {
    turnId: turn.id,
    bubbleIndex: turn.activeBubbleIndex!,
  });
}

function ensureModernLegacyToolCall(
  ctx: PersistedParseContext,
  timestamp: number,
  item: CodexItem,
  build: () => ToolCallInfo,
): ToolCallInfo {
  const existing = findToolCallOrigin(ctx, item.id);
  if (existing) {
    return existing;
  }

  const turn = ensureTurn(ctx.turns, ctx.turnOrder, nextTurnId(ctx), ctx.currentTurnId, timestamp);
  const bubble = ensureAssistantBubble(turn, timestamp);
  const toolCall = build();
  pushToolInvocation(bubble, toolCall);
  trackToolCallOrigin(ctx, item.id, turn);
  return toolCall;
}

function processLegacyItemInModernContext(
  eventType: string,
  item: CodexItem,
  timestamp: number,
  ctx: PersistedParseContext,
): void {
  switch (item.type) {
    case 'agent_message': {
      if ((eventType === 'item.updated' || eventType === 'item.completed') && item.text) {
        const turn = ensureTurn(ctx.turns, ctx.turnOrder, nextTurnId(ctx), ctx.currentTurnId, timestamp);
        const bubble = ensureAssistantBubble(turn, timestamp);
        replaceLatestOrderedTextChunk(
          bubble,
          'text',
          stripCodexMemoryCitationMarkup(item.text),
        );
      }
      break;
    }

    case 'reasoning': {
      if ((eventType === 'item.updated' || eventType === 'item.completed') && item.text) {
        const turn = ensureTurn(ctx.turns, ctx.turnOrder, nextTurnId(ctx), ctx.currentTurnId, timestamp);
        const bubble = ensureAssistantBubble(turn, timestamp);
        replaceLatestOrderedTextChunk(bubble, 'thinking', item.text);
      }
      break;
    }

    case 'command_execution': {
      if (eventType === 'item.started') {
        ensureModernLegacyToolCall(ctx, timestamp, item, () => ({
          id: item.id,
          name: normalizeCodexToolName(item.type),
          input: normalizeCodexToolInput(item.type, { command: item.command ?? '' }),
          status: 'running',
        }));
        break;
      }

      if (eventType === 'item.completed') {
        const toolCall = ensureModernLegacyToolCall(ctx, timestamp, item, () => ({
          id: item.id,
          name: normalizeCodexToolName(item.type),
          input: normalizeCodexToolInput(item.type, { command: item.command ?? '' }),
          status: 'running',
        }));
        const rawOutput = item.aggregated_output ?? '';
        toolCall.result = normalizeCodexToolResult(toolCall.name, rawOutput);
        toolCall.status = item.exit_code === 0 ? 'completed' : 'error';
      }
      break;
    }

    case 'file_change': {
      if (eventType !== 'item.started' && eventType !== 'item.completed') {
        break;
      }

      const changes = item.changes ?? [];
      const toolCall = ensureModernLegacyToolCall(ctx, timestamp, item, () => ({
        id: item.id,
        name: normalizeCodexToolName('file_change'),
        input: { changes },
        status: 'running',
      }));

      if (eventType === 'item.completed') {
        const paths = changes.map(change => `${change.kind}: ${change.path}`).join(', ');
        toolCall.result = paths ? `Applied: ${paths}` : 'Applied';
        toolCall.status = item.status === 'completed' ? 'completed' : 'error';
      }
      break;
    }

    case 'web_search': {
      if (eventType === 'item.started') {
        ensureModernLegacyToolCall(ctx, timestamp, item, () => ({
          id: item.id,
          name: normalizeCodexToolName(item.type),
          input: normalizeCodexToolInput(item.type, { query: item.query ?? '' }),
          status: 'running',
        }));
        break;
      }

      if (eventType === 'item.completed') {
        const toolCall = ensureModernLegacyToolCall(ctx, timestamp, item, () => ({
          id: item.id,
          name: normalizeCodexToolName(item.type),
          input: normalizeCodexToolInput(item.type, { query: item.query ?? '' }),
          status: 'running',
        }));
        toolCall.result = 'Search complete';
        toolCall.status = 'completed';
      }
      break;
    }

    case 'mcp_tool_call': {
      if (eventType === 'item.started') {
        ensureModernLegacyToolCall(ctx, timestamp, item, () => ({
          id: item.id,
          name: `mcp__${item.server ?? ''}__${item.tool ?? ''}`,
          input: {},
          status: 'running',
        }));
        break;
      }

      if (eventType === 'item.completed') {
        const toolCall = ensureModernLegacyToolCall(ctx, timestamp, item, () => ({
          id: item.id,
          name: `mcp__${item.server ?? ''}__${item.tool ?? ''}`,
          input: {},
          status: 'running',
        }));
        toolCall.status = item.status === 'completed' ? 'completed' : 'error';
        toolCall.result = item.status === 'completed' ? 'Completed' : 'Failed';
      }
      break;
    }

    default:
      break;
  }
}

function processLegacyEventInModernContext(
  event: CodexEvent,
  timestamp: number,
  ctx: PersistedParseContext,
): void {
  switch (event.type) {
    case 'turn.started': {
      if (ctx.currentTurnId) {
        const previousTurn = ctx.turns.get(ctx.currentTurnId);
        if (previousTurn) {
          closeAssistantBubble(previousTurn);
        }
      }
      const id = nextTurnId(ctx);
      ensureTurn(ctx.turns, ctx.turnOrder, id, null, timestamp);
      ctx.currentTurnId = id;
      break;
    }

    case 'turn.completed': {
      if (ctx.currentTurnId) {
        const turn = ctx.turns.get(ctx.currentTurnId);
        if (turn) closeAssistantBubble(turn);
      }
      ctx.currentTurnId = null;
      break;
    }

    case 'turn.failed': {
      if (ctx.currentTurnId) {
        const turn = ctx.turns.get(ctx.currentTurnId);
        if (turn) {
          const bubble = ensureAssistantBubble(turn, timestamp);
          bubble.interrupted = true;
          closeAssistantBubble(turn);
        }
      }
      ctx.currentTurnId = null;
      break;
    }

    case 'item.started':
    case 'item.updated':
    case 'item.completed':
      if (event.item) {
        processLegacyItemInModernContext(event.type, event.item, timestamp, ctx);
      }
      break;

    default:
      break;
  }
}
