import '@/providers';

import { OpencodeHttpClient, type OpencodeHttpEvent } from '@/providers/opencode/http/OpencodeHttpClient';
import { OpencodeAuxQueryRunner } from '@/providers/opencode/runtime/OpencodeAuxQueryRunner';
import { prepareOpencodeLaunchArtifacts } from '@/providers/opencode/runtime/OpencodeLaunchArtifacts';

jest.mock('@/providers/opencode/http/OpencodeHttpClient', () => ({
  OpencodeHttpClient: jest.fn(),
}));

jest.mock('@/providers/opencode/runtime/OpencodeLaunchArtifacts', () => {
  const actual = jest.requireActual('@/providers/opencode/runtime/OpencodeLaunchArtifacts');
  return {
    ...actual,
    prepareOpencodeLaunchArtifacts: jest.fn(),
  };
});

const MockOpencodeHttpClient = OpencodeHttpClient as jest.MockedClass<typeof OpencodeHttpClient>;
const mockPrepareOpencodeLaunchArtifacts = prepareOpencodeLaunchArtifacts as jest.MockedFunction<typeof prepareOpencodeLaunchArtifacts>;

function createMockPlugin(settings: Record<string, unknown> = {}) {
  return {
    settings: {
      model: 'opencode:openai/gpt-5',
      providerConfigs: {
        opencode: {
          enabled: true,
          visibleModels: ['openai/gpt-5'],
        },
      },
      settingsProvider: 'opencode',
      ...settings,
    },
    manifest: { version: '0.0.0-test' },
    getResolvedProviderCliPath: jest.fn().mockReturnValue('/usr/local/bin/opencode'),
    app: {
      vault: {
        adapter: {
          basePath: '/tmp/codian-test-vault',
        },
      },
    },
  } as any;
}

function createHttpClientFixture() {
  let eventListener: ((event: OpencodeHttpEvent) => void) | null = null;
  let beforePrompt: (() => void) | null = null;
  const client = {
    dispose: jest.fn().mockResolvedValue(undefined),
    isAlive: true,
    isClosed: false,
    request: jest.fn(async (route: string, options?: {
      body?: unknown;
      method?: string;
    }) => {
      if (route === '/api/model') {
        return {
          data: [
            { id: 'gpt-4.1', providerID: 'openai', name: 'GPT-4.1', variants: [] },
            { id: 'gpt-5', providerID: 'openai', name: 'GPT-5', variants: [] },
            { id: 'gpt-5.4', providerID: 'openai', name: 'GPT-5.4', variants: [] },
          ],
        };
      }
      if (route === '/api/command') return { data: [] };
      if (route === '/api/session' && options?.method === 'POST') {
        return {
          data: {
            id: 'session-1',
            model: { id: 'gpt-4.1', providerID: 'openai' },
          },
        };
      }
      if (route.endsWith('/prompt') && options?.method === 'POST') {
        beforePrompt?.();
        const emit = eventListener;
        emit?.({ type: 'message.updated', data: {
          info: { id: 'assistant-1', role: 'assistant' },
          sessionID: 'session-1',
        } });
        emit?.({ type: 'message.part.updated', data: {
          part: { id: 'part-1', messageID: 'assistant-1', text: 'Fix title', type: 'text' },
          sessionID: 'session-1',
        } });
        emit?.({ type: 'message.part.updated', data: {
          part: { id: 'part-1', messageID: 'assistant-1', text: 'Fix title now', type: 'text' },
          sessionID: 'session-1',
        } });
        emit?.({ type: 'message.updated', data: {
          info: { id: 'assistant-1', role: 'assistant', time: { completed: Date.now() } },
          sessionID: 'session-1',
        } });
        return { data: { id: 'user-1' } };
      }
      return { data: {} };
    }),
    subscribe: jest.fn(async (onEvent: (event: OpencodeHttpEvent) => void) => {
      eventListener = onEvent;
      onEvent({ type: 'server.connected', data: {} });
    }),
  };

  return {
    client,
    emit(event: OpencodeHttpEvent) {
      eventListener?.(event);
    },
    setBeforePrompt(callback: () => void) {
      beforePrompt = callback;
    },
  };
}

