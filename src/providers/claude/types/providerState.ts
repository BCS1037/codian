import type { Conversation } from '../../../core/types';
import type { ForkSource } from '../../../core/types/chat';
import type { SubagentInfo } from '../../../core/types/tools';

export interface ClaudeProviderState {
  providerSessionId?: string;
  previousProviderSessionIds?: string[];
  forkSource?: ForkSource;
  subagentData?: Record<string, SubagentInfo>;
}

/** Extracts typed Claude provider state from the opaque bag. */
export function getClaudeState(
  providerState: Record<string, unknown> | undefined,
): ClaudeProviderState {
  return (providerState ?? {});
}

export function clearClaudeResumeState(conversation: Conversation): boolean {
  const providerState = { ...(conversation.providerState ?? {}) };
  const historicalSessionIds = [
    ...(Array.isArray(providerState.previousProviderSessionIds)
      ? providerState.previousProviderSessionIds.filter((id): id is string => typeof id === 'string')
      : []),
    ...(typeof providerState.providerSessionId === 'string'
      ? [providerState.providerSessionId]
      : []),
    ...(typeof conversation.sessionId === 'string' ? [conversation.sessionId] : []),
  ];
  const hadResumeState = conversation.sessionId != null
    || conversation.resumeAtMessageId != null
    || typeof providerState.providerSessionId === 'string'
    || Array.isArray(providerState.previousProviderSessionIds)
    || providerState.forkSource !== undefined;
  if (!hadResumeState) {
    return false;
  }

  conversation.sessionId = null;
  delete conversation.resumeAtMessageId;
  delete providerState.providerSessionId;
  delete providerState.forkSource;
  if (historicalSessionIds.length > 0) {
    providerState.previousProviderSessionIds = [...new Set(historicalSessionIds)];
  } else {
    delete providerState.previousProviderSessionIds;
  }
  conversation.providerState = Object.keys(providerState).length > 0
    ? providerState
    : undefined;
  return true;
}
