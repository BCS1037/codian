import type { ChatTurnRequest } from '../../../core/runtime/types';
import type { ChatMessage } from '../../../core/types';
import { appendBrowserContext } from '../../../utils/browser';
import { appendCanvasContext } from '../../../utils/canvas';
import { appendChatSelections, appendCurrentNote } from '../../../utils/context';
import { appendEditorContext } from '../../../utils/editor';
import { buildContextFromHistory, buildPromptWithHistoryContext } from '../../../utils/session';
import type { AcpContentBlock } from '../../acp';
import type { OpencodeUserTextRange } from './OpencodeSessionConnection';

export interface OpencodePrompt {
  readonly blocks: AcpContentBlock[];
  readonly userTextRange: OpencodeUserTextRange | null;
}

export function buildOpencodePromptText(
  request: ChatTurnRequest,
  conversationHistory: ChatMessage[] = [],
): string {
  return composeOpencodePromptText(request, conversationHistory).text;
}

function composeOpencodePromptText(
  request: ChatTurnRequest,
  conversationHistory: ChatMessage[],
): { text: string; userTextRange: OpencodeUserTextRange | null } {
  let prompt = request.text;

  if (request.currentNotePath) {
    prompt = appendCurrentNote(prompt, request.currentNotePath);
  }

  if (request.editorSelection && request.editorSelection.mode !== 'none') {
    prompt = appendEditorContext(prompt, request.editorSelection);
  }

  if (request.browserSelection) {
    prompt = appendBrowserContext(prompt, request.browserSelection);
  }

  if (request.canvasSelection) {
    prompt = appendCanvasContext(prompt, request.canvasSelection);
  }

  prompt = appendChatSelections(prompt, request.chatSelections);

  if (conversationHistory.length === 0) {
    return { text: prompt, userTextRange: { start: 0, end: request.text.length } };
  }

  const historyContext = buildContextFromHistory(conversationHistory);
  const text = buildPromptWithHistoryContext(
    historyContext,
    prompt,
    prompt,
    conversationHistory,
  );
  const start = text.length - prompt.length;
  const userTextRange = text === prompt || text.endsWith(`\n\nUser: ${prompt}`)
    ? { start, end: start + request.text.length }
    : null;
  return { text, userTextRange };
}

export function buildOpencodePrompt(
  request: ChatTurnRequest,
  conversationHistory: ChatMessage[] = [],
): OpencodePrompt {
  const { text, userTextRange } = composeOpencodePromptText(request, conversationHistory);
  const blocks: AcpContentBlock[] = [{ type: 'text', text }];

  for (const image of request.images ?? []) {
    if (!image.data) continue;
    blocks.push({ data: image.data, mimeType: image.mediaType, type: 'image' });
  }

  return { blocks, userTextRange };
}

export function buildOpencodePromptBlocks(
  request: ChatTurnRequest,
  conversationHistory: ChatMessage[] = [],
): AcpContentBlock[] {
  return buildOpencodePrompt(request, conversationHistory).blocks;
}