describe('OpencodeAuxQueryRunner', () => {
  let fixture: ReturnType<typeof createHttpClientFixture>;

  beforeEach(() => {
    jest.clearAllMocks();
    fixture = createHttpClientFixture();
    MockOpencodeHttpClient.mockImplementation(() => fixture.client as any);
    mockPrepareOpencodeLaunchArtifacts.mockResolvedValue({
      configPath: '/tmp/codian-opencode-aux/config.json',
      configContent: '{"default_agent":"codian-aux-passive"}\n',
      databasePath: null,
      launchKey: 'launch-key',
      systemPromptPath: '/tmp/codian-opencode-aux/system.md',
    });
  });

  it('runs auxiliary queries in a dedicated V2 HTTP session and streams assistant text', async () => {
    const runner = new OpencodeAuxQueryRunner(createMockPlugin(), {
      agentProfile: 'passive',
      artifactPurpose: 'title-gen',
    });
    const onTextChunk = jest.fn();

    await expect(runner.query({
      onTextChunk,
      systemPrompt: 'Use this custom system prompt.',
    }, 'Generate a title')).resolves.toBe('Fix title now');

    expect(mockPrepareOpencodeLaunchArtifacts).toHaveBeenCalledWith(expect.objectContaining({
      artifactsSubdir: 'opencode/auxiliary/title-gen',
      defaultAgentId: 'codian-aux-passive',
      managedAgents: [expect.objectContaining({
        id: 'codian-aux-passive',
        definition: expect.objectContaining({
          mode: 'primary',
          permission: { '*': 'deny', external_directory: 'deny' },
        }),
      })],
      systemPromptKey: 'Use this custom system prompt.',
      systemPromptText: 'Use this custom system prompt.',
    }));
    expect(MockOpencodeHttpClient).toHaveBeenCalledWith(
      '/usr/local/bin/opencode',
      '/tmp/codian-test-vault',
      expect.objectContaining({ OPENCODE_CONFIG_CONTENT: expect.any(String) }),
    );
    expect(fixture.client.request).toHaveBeenCalledWith('/api/session', expect.objectContaining({
      method: 'POST',
      body: { location: { directory: '/tmp/codian-test-vault' } },
    }));
    expect(fixture.client.request).toHaveBeenCalledWith('/api/session/session-1/agent', expect.objectContaining({
      method: 'POST',
      body: { agent: 'codian-aux-passive' },
    }));
    expect(fixture.client.request).toHaveBeenCalledWith('/api/session/session-1/model', expect.objectContaining({
      method: 'POST',
      body: { model: { id: 'gpt-5', providerID: 'openai' } },
    }));
    expect(fixture.client.request).toHaveBeenCalledWith('/api/session/session-1/prompt', expect.objectContaining({
      method: 'POST',
      body: expect.objectContaining({
        id: expect.stringMatching(/^msg_/),
        prompt: { text: 'Generate a title' },
      }),
    }));
    expect(onTextChunk).toHaveBeenNthCalledWith(1, 'Fix title');
    expect(onTextChunk).toHaveBeenNthCalledWith(2, 'Fix title now');
  });

  it('uses opencode from PATH when no CLI path is configured', async () => {
    const plugin = createMockPlugin();
    plugin.getResolvedProviderCliPath.mockReturnValue(null);
    const runner = new OpencodeAuxQueryRunner(plugin, {
      agentProfile: 'passive',
      artifactPurpose: 'title-gen',
    });

    await expect(runner.query({
      systemPrompt: 'Use this custom system prompt.',
    }, 'Generate a title')).resolves.toBe('Fix title now');

    expect(MockOpencodeHttpClient).toHaveBeenCalledWith(
      'opencode',
      '/tmp/codian-test-vault',
      expect.any(Object),
    );
  });

  it('restarts its isolated V2 server when the client closes', async () => {
    const runner = new OpencodeAuxQueryRunner(createMockPlugin(), {
      agentProfile: 'passive',
      artifactPurpose: 'title-gen',
    });

    await runner.query({ systemPrompt: 'Use this custom system prompt.' }, 'Generate a title');
    fixture.client.isAlive = false;
    await runner.query({ systemPrompt: 'Use this custom system prompt.' }, 'Generate another title');

    expect(fixture.client.dispose).toHaveBeenCalledTimes(1);
    expect(MockOpencodeHttpClient).toHaveBeenCalledTimes(2);
    expect(fixture.client.request).toHaveBeenCalledWith('/api/session', expect.any(Object));
  });

  it('applies an explicit model override from the active chat tab', async () => {
    const runner = new OpencodeAuxQueryRunner(createMockPlugin({
      providerConfigs: {
        opencode: {
          enabled: true,
          visibleModels: ['openai/gpt-5.4'],
        },
      },
    }), {
      agentProfile: 'passive',
      artifactPurpose: 'title-gen',
    });

    await expect(runner.query({
      model: 'opencode:openai/gpt-5.4',
      systemPrompt: 'Use this custom system prompt.',
    }, 'Generate a title')).resolves.toBe('Fix title now');

    expect(fixture.client.request).toHaveBeenCalledWith('/api/session/session-1/model', expect.objectContaining({
      method: 'POST',
      body: { model: { id: 'gpt-5.4', providerID: 'openai' } },
    }));
  });

  it('rejects native permission requests in read-only auxiliary sessions', async () => {
    const runner = new OpencodeAuxQueryRunner(createMockPlugin(), {
      agentProfile: 'readonly',
      artifactPurpose: 'inline',
    });
    fixture.setBeforePrompt(() => fixture.emit({ type: 'permission.asked', data: {
      action: 'read', id: 'approval-1', resources: ['note.md'], sessionID: 'session-1',
    } }));

    await expect(runner.query({
      systemPrompt: 'Read only prompt.',
    }, 'Summarize this selection')).resolves.toBe('Fix title now');

    expect(fixture.client.request).toHaveBeenCalledWith(
      '/api/session/session-1/permission/approval-1/reply',
      expect.objectContaining({ method: 'POST', body: { decision: 'reject' } }),
    );
    expect(mockPrepareOpencodeLaunchArtifacts).toHaveBeenCalledWith(expect.objectContaining({
      managedAgents: [expect.objectContaining({
        definition: expect.objectContaining({
          permission: expect.objectContaining({
            external_directory: 'deny',
            read: { '*': 'allow', '*.env': 'deny', '*.env.*': 'deny', '*.env.example': 'allow' },
          }),
        }),
      })],
    }));
  });

  it('disposes the isolated V2 client when reset', async () => {
    const runner = new OpencodeAuxQueryRunner(createMockPlugin(), {
      agentProfile: 'passive',
      artifactPurpose: 'instructions',
    });

    await runner.query({ systemPrompt: 'Refine prompt.' }, 'Clarify this instruction');
    runner.reset();
    await Promise.resolve();

    expect(fixture.client.dispose).toHaveBeenCalledTimes(1);
  });
});
