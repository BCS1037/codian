import '@/providers';

import { testDate } from '@test/helpers/testClock';

import type { CodianSettings, Conversation } from '@/core/types';
import { SessionMailbox } from '@/features/chat/session-messaging/SessionMailbox';
import {
  type SessionMailboxHost,
  SessionMessagingService,
} from '@/features/chat/session-messaging/SessionMessagingService';
import type { FeatureHost } from '@/features/FeatureHost';

const signal = () => new AbortController().signal;

function setup() {
  const time = testDate().getTime();
  const settings = {
    providerConfigs: {
      claude: {
        discoveredModels: [
          {
            id: 'claude-sonnet-4-5',
            value: 'claude-sonnet-4-5',
            label: 'Claude Sonnet 4.5',
            supportedEffortLevels: ['low', 'high'],
          },
          {
            id: 'claude-haiku-4-5',
            value: 'claude-haiku-4-5',
            label: 'Claude Haiku 4.5',
          },
        ],
      },
    },
    lastSelectedChatModel: { providerId: 'claude', model: 'claude-sonnet-4-5' },
    effortLevel: 'high',
  } as unknown as CodianSettings;

  const records = new Map<string, Conversation>([
    [
      'sender',
      {
        id: 'sender',
        sessionId: null,
        providerId: 'claude',
        selectedModel: 'claude-sonnet-4-5',
        title: 'Research',
        messages: [],
        createdAt: time - 60000,
        updatedAt: time - 60000,
        lastActivityAt: time - 60000,
      } as Conversation,
    ],
    [
      'recipient',
      {
        id: 'recipient',
        sessionId: null,
        providerId: 'claude',
        selectedModel: 'claude-sonnet-4-5',
        title: 'recipient',
        messages: [],
        createdAt: time,
        updatedAt: time,
        lastActivityAt: time,
      } as Conversation,
    ],
    [
      'archived',
      {
        id: 'archived',
        sessionId: null,
        providerId: 'claude',
        selectedModel: 'claude-sonnet-4-5',
        title: 'archived',
        messages: [],
        createdAt: time + 60000,
        updatedAt: time + 60000,
        lastActivityAt: time + 60000,
        isArchived: true,
      } as Conversation,
    ],
  ]);

  const runtimes = new Map<string, any>();
  const deliveredMessages: Array<{ targetId: string; text: string | undefined; mode: string | undefined }> = [];

  const sessionRuntimes: SessionMailboxHost = {
    get: (id: string) => runtimes.get(id),
    ensure: (identity) => {
      let existing = runtimes.get(identity.conversationId);
      if (!existing) {
        const mailbox = new SessionMailbox({
          runtime: {
            acceptsIntents: true,
            admitsConversationOperations: true,
            hasBackgroundWork: false,
            hasPendingInteraction: false,
            hasActiveTurn: false,
            hasMainBackgroundWork: false,
            turns: { isActive: false },
            peekModel: {
              inputController: {
                canStartSessionMessage: true,
                steerSessionMessage: async () => 'accepted',
                sendSessionMessage: async (msg, options) => {
                  options.assertBeforeHandoff();
                  deliveredMessages.push({
                    targetId: identity.conversationId,
                    text: msg.text,
                    mode: undefined,
                  });
                },
                interruptForSessionMessage: () => {},
              },
            },
            withModel: async (op) =>
              op({
                inputController: {
                  canStartSessionMessage: true,
                  steerSessionMessage: async () => 'accepted',
                  sendSessionMessage: async (msg, options) => {
                    options.assertBeforeHandoff();
                    deliveredMessages.push({
                      targetId: identity.conversationId,
                      text: msg.text,
                      mode: undefined,
                    });
                  },
                  interruptForSessionMessage: () => {},
                },
              }),
            stopMainBackgroundWork: () => {},
            publish: () => {},
          },
          isTargetAvailable: () => true,
          onDiscard: () => {},
        });

        existing = {
          conversationId: identity.conversationId,
          mailbox,
          isWorking: false,
          isIdle: true,
          reasoningSelections: new Map<string, string>(),
        };
        runtimes.set(identity.conversationId, existing);
      }
      return existing;
    },
    getAll: () => Array.from(runtimes.values()),
  };

  const host = {
    getCommittedSettings: () => settings,
    getConversationList: () => Array.from(records.values()),
    getConversationById: async (id: string) => records.get(id) ?? null,
    getConversationSync: (id: string) => records.get(id) ?? null,
    getCachedConversation: (id: string) => records.get(id) ?? null,
    ensureConversationMetadataLoaded: async () => {},
    findConversationAcrossViews: () => null,
    createConversation: async (options: { providerId?: string; selectedModel?: string }) => {
      const id = `conv-created-${Date.now()}`;
      const conv: Conversation = {
        id,
        sessionId: null,
        providerId: (options.providerId ?? 'claude') as any,
        selectedModel: options.selectedModel ?? 'claude-sonnet-4-5',
        title: 'New Session',
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        lastActivityAt: Date.now(),
      };
      records.set(id, conv);
      return conv;
    },
    sessionRuntimes,
  } as unknown as FeatureHost;

  const refreshModelControls = jest.fn();
  const commitSelection = jest.fn().mockImplementation(async (id, expectedModel, model, admission) => {
    const conv = records.get(id);
    if (!conv) return false;
    if (admission.isCurrent(conv)) {
      admission.commit();
      if (model) conv.selectedModel = model;
      return true;
    }
    return false;
  });

  const service = new SessionMessagingService({
    getHost: () => host,
    getActiveConversationId: () => 'sender',
    refreshModelControls,
    commitSelection,
    sessionRuntimes,
  });

  const binding = service.bindSessionTools('sender');

  return {
    host,
    service,
    binding,
    records,
    settings,
    deliveredMessages,
    refreshModelControls,
    commitSelection,
  };
}

