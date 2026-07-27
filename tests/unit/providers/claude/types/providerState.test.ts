import type { Conversation } from '@/core/types';
import { clearClaudeResumeState } from '@/providers/claude/types/providerState';

function createConversation(): Conversation {
  return {
    id: 'conv-1',
    providerId: 'claude',
    title: 'Conversation',
    createdAt: 1,
    updatedAt: 1,
    sessionId: null,
    messages: [],
  };
}

describe('clearClaudeResumeState', () => {
  it('preserves provider session IDs for history replay while blocking resume', () => {
    const conversation = createConversation();
    conversation.sessionId = 'legacy-session';
    conversation.resumeAtMessageId = 'assistant-message';
    conversation.providerState = {
      providerSessionId: 'active-session',
      previousProviderSessionIds: ['older-session'],
      forkSource: { sessionId: 'fork-session', resumeAt: 'fork-message' },
    };

    expect(clearClaudeResumeState(conversation)).toBe(true);

    expect(conversation.sessionId).toBeNull();
    expect(conversation.resumeAtMessageId).toBeUndefined();
    expect(conversation.providerState).toEqual({
      previousProviderSessionIds: ['older-session', 'active-session', 'legacy-session'],
    });
  });
});
