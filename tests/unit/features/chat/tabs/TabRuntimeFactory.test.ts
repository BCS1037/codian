import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { TabRuntimeFactory } from '@/features/chat/tabs/TabRuntimeFactory';

function createRuntime() {
  return {
    providerId: 'claude',
    onReadyStateChange: jest.fn().mockReturnValue(jest.fn()),
    syncConversationState: jest.fn(),
    cleanup: jest.fn(),
  };
}

function createPlugin(): any {
  return {
    providerHost: {},
    settings: {
      persistentExternalContextPaths: ['/persistent/context'],
    },
  };
}

describe('TabRuntimeFactory', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('prepares runtime and synchronizes blank-tab state', () => {
    const runtime = createRuntime();
    const createRuntimeSpy = jest
      .spyOn(ProviderRegistry, 'createChatRuntime')
      .mockReturnValue(runtime as any);
    const plugin = createPlugin();

    const lease = TabRuntimeFactory.prepare({
      plugin,
      providerId: 'claude',
      conversation: null,
      selectedModel: 'claude-sonnet',
    });

    expect(createRuntimeSpy).toHaveBeenCalledWith({ plugin: plugin.providerHost, providerId: 'claude' });
    expect(runtime.syncConversationState).toHaveBeenCalledWith(
      { sessionId: null, selectedModel: 'claude-sonnet' },
      ['/persistent/context'],
    );
    expect(runtime.cleanup).not.toHaveBeenCalled();

    lease.cleanup();
    lease.cleanup();
    expect(runtime.cleanup).toHaveBeenCalledTimes(1);
    expect(runtime.onReadyStateChange.mock.results[0].value).toHaveBeenCalledTimes(1);
  });

  it('uses conversation context only when conversation already has messages', () => {
    const runtime = createRuntime();
    jest.spyOn(ProviderRegistry, 'createChatRuntime').mockReturnValue(runtime as any);
    const conversation = {
      id: 'conversation-1',
      messages: [{ id: 'message-1' }],
      externalContextPaths: ['/conversation/context'],
    };

    const lease = TabRuntimeFactory.prepare({
      plugin: createPlugin(),
      providerId: 'claude',
      conversation: conversation as any,
      selectedModel: 'ignored-model',
    });

    expect(runtime.syncConversationState).toHaveBeenCalledWith(
      conversation,
      ['/conversation/context'],
    );
    lease.cleanup();
  });

  it('rolls back listener and runtime when synchronization fails', () => {
    const runtime = createRuntime();
    runtime.syncConversationState.mockImplementation(() => {
      throw new Error('sync failed');
    });
    jest.spyOn(ProviderRegistry, 'createChatRuntime').mockReturnValue(runtime as any);

    expect(() => TabRuntimeFactory.prepare({
      plugin: createPlugin(),
      providerId: 'claude',
      conversation: null,
      selectedModel: null,
    })).toThrow('sync failed');

    expect(runtime.cleanup).toHaveBeenCalledTimes(1);
    expect(runtime.onReadyStateChange.mock.results[0]?.value).toHaveBeenCalledTimes(1);
  });
});