describe('SessionMessagingService', () => {
  it('lists recent sessions first without creating runtimes, omitting archived records', async () => {
    const h = setup();
    const result = await h.binding.port.list({ limit: 50 }, signal());
    expect(result.sessions).toEqual([
      { sessionId: 'recipient', title: 'recipient', provider: 'claude', status: 'idle', active: false },
      { sessionId: 'sender', title: 'Research', provider: 'claude', status: 'idle', active: true, self: true },
    ]);
  });

  it('respects limit and indicates truncation', async () => {
    const h = setup();
    const result = await h.binding.port.list({ limit: 1 }, signal());
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].sessionId).toBe('recipient');
    expect(result.truncated).toBe(true);
  });

  it('lists enabled providers with available models when includeProviders is true', async () => {
    const h = setup();
    const result = await h.binding.port.list({ includeProviders: true, limit: 10 }, signal());
    expect(result.providers).toBeDefined();
    expect(result.providers?.length).toBeGreaterThan(0);
    const claudeProv = result.providers?.find((p: any) => p.provider === 'claude');
    expect(claudeProv).toBeDefined();
    expect(claudeProv?.default).toBe(true);
  });

  it('reads stored transcripts by id', async () => {
    const h = setup();
    const time = testDate().getTime();
    h.records.get('archived')!.messages = [
      { id: 'u1', role: 'user', content: 'What is 1+1?', timestamp: time },
      { id: 'a1', role: 'assistant', content: '2', timestamp: time + 1000 },
    ];
    const result = await h.binding.port.read({ sessionId: 'archived' }, signal());
    expect(result.sessionId).toBe('archived');
    expect(result.title).toBe('archived');
    expect(result.totalTurns).toBe(1);
    expect(result.content).toContain('What is 1+1?');
    expect(result.content).toContain('2');
  });

  it('throws error when reading non-existent session', async () => {
    const h = setup();
    await expect(h.binding.port.read({ sessionId: 'unknown' }, signal())).rejects.toThrow(
      'The session does not exist',
    );
  });

  it('rejects sending a message to self', async () => {
    const h = setup();
    await expect(
      h.binding.port.send({ sessionId: 'sender', text: 'hello self' }, signal()),
    ).rejects.toThrow('A session cannot send a message to itself');
  });

  it('delivers message to an existing session', async () => {
    const h = setup();
    const result = await h.binding.port.send({ sessionId: 'recipient', text: 'Hello recipient' }, signal());
    expect(result.sessionId).toBe('recipient');
    expect(result.title).toBe('recipient');
    expect(result.provider).toBe('claude');
    expect(['started', 'queued']).toContain(result.status);
    expect(h.deliveredMessages).toHaveLength(1);
    expect(h.deliveredMessages[0].text).toBe('Hello recipient');
  });

  it('creates new conversation when sessionId is omitted', async () => {
    const h = setup();
    const result = await h.binding.port.send({ text: 'Hello new session' }, signal());
    expect(result.sessionId).toContain('conv-created-');
    expect(result.title).toBe('New Session');
    expect(result.provider).toBe('claude');
    expect(['started', 'queued']).toContain(result.status);
    expect(h.deliveredMessages).toHaveLength(1);
    expect(h.deliveredMessages[0].text).toBe('Hello new session');
  });

  it('validates unknown model on send', async () => {
    const h = setup();
    await expect(
      h.binding.port.send({ sessionId: 'recipient', model: 'non-existent-model', text: 'hi' }, signal()),
    ).rejects.toThrow('Unknown model');
  });
});
