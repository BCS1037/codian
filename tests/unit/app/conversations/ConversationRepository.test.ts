import '@/providers';

import { ConversationRepository } from '@/app/conversations/ConversationRepository';
import { SessionStorage } from '@/core/bootstrap/SessionStorage';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type { Conversation } from '@/core/types';

function createConversation(id = 'conversation-1'): Conversation {
  return {
    id,
    providerId: 'claude',
    title: 'Conversation',
    createdAt: 1,
    updatedAt: 1,
    sessionId: 'session-1',
    messages: [],
  };
}

function createRepository(conversation = createConversation()) {
  const sessions = {
    saveMetadata: jest.fn().mockResolvedValue(undefined),
    deleteMetadata: jest.fn().mockResolvedValue(undefined),
    toSessionMetadata: jest.fn((value) => value),
  };
  const repository = new ConversationRepository({
    getSettings: () => ({}),
    getVaultPath: () => '/vault',
    sessions: sessions as any,
    onConversationDeleted: jest.fn().mockResolvedValue(undefined),
  });
  repository.replaceAll([conversation]);
  return { repository, sessions };
}

describe('ConversationRepository hydration', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns cached metadata without hydrating provider history', () => {
    const hydrateConversationHistory = jest.fn();
    jest.spyOn(ProviderRegistry, 'getConversationHistoryService').mockReturnValue({
      hydrateConversationHistory,
    } as any);
    const conversation = createConversation();
    const { repository } = createRepository(conversation);

    expect(repository.getCachedConversation(conversation.id)).toBe(conversation);
    expect(hydrateConversationHistory).not.toHaveBeenCalled();
  });

  it('preserves provider subagent state when renaming an unloaded conversation', async () => {
    const conversation = createConversation();
    conversation.providerState = {
      subagentData: {
        'task-1': {
          id: 'task-1',
          description: 'Existing child task',
          isExpanded: false,
          status: 'completed',
          result: 'Child output',
          toolCalls: [],
        },
      },
      nativeLocator: { path: '/vault/.claude/projects/session.jsonl', offset: 128 },
    };
    const { repository, sessions } = createRepository(conversation);
    const storage = new SessionStorage({} as any);
    sessions.toSessionMetadata.mockImplementation((value) => storage.toSessionMetadata(value));

    await repository.rename(conversation.id, 'Renamed conversation');

    const saved = sessions.saveMetadata.mock.calls[0][0];
    expect(saved.title).toBe('Renamed conversation');
    expect(saved.providerState?.subagentData).toEqual(conversation.providerState.subagentData);
    expect(saved.providerState?.nativeLocator).toEqual({
      path: '/vault/.claude/projects/session.jsonl',
      offset: 128,
    });
  });

  it('rolls back rename and update mutations when metadata persistence fails', async () => {
    const conversation = createConversation();
    const { repository, sessions } = createRepository(conversation);
    sessions.toSessionMetadata.mockImplementation(value => structuredClone(value));
    sessions.saveMetadata.mockRejectedValueOnce(new Error('rename write failed'));

    await expect(repository.rename(conversation.id, 'Unsaved title')).rejects.toThrow('rename write failed');
    expect(conversation.title).toBe('Conversation');

    sessions.saveMetadata.mockRejectedValueOnce(new Error('update write failed'));
    await expect(repository.update(conversation.id, { sessionId: 'session-unsaved' }))
      .rejects.toThrow('update write failed');
    expect(conversation.sessionId).toBe('session-1');
  });

  it('serializes opposite-order metadata writes so last operation remains on disk', async () => {
    const conversation = createConversation();
    const { repository, sessions } = createRepository(conversation);
    sessions.toSessionMetadata.mockImplementation(value => structuredClone(value));
    const pending: Array<{ metadata: Conversation; resolve: () => void }> = [];
    let persisted: Conversation | undefined;
    sessions.saveMetadata.mockImplementation((metadata: Conversation) => new Promise<void>((resolve) => {
      pending.push({
        metadata,
        resolve: () => {
          persisted = structuredClone(metadata);
          resolve();
        },
      });
    }));

    const first = repository.rename(conversation.id, 'First');
    await Promise.resolve();
    const second = repository.rename(conversation.id, 'Second');
    await Promise.resolve();

    if (pending.length === 2) {
      pending[1].resolve();
      pending[0].resolve();
    } else {
      pending[0].resolve();
      await first;
      await Promise.resolve();
      pending[1].resolve();
    }
    await Promise.all([first, second]);

    expect(conversation.title).toBe('Second');
    expect(persisted?.title).toBe('Second');
  });

  it('waits for pending metadata writes before deleting the session record', async () => {
    const conversation = createConversation();
    const { repository, sessions } = createRepository(conversation);
    sessions.toSessionMetadata.mockImplementation(value => structuredClone(value));
    let releaseWrite!: () => void;
    let markWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => { markWriteStarted = resolve; });
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const events: string[] = [];
    sessions.saveMetadata.mockImplementation(async () => {
      events.push('save-start');
      markWriteStarted();
      await writeGate;
      events.push('save-end');
    });
    sessions.deleteMetadata.mockImplementation(async () => { events.push('delete'); });

    const rename = repository.rename(conversation.id, 'Delete after save');
    await writeStarted;
    const deletion = repository.delete(conversation.id, { deleteProviderSession: false });

    expect(sessions.deleteMetadata).not.toHaveBeenCalled();
    releaseWrite();
    await Promise.all([rename, deletion]);

    expect(events).toEqual(['save-start', 'save-end', 'delete']);
    expect(repository.getCachedConversation(conversation.id)).toBeNull();
  });

  it('deduplicates concurrent hydration and does not reread an empty transcript', async () => {
    let release!: () => void;
    const hydrateConversationHistory = jest.fn(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    jest.spyOn(ProviderRegistry, 'getConversationHistoryService').mockReturnValue({
      hydrateConversationHistory,
    } as any);
    const conversation = createConversation();
    const { repository } = createRepository(conversation);

    const first = repository.ensureHydrated(conversation.id);
    const second = repository.ensureHydrated(conversation.id);
    await Promise.resolve();
    await Promise.resolve();
    expect(hydrateConversationHistory).toHaveBeenCalledTimes(1);

    release();
    await expect(Promise.all([first, second])).resolves.toEqual([conversation, conversation]);
    await repository.ensureHydrated(conversation.id);

    expect(hydrateConversationHistory).toHaveBeenCalledTimes(1);
  });

  it('allows hydration to retry after a provider history failure', async () => {
    const hydrateConversationHistory = jest.fn()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce(undefined);
    jest.spyOn(ProviderRegistry, 'getConversationHistoryService').mockReturnValue({
      hydrateConversationHistory,
    } as any);
    const conversation = createConversation();
    const { repository } = createRepository(conversation);

    await expect(repository.ensureHydrated(conversation.id)).rejects.toThrow('temporary failure');
    await expect(repository.ensureHydrated(conversation.id)).resolves.toBe(conversation);

    expect(hydrateConversationHistory).toHaveBeenCalledTimes(2);
  });

  it('does not return a conversation deleted while hydration is in flight', async () => {
    let releaseHydration!: () => void;
    const hydrateConversationHistory = jest.fn(async () => {
      await new Promise<void>((resolve) => {
        releaseHydration = resolve;
      });
    });
    jest.spyOn(ProviderRegistry, 'getConversationHistoryService').mockReturnValue({
      hydrateConversationHistory,
    } as any);
    const conversation = createConversation();
    const { repository, sessions } = createRepository(conversation);

    const hydration = repository.ensureHydrated(conversation.id);
    await Promise.resolve();
    await Promise.resolve();
    const deletion = repository.delete(conversation.id, { deleteProviderSession: false });

    releaseHydration();

    await expect(hydration).resolves.toBeNull();
    await expect(deletion).resolves.toBeUndefined();
    expect(repository.getCachedConversation(conversation.id)).toBeNull();
    expect(sessions.deleteMetadata).toHaveBeenCalledWith(conversation.id);
  });

  it('does not return an already hydrated conversation deleted while model reconciliation is in flight', async () => {
    let markReconciliationStarted!: () => void;
    let releaseReconciliation!: () => void;
    const reconciliationStarted = new Promise<void>((resolve) => {
      markReconciliationStarted = resolve;
    });
    const reconciliationRelease = new Promise<void>((resolve) => {
      releaseReconciliation = resolve;
    });
    const conversation = createConversation();
    conversation.messages = [{ id: 'message-1', role: 'user', content: 'kept', timestamp: 1 }];
    const { repository, sessions } = createRepository(conversation);
    jest.spyOn(repository as any, 'ensureSelectedModel').mockImplementation(async () => {
      markReconciliationStarted();
      await reconciliationRelease;
    });

    const hydration = repository.ensureHydrated(conversation.id);
    await reconciliationStarted;
    const deletion = repository.delete(conversation.id, { deleteProviderSession: false });
    releaseReconciliation();

    await expect(hydration).resolves.toBeNull();
    await expect(deletion).resolves.toBeUndefined();
    expect(repository.getCachedConversation(conversation.id)).toBeNull();
    expect(sessions.deleteMetadata).toHaveBeenCalledWith(conversation.id);
  });

  it('restarts hydration when provider session identity changes in flight', async () => {
    let markFirstHydrationStarted!: () => void;
    let releaseFirstHydration!: () => void;
    const firstHydrationStarted = new Promise<void>((resolve) => {
      markFirstHydrationStarted = resolve;
    });
    const firstHydrationRelease = new Promise<void>((resolve) => {
      releaseFirstHydration = resolve;
    });
    const hydrateConversationHistory = jest.fn()
      .mockImplementationOnce(async () => {
        markFirstHydrationStarted();
        await firstHydrationRelease;
      })
      .mockResolvedValueOnce(undefined);
    jest.spyOn(ProviderRegistry, 'getConversationHistoryService').mockReturnValue({
      hydrateConversationHistory,
    } as any);
    const conversation = createConversation();
    const { repository } = createRepository(conversation);

    const staleHydration = repository.ensureHydrated(conversation.id);
    await firstHydrationStarted;
    await repository.update(conversation.id, { sessionId: 'session-2' });
    releaseFirstHydration();

    await expect(staleHydration).resolves.toBeNull();
    await expect(repository.ensureHydrated(conversation.id)).resolves.toBe(conversation);
    expect(hydrateConversationHistory).toHaveBeenCalledTimes(2);
  });

  it('merges background metadata without replacing an already hydrated conversation', () => {
    const existing = createConversation('existing');
    existing.messages = [{ id: 'message-1', role: 'user', content: 'kept', timestamp: 1 }];
    const { repository } = createRepository(existing);
    const duplicate = createConversation('existing');
    const added = createConversation('added');
    added.updatedAt = 2;

    const merged = repository.mergeMetadataConversations([duplicate, added]);

    expect(merged).toEqual([added]);
    expect(repository.getCachedConversation('existing')).toBe(existing);
    expect(repository.getCachedConversation('existing')?.messages).toHaveLength(1);
    expect(repository.getAll().map(conversation => conversation.id)).toEqual(['added', 'existing']);
  });

  it('does not resurrect a deleted conversation from a late background metadata batch', async () => {
    const conversation = createConversation('deleted');
    const { repository } = createRepository(conversation);
    await repository.delete(conversation.id, { deleteProviderSession: false });

    const merged = repository.mergeMetadataConversations([
      createConversation(conversation.id),
    ]);

    expect(merged).toEqual([]);
    expect(repository.getCachedConversation(conversation.id)).toBeNull();
  });

  it('keeps pinned conversations first in the session index', () => {
    const regular = createConversation('regular');
    regular.updatedAt = 300;
    const pinned = createConversation('pinned');
    pinned.updatedAt = 100;
    pinned.pinned = true;
    const { repository } = createRepository(regular);

    repository.replaceAll([regular, pinned]);

    expect(repository.list().map(conversation => conversation.id)).toEqual([
      'pinned',
      'regular',
    ]);
  });
});
